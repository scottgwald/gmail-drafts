// gmail-drafts — the Gmail DRAFT lifecycle over plain REST, runtime-neutral.
//
// One source for two runtimes (a Cloudflare Worker and a Bun MCP server):
// only fetch-era globals are used (TextEncoder/TextDecoder, btoa/atob), and
// every Gmail call goes through an injected `api(path, opts)`.
//
// Draft-only BY CONSTRUCTION: no function here builds a URL containing
// "send"; the test walks the whole lifecycle and asserts that. Keep it so.

// ── MIME ───────────────────────────────────────────────────────────────────

const bytesToB64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64url = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s) => {
  const b = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const boundary = (tag) => `${tag}-${(globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
  ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 16)}`;

// Quoted-printable (RFC 2045 §6.7) over UTF-8: "=", non-printables and a
// line's trailing blank are =XX; encoded lines stay under 76 characters by
// soft breaks ("=" + CRLF), which a decoder removes — the text's own line
// breaks are the only hard ones. A 10 000-character paragraph decodes back
// to one line.
export function quotedPrintable(text) {
  const bytes = new TextEncoder().encode(String(text).replace(/\r\n?/g, "\n"));
  const hex = (b) => "=" + b.toString(16).toUpperCase().padStart(2, "0");
  const out = [];
  let line = "";
  const push = (tok) => {
    if (line.length + tok.length > 73) {
      if (/[ \t]$/.test(line)) line = line.slice(0, -1) + hex(line.charCodeAt(line.length - 1));
      out.push(line + "=");
      line = "";
    }
    line += tok;
  };
  const endLine = () => {
    if (/[ \t]$/.test(line)) line = line.slice(0, -1) + hex(line.charCodeAt(line.length - 1));
    out.push(line);
    line = "";
  };
  for (const b of bytes) {
    if (b === 0x0a) { endLine(); continue; }
    if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) push(String.fromCharCode(b));
    else push(hex(b));
  }
  endLine();
  return out.join("\r\n");
}

// The text/plain part's text under format=flowed (RFC 3676): trailing
// blanks go (a trailing blank would read as a soft break), a line that
// starts with a blank or "From " is space-stuffed; a line starting with ">"
// is a quote, which is what it means.
export function flowedText(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .map((l) => (/^( |From )/.test(l) ? " " + l : l))
    .join("\n");
}

// The smallest honest html of a plain-text body: paragraphs (blank-line
// separated) → <p>, single newlines → <br>, URLs → <a>, "> " quote lines →
// <blockquote>; nothing else, no CSS. Escaped first.
export function htmlOfText(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const link = (s) => s.replace(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g, (m) => `<a href="${m}">${m}</a>`);
  return String(text).replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).map((p) => {
    const parts = [];
    let quote = null;
    for (const l of p.split("\n")) {
      const q = l.match(/^>\s?(.*)$/);
      if (q) { (quote || (quote = [])).push(link(esc(q[1]))); continue; }
      if (quote) { parts.push(`<blockquote>${quote.join("<br>")}</blockquote>`); quote = null; }
      parts.push(link(esc(l)));
    }
    if (quote) parts.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
    return "<p>" + parts.map((x, i) => (i && !x.startsWith("<blockquote>") && !parts[i - 1].startsWith("<blockquote>") ? "<br>" : "") + x).join("") + "</p>";
  }).join("\n");
}

