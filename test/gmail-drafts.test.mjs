// Walks the whole draft lifecycle against a recording fake `api`, then the
// REST adapter against a fake fetch. Plain asserts, no framework: runs under
// `node test/gmail-drafts.test.mjs` and `bun test/gmail-drafts.test.mjs`.
import assert from "node:assert";
import { createDraftOps, gmailRestApi, gmailRawMime, mailBodyText, quotedPrintable, htmlOfText, flowedText, mailAttachments } from "../gmail-drafts.js";

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const b64u = (s) => Buffer.from(s).toString("base64url");
const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
// the quoted-printable text back, and the two parts of the alternative
const qpDecode = (s) => Buffer.from(s.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "binary").toString("utf8").replace(/\r\n/g, "\n");
const partsOf = (mime) => {
  const b = mime.match(/multipart\/alternative; boundary="([^"]+)"/)[1];
  const chunks = mime.split(`--${b}`).slice(1, -1).map((c) => c.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""));
  return { text: qpDecode(chunks[0]), html: qpDecode(chunks[1]) };
};

const calls = [];
const api = async (path, opts = {}) => {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ path, method, body });
  if (path.startsWith("threads/th3")) {
    return { messages: [
      { id: "m1", labelIds: ["INBOX"], payload: { headers: hdrs({ From: "Counter Party <cp@x.de>", Subject: "Hello", "Message-ID": "<mid1@x>", Date: "Mon, 2 Nov 2026 10:00:00 +0100" }) } },
      { id: "m2", labelIds: ["SENT"], payload: { headers: hdrs({ From: "Scott Greenwald <scottgwald@gmail.com>", Subject: "Re: Hello", "Message-ID": "<mid9@x>" }) } },
    ] };
  }
  if (path === "messages/m1?format=full") {
    return { id: "m1", payload: { mimeType: "text/plain", body: { data: b64u("Original line one\nline two") },
      headers: hdrs({ From: "Counter Party <cp@x.de>", Date: "Mon, 2 Nov 2026 10:00:00 +0100" }) } };
  }
  if (path === "drafts" && method === "POST") return { id: "drX", message: { id: "mX", threadId: body.message.threadId || "tNew" } };
  if (path === "drafts?maxResults=15") return { drafts: [{ id: "drX" }, { id: "drBroken" }] };
  if (path === "drafts/drBroken?format=full") throw new Error("gmail drafts/drBroken 404");
  if (path === "drafts/drX?format=full") {
    return { id: "drX", message: { id: "mX", threadId: "th3", payload: {
      headers: hdrs({ From: "Scott Greenwald <scottgwald@gmail.com>", To: "Counter Party <cp@x.de>", Cc: "Third <t@x.de>", Bcc: "Me <me@x.de>",
        "Reply-To": "replies@x.de", Subject: "Re: Hello", Date: "Tue, 3 Nov 2026 09:00:00 +0100", "In-Reply-To": "<mid9@x>", References: "<mid9@x>" }),
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: b64u("<p>Hi &amp; bye</p>") } },
        { mimeType: "application/pdf", filename: "keep.pdf", body: { attachmentId: "attK", size: 7 } },
        { mimeType: "image/png", filename: "logo.png", headers: hdrs({ "Content-ID": "<logo>" }), body: { attachmentId: "attL", size: 3 } },
      ],
    } } };
  }
  if (path === "messages/mX/attachments/attK") return { size: 7, data: b64u("PDFDATA") };
  if (path === "drafts/drX" && method === "PUT") return { id: "drX", message: { threadId: body.message.threadId } };
  if (path === "drafts/drX" && method === "DELETE") return {};
  throw new Error("unexpected call " + method + " " + path);
};

const ops = createDraftOps(api);

// reply: counterparty + alias + threading; the answered message quoted (D4 b)
{
  const r = await ops.reply("th3", "hello again");
  assert.equal(r.draftId, "drX");
  assert(r.to.includes("cp@x.de"), "targets the counterparty, not the last (own) message: " + r.to);
  assert(r.from && r.from.includes("scottgwald@gmail.com"), "adopts the thread's send-as alias");
  assert.equal(r.subject, "Re: Hello");
  assert.equal(r.quoted, true);
  const post = calls.filter((c) => c.path === "drafts" && c.method === "POST").pop();
  assert.equal(post.body.message.threadId, "th3", "threadId sent with the draft");
  const mime = b64url(post.body.message.raw);
  assert(mime.includes("From: Scott Greenwald <scottgwald@gmail.com>\r\n"), "From header in MIME");
  assert(mime.includes("To: Counter Party <cp@x.de>\r\n"));
  assert(!/^(Cc|Bcc):/m.test(mime), "no Cc / Bcc when none given");
  assert(mime.includes("In-Reply-To: <mid9@x>\r\n") && mime.includes("References: <mid9@x>\r\n"), "threads to the newest message");
  const parts = partsOf(mime);
  assert.equal(parts.text, "hello again\n\nOn Mon, 2 Nov 2026 10:00:00 +0100, Counter Party <cp@x.de> wrote:\n> Original line one\n> line two", "the body, then the quote: " + JSON.stringify(parts.text));
  assert(parts.html.includes("<p>hello again</p>") && parts.html.includes("<blockquote>Original line one<br>line two</blockquote>"), "the quote is a blockquote: " + parts.html);
  console.log("reply: pass");
}

