// gmail-drafts — the Gmail DRAFT lifecycle over plain REST, runtime-neutral.
//
// One source for two runtimes (a Cloudflare Worker and a Bun MCP server):
// only fetch-era globals are used (TextEncoder/TextDecoder, btoa/atob), and
// every Gmail call goes through an injected `api(path, opts)`.
//
// Draft-only BY CONSTRUCTION: no function here builds a URL containing
// "send"; the test walks the whole lifecycle and asserts that. Keep it so.

// ── MIME ───────────────────────────────────────────────────────────────────

// RFC 2822 text/plain message → base64url (RFC 4648 §5, no padding), the
// `raw` Gmail wants. Headers with an empty value are dropped entirely (an
// empty `From:` would override the account's send-as). UTF-8 is encoded
// before base64 — btoa on a raw JS string mangles non-ASCII.
export function gmailRawMime(headers, bodyText) {
  const lines = [];
  for (const [k, v] of headers) if (v) lines.push(`${k}: ${v}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"', "MIME-Version: 1.0", "", bodyText);
  const bytes = new TextEncoder().encode(lines.join("\r\n"));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Message helpers ────────────────────────────────────────────────────────

export const mailHeader = (msg, name) =>
  ((msg?.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";

const MAIL_ENTITIES = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'",
  szlig: "ß", auml: "ä", ouml: "ö", uuml: "ü", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
  euro: "€", pound: "£", copy: "©", reg: "®", trade: "™", deg: "°", sect: "§", middot: "·", bull: "•",
  mdash: "—", ndash: "–", rsquo: "'", lsquo: "'", rdquo: "”", ldquo: "“", hellip: "…", laquo: "«", raquo: "»",
};

export function mailPartText(payload, want) {
  if (!payload) return "";
  if (payload.mimeType === want && payload.body?.data) {
    try {
      const bin = atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }
  for (const p of payload.parts || []) {
    const t = mailPartText(p, want);
    if (t) return t;
  }
  return "";
}

export function mailHtmlToText(html) {
  const s = html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return " "; } })
    .replace(/&([a-z]+[0-9]*);/gi, (m, k) => MAIL_ENTITIES[k.toLowerCase()] ?? m)
    .replace(/&amp;/gi, "&");
  return s.replace(/[ \t​‌͏]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Plain text of a message: the text/plain part, else text/html stripped.
export function mailBodyText(payload) {
  const plain = mailPartText(payload, "text/plain");
  if (plain) return plain;
  const html = mailPartText(payload, "text/html");
  return html ? mailHtmlToText(html) : "";
}

// ── REST adapter ───────────────────────────────────────────────────────────

// Builds an `api(path, opts)` for one account from a token getter. Reads the
// response as text and parses only if non-empty: DELETE drafts/{id} answers
// 204 with an empty body, and a blind resp.json() throws on that success.
export function gmailRestApi(getToken, { fetch: fetchImpl = globalThis.fetch, base = "https://gmail.googleapis.com/gmail/v1/users/me/" } = {}) {
  return async function api(path, opts = {}) {
    const token = await getToken();
    const resp = await fetchImpl(base + path, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (!resp.ok) throw new Error(`gmail ${path.split("?")[0]} ${resp.status}: ${String(await resp.text()).slice(0, 150)}`);
    const txt = await resp.text();
    return txt ? JSON.parse(txt) : {};
  };
}

// ── Draft ops ──────────────────────────────────────────────────────────────

// `api(path, opts)` — an authenticated Gmail REST call for ONE account, path
// relative to users/me/, returning parsed JSON ({} for an empty body).
export function createDraftOps(api) {
  const enc = encodeURIComponent;

  // Reply DRAFT on a thread. To targets the last message from the OTHER side
  // — naively replying to the thread's last message addresses the draft to
  // yourself whenever you spoke last. Threading headers chain to the thread's
  // latest message, and From adopts the send-as identity already used on the
  // thread, so alias-run threads keep their alias.
  async function reply(threadId, bodyText) {
    const t = await api(`threads/${enc(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID`);
    const msgs = t.messages || [];
    if (!msgs.length) throw new Error("empty thread");
    const sent = (m) => (m.labelIds || []).includes("SENT");
    const counter = [...msgs].reverse().find((m) => !sent(m)) || msgs[msgs.length - 1];
    const lastSent = [...msgs].reverse().find(sent);
    const last = msgs[msgs.length - 1];
    const to = mailHeader(counter, "Reply-To") || mailHeader(counter, "From");
    let subject = mailHeader(last, "Subject") || mailHeader(counter, "Subject") || "";
    if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;
    const msgId = mailHeader(last, "Message-ID");
    const from = lastSent ? mailHeader(lastSent, "From") : "";
    const raw = gmailRawMime([
      ["From", from], ["To", to], ["Subject", subject],
      ["In-Reply-To", msgId], ["References", msgId],
    ], bodyText);
    // threadId is required or the draft is orphaned off-thread.
    const d = await api("drafts", { method: "POST", body: JSON.stringify({ message: { threadId, raw } }) });
    return { draftId: d.id, to, subject, ...(from ? { from } : {}) };
  }

  async function compose(to, subject, bodyText) {
    const raw = gmailRawMime([["To", to], ["Subject", subject]], bodyText);
    const d = await api("drafts", { method: "POST", body: JSON.stringify({ message: { raw } }) });
    return { draftId: d.id, to, subject };
  }

  // Bare ids from the list call, hydrated (capped) with metadata; a failed
  // hydrate still emits the bare id.
  async function list() {
    const l = await api("drafts?maxResults=15");
    const out = [];
    for (const d of (l.drafts || []).slice(0, 10)) {
      try {
        const full = await api(`drafts/${enc(d.id)}?format=metadata`);
        const m = full.message || {};
        out.push({ draft_id: d.id, thread_id: m.threadId || null, to: mailHeader(m, "To"), subject: mailHeader(m, "Subject") });
      } catch {
        out.push({ draft_id: d.id });
      }
    }
    return { drafts: out, total: (l.drafts || []).length };
  }

  async function get(draftId) {
    const d = await api(`drafts/${enc(draftId)}?format=full`);
    const m = d.message || {};
    return { draft_id: d.id, thread_id: m.threadId || null, from: mailHeader(m, "From"),
      to: mailHeader(m, "To"), subject: mailHeader(m, "Subject"),
      body: mailBodyText(m.payload).slice(0, 4000) };
  }

  // Replace a draft's body (and optionally To/Subject) while keeping its
  // thread and headers — a naive PUT without threadId silently detaches the
  // draft from its conversation.
  async function update(draftId, bodyText, to, subject) {
    const cur = await api(`drafts/${enc(draftId)}?format=metadata`);
    const m = cur.message || {};
    const raw = gmailRawMime([
      ["From", mailHeader(m, "From")],
      ["To", to || mailHeader(m, "To")],
      ["Subject", subject || mailHeader(m, "Subject")],
      ["In-Reply-To", mailHeader(m, "In-Reply-To")],
      ["References", mailHeader(m, "References")],
    ], bodyText);
    const d = await api(`drafts/${enc(draftId)}`, {
      method: "PUT",
      body: JSON.stringify({ message: { ...(m.threadId ? { threadId: m.threadId } : {}), raw } }),
    });
    return { draftId: d.id || draftId, threadId: (d.message || {}).threadId || m.threadId || null };
  }

  async function remove(draftId) {
    await api(`drafts/${enc(draftId)}`, { method: "DELETE" });
  }

  return { reply, compose, list, get, update, delete: remove };
}