// RFC 2822 message → base64url (RFC 4648 §5, no padding), the `raw` Gmail
// wants. Headers with an empty value are dropped entirely (an empty `From:`
// would override the account's send-as). The body goes as
// multipart/alternative — text/plain (format=flowed, quoted-printable) plus
// the html of htmlOfText — so Gmail's web view wraps it like any mail
// instead of showing a text/plain-only draft at a fixed width (D3,
// 2026-11-04); with opts.attachments ([{name, mime, bytes}]) the
// alternative sits inside a multipart/mixed with the files. UTF-8 is
// encoded before base64 — btoa on a raw JS string mangles non-ASCII.
export function gmailRawMime(headers, bodyText, opts = {}) {
  const lines = [];
  for (const [k, v] of headers) if (v) lines.push(`${k}: ${v}`);
  lines.push("MIME-Version: 1.0");
  const alt = boundary("alt");
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"; format=flowed; delsp=yes', "Content-Transfer-Encoding: quoted-printable", "",
    quotedPrintable(flowedText(bodyText)),
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: quoted-printable", "",
    quotedPrintable(htmlOfText(bodyText)),
    `--${alt}--`,
  ];
  const files = Array.isArray(opts.attachments) ? opts.attachments : [];
  if (!files.length) {
    lines.push(...altPart);
  } else {
    const mixed = boundary("mixed");
    lines.push(`Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`, ...altPart);
    for (const f of files) {
      lines.push(`--${mixed}`, `Content-Type: ${f.mime || "application/octet-stream"}; name="${f.name}"`,
        `Content-Disposition: attachment; filename="${f.name}"`, "Content-Transfer-Encoding: base64", "", bytesToB64(f.bytes));
    }
    lines.push(`--${mixed}--`);
  }
  lines.push("");
  return b64url(bytesToB64(new TextEncoder().encode(lines.join("\r\n"))));
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
      return new TextDecoder().decode(b64urlToBytes(payload.body.data));
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

// The real attachments of a message: parts with a file name and an
// attachment id, inline ones (a Content-ID, an inline disposition) left out.
export function mailAttachments(payload) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    const hdr = (n) => ((p.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase()) || {}).value || "";
    if (p.filename && p.body && p.body.attachmentId) {
      const inline = /^inline/i.test(hdr("Content-Disposition")) || !!hdr("Content-ID");
      if (!inline) out.push({ id: p.body.attachmentId, name: p.filename, mime: p.mimeType || "application/octet-stream", size: p.body.size || 0 });
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return out;
}