// reply with cc / bcc, and without the quote
{
  const r = await ops.reply("th3", "no quote", { cc: "Third <t@x.de>", bcc: "me@x.de", quote: false });
  assert.deepEqual([r.cc, r.bcc, r.quoted], ["Third <t@x.de>", "me@x.de", false]);
  const mime = b64url(calls.filter((c) => c.path === "drafts" && c.method === "POST").pop().body.message.raw);
  assert(mime.includes("Cc: Third <t@x.de>\r\nBcc: me@x.de\r\n"), "Cc and Bcc headers: " + mime.slice(0, 200));
  assert.equal(partsOf(mime).text, "no quote", "nothing quoted");
  console.log("reply with cc/bcc, no quote: pass");
}

// reply on a thread with no SENT message: no From header at all
{
  const noSent = async (path) => path.startsWith("threads/") ? { messages: [
    { id: "a", labelIds: ["INBOX"], payload: { headers: hdrs({ From: "A <a@x>", Subject: "S", "Message-ID": "<a@x>" }) } } ] }
    : path.startsWith("messages/") ? {} : { id: "d2", message: { threadId: "t" } };
  const r = await createDraftOps(noSent).reply("t", "x");
  assert.equal(r.from, undefined);
  assert.equal(r.quoted, false, "a message with no text is not quoted");
  console.log("reply without alias: pass");
}

// compose
{
  const r = await ops.compose("new@x.de", "Hello", "fresh draft");
  assert.equal(r.draftId, "drX");
  const post = calls.filter((c) => c.path === "drafts" && c.method === "POST").pop();
  assert.equal(post.body.message.threadId, undefined, "compose has no threadId");
  const mime = b64url(post.body.message.raw);
  assert(!mime.includes("From:"), "no From header when none given");
  assert(mime.startsWith("To: new@x.de\r\nSubject: Hello\r\n"));
  const r2 = await ops.compose("new@x.de", "Hello", "with cc", { cc: "c@x.de", bcc: "b@x.de" });
  assert.deepEqual([r2.cc, r2.bcc], ["c@x.de", "b@x.de"]);
  assert(b64url(calls.filter((c) => c.path === "drafts" && c.method === "POST").pop().body.message.raw).startsWith("To: new@x.de\r\nCc: c@x.de\r\nBcc: b@x.de\r\nSubject: Hello\r\n"));
  console.log("compose: pass");
}

// list: hydrated with the draft's fields, and a failed hydrate still emits the bare id
{
  const r = await ops.list();
  assert.equal(r.total, 2);
  assert.deepEqual(r.drafts[0], { draft_id: "drX", thread_id: "th3", to: "Counter Party <cp@x.de>", subject: "Re: Hello",
    cc: "Third <t@x.de>", bcc: "Me <me@x.de>", reply_to: "replies@x.de", date: "Tue, 3 Nov 2026 09:00:00 +0100", in_reply_to: "<mid9@x>",
    attachments: [{ id: "attK", name: "keep.pdf", mime: "application/pdf", size: 7 }] });
  assert.deepEqual(r.drafts[1], { draft_id: "drBroken" });
  console.log("list: pass");
}

// get: html fallback stripped to text, the fields, the inline logo left out
{
  const r = await ops.get("drX");
  assert.equal(r.thread_id, "th3");
  assert.equal(r.body, "Hi & bye");
  assert.deepEqual([r.cc, r.bcc, r.reply_to, r.date, r.in_reply_to, r.body_truncated], ["Third <t@x.de>", "Me <me@x.de>", "replies@x.de", "Tue, 3 Nov 2026 09:00:00 +0100", "<mid9@x>", false]);
  assert.deepEqual(r.attachments, [{ id: "attK", name: "keep.pdf", mime: "application/pdf", size: 7 }]);
  console.log("get: pass");
}

// update: keeps thread + headers (Cc, Bcc, Reply-To) + the attachments it did
// not touch, overrides only what's given
{
  const r = await ops.update("drX", "new text");
  assert.equal(r.threadId, "th3");
  const put = calls.filter((c) => c.method === "PUT").pop();
  assert.equal(put.body.message.threadId, "th3", "update keeps the thread");
  const mime = b64url(put.body.message.raw);
  assert(mime.includes("To: Counter Party <cp@x.de>\r\nCc: Third <t@x.de>\r\nBcc: Me <me@x.de>\r\nReply-To: replies@x.de\r\n"), "Cc, Bcc, Reply-To kept: " + mime.slice(0, 300));
  assert(mime.includes("In-Reply-To: <mid9@x>\r\n"));
  assert(/multipart\/mixed; boundary="mixed-/.test(mime) && mime.includes('filename="keep.pdf"') && mime.includes(Buffer.from("PDFDATA").toString("base64")), "the attachment rides along, inside the mixed part: " + mime.slice(0, 400));
  assert(!mime.includes("logo.png"), "the inline logo was never an attachment");
  assert.equal(partsOf(mime).text, "new text");
  assert(calls.some((c) => c.path === "messages/mX/attachments/attK"), "the attachment's bytes were fetched again");
  await ops.update("drX", "t2", "other@x.de", "New subject", { cc: "" });
  const mime2 = b64url(calls.filter((c) => c.method === "PUT").pop().body.message.raw);
  assert(mime2.includes("To: other@x.de\r\n") && mime2.includes("Subject: New subject\r\n") && !/^Cc:/m.test(mime2) && mime2.includes("Bcc: Me <me@x.de>\r\n"), "to/subject replaced, cc cleared, bcc kept: " + mime2.slice(0, 300));
  console.log("update: pass");
}

// delete
{
  await ops.delete("drX");
  assert(calls.some((c) => c.method === "DELETE" && c.path === "drafts/drX"), "delete hit the API");
  console.log("delete: pass");
}

// The hard boundary.
assert(!calls.some((c) => c.path.includes("send")), "nothing ever sends");
console.log("no send path: pass");

// MIME (D3, 2026-11-04): multipart/alternative — text/plain format=flowed +
// quoted-printable, a minimal html — UTF-8 survives, empty headers dropped,
// a 10 000-character paragraph has no hard break in either part, "<" is
// escaped in the html, attachments put the alternative inside a mixed part
{
  const long = "y".repeat(10000);
  const mime = b64url(gmailRawMime([["From", ""], ["To", "a@x"], ["Subject", "Grüße"]], `ß€ a <b> & c\n\n${long}\n\n> quoted\nhttps://x.de/p?q=1&r=2.`));
  assert(mime.startsWith('To: a@x\r\nSubject: Grüße\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt-'), mime.slice(0, 160));
  assert(mime.includes('Content-Type: text/plain; charset="UTF-8"; format=flowed; delsp=yes\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n'));
  assert(mime.includes('Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n'));
  assert(mime.split("\r\n").every((l) => l.length <= 76), "every encoded line fits 76 characters");
  const parts = partsOf(mime);
  assert.equal(parts.text, `ß€ a <b> & c\n\n${long}\n\n> quoted\nhttps://x.de/p?q=1&r=2.`, "the text part decodes to the body, the long paragraph on one line");
  assert.equal(parts.html, `<p>ß€ a &lt;b&gt; &amp; c</p>\n<p>${long}</p>\n<p><blockquote>quoted</blockquote><a href="https://x.de/p?q=1&amp;r=2">https://x.de/p?q=1&amp;r=2</a>.</p>`, "the html: escaped, paragraphs, the quote, the link: " + parts.html.slice(0, 120));
  assert.equal(quotedPrintable("a = b\ntrailing \n"), "a =3D b\r\ntrailing=20\r\n", "= and a trailing blank encoded; the hard breaks stay");
  assert.equal(flowedText(" leading\nFrom here\n> q \nplain  "), "  leading\n From here\n> q\nplain", "space-stuffed, trailing blanks gone, quotes kept");
  const mixed = b64url(gmailRawMime([["To", "a@x"]], "body", { attachments: [{ name: "f.txt", mime: "text/plain", bytes: new TextEncoder().encode("hi") }] }));
  assert(/^To: a@x\r\nMIME-Version: 1\.0\r\nContent-Type: multipart\/mixed; boundary="mixed-[a-z0-9]+"\r\n\r\n--mixed-[a-z0-9]+\r\nContent-Type: multipart\/alternative/.test(mixed), "the alternative sits inside the mixed part: " + mixed.slice(0, 200));
  assert(mixed.includes('Content-Disposition: attachment; filename="f.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGk=\r\n--mixed-'), mixed);
  assert.equal(mailBodyText({ mimeType: "text/plain", body: { data: Buffer.from("plain ü").toString("base64url") } }), "plain ü");
  assert.deepEqual(mailAttachments({ parts: [{ mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "1", size: 2 } }, { mimeType: "image/png", filename: "l.png", headers: hdrs({ "Content-ID": "<l>" }), body: { attachmentId: "2" } }] }),
    [{ id: "1", name: "a.pdf", mime: "application/pdf", size: 2 }]);
  console.log("mime: pass");
}

// REST adapter: bearer token, 204 empty body tolerated, non-2xx throws
{
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/boom")) return new Response("nope", { status: 403 });
    return Response.json({ ok: 1 });
  };
  const rest = gmailRestApi(async () => "TOK", { fetch: fakeFetch });
  assert.deepEqual(await rest("drafts/x", { method: "DELETE" }), {});
  assert.deepEqual(await rest("drafts"), { ok: 1 });
  assert.equal(seen[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/drafts/x");
  assert.equal(seen[0].init.headers.Authorization, "Bearer TOK");
  await assert.rejects(() => rest("boom"), /gmail boom 403: nope/);
  assert(!seen.some((s) => s.url.includes("/send")), "adapter never sends");
  console.log("rest adapter: pass");
}

console.log("ALL PASS");