// The draft's own fields beyond from/to/subject (D4 c, 2026-11-04).
const draftFields = (m) => ({
  cc: mailHeader(m, "Cc"), bcc: mailHeader(m, "Bcc"), reply_to: mailHeader(m, "Reply-To"),
  date: mailHeader(m, "Date"), in_reply_to: mailHeader(m, "In-Reply-To"),
  attachments: mailAttachments(m.payload),
});

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

  // The bytes of a message's attachments, as files for gmailRawMime — what
  // an update or an attach keeps on the rebuilt draft (D4 d).
  async function attachmentFiles(m) {
    const files = [];
    for (const a of mailAttachments(m.payload)) {
      const got = await api(`messages/${enc(m.id)}/attachments/${enc(a.id)}`);
      files.push({ name: a.name, mime: a.mime, bytes: b64urlToBytes(got.data || "") });
    }
    return files;
  }

  // The answered message quoted below the body, the way Gmail's own reply
  // does it: "On <date>, <name> wrote:" and "> " lines (D4 b).
  async function quoteOf(msg) {
    let full;
    try {
      full = await api(`messages/${enc(msg.id)}?format=full`);
    } catch {
      return "";
    }
    const text = mailBodyText(full.payload).trim();
    if (!text) return "";
    const date = mailHeader(full, "Date") || mailHeader(msg, "Date");
    const who = mailHeader(full, "From") || mailHeader(msg, "From");
    return `On ${date ? date + ", " : ""}${who} wrote:\n` + text.split("\n").map((l) => "> " + l).join("\n");
  }

  // Reply DRAFT on a thread. To targets the last message from the OTHER side
  // — naively replying to the thread's last message addresses the draft to
  // yourself whenever you spoke last. Threading headers chain to the thread's
  // latest message, and From adopts the send-as identity already used on the
  // thread, so alias-run threads keep their alias. opts: cc, bcc (D4 a);
  // quote (default true): the answered message below the body (D4 b) — the
  // caller's cap applies to bodyText alone.
  async function reply(threadId, bodyText, opts = {}) {
    const t = await api(`threads/${enc(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Date`);
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
    const quote = opts.quote === false ? "" : await quoteOf(counter);
    const raw = gmailRawMime([
      ["From", from], ["To", to], ["Cc", opts.cc || ""], ["Bcc", opts.bcc || ""], ["Subject", subject],
      ["In-Reply-To", msgId], ["References", msgId],
    ], quote ? `${String(bodyText).replace(/\s+$/, "")}\n\n${quote}` : bodyText);
    // threadId is required or the draft is orphaned off-thread.
    const d = await api("drafts", { method: "POST", body: JSON.stringify({ message: { threadId, raw } }) });
    return { draftId: d.id, to, subject, ...(from ? { from } : {}), ...(opts.cc ? { cc: opts.cc } : {}), ...(opts.bcc ? { bcc: opts.bcc } : {}), quoted: !!quote };
  }

  async function compose(to, subject, bodyText, opts = {}) {
    const raw = gmailRawMime([["To", to], ["Cc", opts.cc || ""], ["Bcc", opts.bcc || ""], ["Subject", subject]], bodyText);
    const d = await api("drafts", { method: "POST", body: JSON.stringify({ message: { raw } }) });
    return { draftId: d.id, to, subject, ...(opts.cc ? { cc: opts.cc } : {}), ...(opts.bcc ? { bcc: opts.bcc } : {}) };
  }

  // Bare ids from the list call, hydrated (capped) with the draft's headers
  // and attachments; a failed hydrate still emits the bare id.
  async function list() {
    const l = await api("drafts?maxResults=15");
    const out = [];
    for (const d of (l.drafts || []).slice(0, 10)) {
      try {
        const full = await api(`drafts/${enc(d.id)}?format=full`);
        const m = full.message || {};
        out.push({ draft_id: d.id, thread_id: m.threadId || null, to: mailHeader(m, "To"), subject: mailHeader(m, "Subject"), ...draftFields(m) });
      } catch {
        out.push({ draft_id: d.id });
      }
    }
    return { drafts: out, total: (l.drafts || []).length };
  }

  async function get(draftId) {
    const d = await api(`drafts/${enc(draftId)}?format=full`);
    const m = d.message || {};
    const body = mailBodyText(m.payload);
    return { draft_id: d.id, thread_id: m.threadId || null, from: mailHeader(m, "From"),
      to: mailHeader(m, "To"), subject: mailHeader(m, "Subject"), ...draftFields(m),
      body: body.slice(0, 4000), body_truncated: body.length > 4000 };
  }

  // Replace a draft's body (and optionally To/Subject, opts.cc/opts.bcc)
  // while keeping its thread, headers — Cc, Bcc, Reply-To included — and the
  // attachments it carries (D4 d); a naive PUT without threadId silently
  // detaches the draft from its conversation.
  async function update(draftId, bodyText, to, subject, opts = {}) {
    const cur = await api(`drafts/${enc(draftId)}?format=full`);
    const m = cur.message || {};
    const raw = gmailRawMime([
      ["From", mailHeader(m, "From")],
      ["To", to || mailHeader(m, "To")],
      ["Cc", typeof opts.cc === "string" ? opts.cc : mailHeader(m, "Cc")],
      ["Bcc", typeof opts.bcc === "string" ? opts.bcc : mailHeader(m, "Bcc")],
      ["Reply-To", mailHeader(m, "Reply-To")],
      ["Subject", subject || mailHeader(m, "Subject")],
      ["In-Reply-To", mailHeader(m, "In-Reply-To")],
      ["References", mailHeader(m, "References")],
    ], bodyText, { attachments: await attachmentFiles(m) });
    const d = await api(`drafts/${enc(draftId)}`, {
      method: "PUT",
      body: JSON.stringify({ message: { ...(m.threadId ? { threadId: m.threadId } : {}), raw } }),
    });
    return { draftId: d.id || draftId, threadId: (d.message || {}).threadId || m.threadId || null };
  }

  async function remove(draftId) {
    await api(`drafts/${enc(draftId)}`, { method: "DELETE" });
  }

  return { reply, compose, list, get, update, delete: remove, attachmentFiles };
}
