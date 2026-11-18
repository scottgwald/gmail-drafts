// Walks the whole draft lifecycle against a recording fake `api`, then the
// REST adapter against a fake fetch. Plain asserts, no framework: runs under
// `node test/gmail-drafts.test.mjs` and `bun test/gmail-drafts.test.mjs`.
import assert from "node:assert";
import { createDraftOps, gmailRestApi, gmailRawMime, mailBodyText, quotedPrintable, htmlOfText, flowedText, mailAttachments, mailInlineCount, mimeHeaderEncode, mimeHeaderDecode, mimeAddressEncode, mimeAddressDecode } from "../gmail-drafts.js";

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
    return { id: "drX", message: { id: "mX", threadId: "th3", labelIds: ["DRAFT"], internalDate: "1793692800000", sizeEstimate: 2345, payload: {
      headers: hdrs({ From: "Scott Greenwald <scottgwald@gmail.com>", To: "Counter Party <cp@x.de>", Cc: "Third <t@x.de>", Bcc: "Me <me@x.de>",
        "Reply-To": "replies@x.de", Subject: "Re: Hello", Date: "Tue, 3 Nov 2026 09:00:00 +0100", "Message-ID": "<draft1@mail.gmail.com>", "In-Reply-To": "<mid9@x>", References: "<mid1@x> <mid9@x>" }),
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

// reply on a thread that holds only your own message (swg-tasks rev8 B3):
// the draft goes to the people that message went to — its To and its Cc —
// not back to you; an explicit cc wins over the inherited one
{
  const ownCalls = [];
  const ownApi = async (path, opts = {}) => {
    ownCalls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (path.startsWith("threads/")) {
      return { messages: [
        { id: "o1", labelIds: ["SENT"], payload: { headers: hdrs({ From: "Scott Greenwald <scottgwald@gmail.com>", To: "Counter Party <cp@x.de>, Second <s@x.de>", Cc: "Third <t@x.de>",
          Subject: "=?UTF-8?B?R3LDvMOfZQ==?= aus Berlin", "Message-ID": "<own1@x>", Date: "Mon, 2 Nov 2026 10:00:00 +0100" }) } } ] };
    }
    if (path === "messages/o1?format=full") {
      return { id: "o1", payload: { mimeType: "text/plain", body: { data: b64u("My first note") },
        headers: hdrs({ From: "Scott Greenwald <scottgwald@gmail.com>", Date: "Mon, 2 Nov 2026 10:00:00 +0100" }) } };
    }
    return { id: "drOwn", message: { threadId: "tOwn" } };
  };
  const own = createDraftOps(ownApi);
  let r = await own.reply("tOwn", "following up");
  assert.deepEqual([r.to, r.cc, r.own_thread, r.subject, r.from], ["Counter Party <cp@x.de>, Second <s@x.de>", "Third <t@x.de>", true, "Re: Grüße aus Berlin", "Scott Greenwald <scottgwald@gmail.com>"], JSON.stringify(r));
  assert(/metadataHeaders=To&metadataHeaders=Cc/.test(ownCalls[0].path), "the thread read asks for To and Cc");
  let mime = b64url(ownCalls.filter((c) => c.path === "drafts").pop().body.message.raw);
  assert(mime.includes("To: Counter Party <cp@x.de>, Second <s@x.de>\r\nCc: Third <t@x.de>\r\n"), "To and Cc of the own message: " + mime.slice(0, 240));
  assert(!/^To: .*scottgwald@gmail\.com/m.test(mime), "not addressed to yourself");
  assert(mime.includes("Subject: =?UTF-8?B?" + Buffer.from("Re: Grüße aus Berlin").toString("base64") + "?=\r\n"), "the subject, decoded and encoded once: " + mime.slice(0, 300));
  assert(mime.includes("In-Reply-To: <own1@x>\r\n"), "threads to your own message");
  assert.equal(partsOf(mime).text, "following up\n\nOn Mon, 2 Nov 2026 10:00:00 +0100, Scott Greenwald <scottgwald@gmail.com> wrote:\n> My first note");
  r = await own.reply("tOwn", "with another cc", { cc: "Other <o@x.de>", quote: false });
  assert.deepEqual([r.to, r.cc], ["Counter Party <cp@x.de>, Second <s@x.de>", "Other <o@x.de>"], "an explicit cc wins");
  mime = b64url(ownCalls.filter((c) => c.path === "drafts").pop().body.message.raw);
  assert(mime.includes("Cc: Other <o@x.de>\r\n") && !mime.includes("Third"), mime.slice(0, 240));
  // a thread with an incoming message is answered as before (no own_thread)
  const r3 = await ops.reply("th3", "as before", { quote: false });
  assert.deepEqual([r3.to, r3.own_thread, r3.cc], ["Counter Party <cp@x.de>", undefined, undefined]);
  assert(!ownCalls.some((c) => c.path.includes("send")), "nothing ever sends");
  console.log("reply on your own thread: pass");
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
  // (rev8 B5: from, saved, attachment_count and first_line joined the row)
  assert.deepEqual(r.drafts[0], { draft_id: "drX", thread_id: "th3", from: "Scott Greenwald <scottgwald@gmail.com>", to: "Counter Party <cp@x.de>", subject: "Re: Hello",
    cc: "Third <t@x.de>", bcc: "Me <me@x.de>", reply_to: "replies@x.de", date: "Tue, 3 Nov 2026 09:00:00 +0100", in_reply_to: "<mid9@x>",
    attachments: [{ id: "attK", name: "keep.pdf", mime: "application/pdf", size: 7 }],
    saved: "2026-11-03T08:00:00.000Z", attachment_count: 1, first_line: "Hi & bye" });
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
  // rev8 B5: everything about the draft, in one answer
  assert.deepEqual(r, { draft_id: "drX", thread_id: "th3", message_id: "mX", from: "Scott Greenwald <scottgwald@gmail.com>",
    to: "Counter Party <cp@x.de>", subject: "Re: Hello", cc: "Third <t@x.de>", bcc: "Me <me@x.de>", reply_to: "replies@x.de",
    date: "Tue, 3 Nov 2026 09:00:00 +0100", saved: "2026-11-03T08:00:00.000Z",
    rfc_message_id: "<draft1@mail.gmail.com>", in_reply_to: "<mid9@x>", references: "<mid1@x> <mid9@x>",
    labels: ["DRAFT"], size: 2345, has_html: true,
    attachments: [{ id: "attK", name: "keep.pdf", mime: "application/pdf", size: 7 }], inline_count: 1,
    body: "Hi & bye", body_chars: 8, body_truncated: false }, JSON.stringify(r));
  // a long body is cut at 4000 and says so; full returns all of it; a bare draft has quiet defaults
  const longApi = async (path) => ({ id: "drL", message: { id: "mL", payload: { mimeType: "text/plain", body: { data: b64u("z".repeat(5000)) },
    headers: hdrs({ To: "a@x", Subject: "=?UTF-8?B?R3LDvMOfZQ==?=" }) } } });
  const cut = await createDraftOps(longApi).get("drL");
  assert.deepEqual([cut.body.length, cut.body_chars, cut.body_truncated, cut.full], [4000, 5000, true, undefined]);
  const whole = await createDraftOps(longApi).get("drL", { full: true });
  assert.deepEqual([whole.body.length, whole.body_chars, whole.body_truncated, whole.full], [5000, 5000, false, true]);
  assert.deepEqual([cut.subject, cut.thread_id, cut.saved, cut.rfc_message_id, cut.references, cut.labels, cut.size, cut.has_html, cut.inline_count, cut.attachments],
    ["Grüße", null, "", "", "", [], 0, false, 0, []], "a draft with nothing else: " + JSON.stringify({ ...cut, body: "" }));
  assert.equal(mailInlineCount({ parts: [{ mimeType: "text/plain", headers: hdrs({ "Content-Disposition": "inline" }), body: { data: "eA" } },
    { mimeType: "image/png", filename: "l.png", headers: hdrs({ "Content-ID": "<l>" }), body: { attachmentId: "2" } },
    { mimeType: "image/gif", headers: hdrs({ "Content-Disposition": "inline" }), body: { data: "eA" } },
    { mimeType: "application/pdf", filename: "a.pdf", headers: hdrs({ "Content-Disposition": "attachment" }), body: { attachmentId: "1" } }] }), 2, "the text itself and a real attachment are not inline parts");
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
  // (the Subject is an RFC 2047 encoded-word since swg-tasks rev8 B3 — it used to go as raw UTF-8)
  assert(mime.startsWith('To: a@x\r\nSubject: =?UTF-8?B?R3LDvMOfZQ==?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt-'), mime.slice(0, 160));
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

// Headers (swg-tasks rev8 B3): a non-ASCII Subject is RFC 2047 encoded-words
// — every line within 76 characters, split between characters, decoding
// back to the text; ASCII is untouched; an already-encoded value is not
// encoded twice (update re-emits what it read); a non-ASCII file name is an
// RFC 2231 parameter beside an ASCII stand-in
{
  assert.equal(mimeHeaderEncode("Plain subject, no change"), "Plain subject, no change");
  assert.equal(mimeHeaderEncode("Grüße"), "=?UTF-8?B?R3LDvMOfZQ==?=");
  assert.equal(mimeHeaderDecode("=?UTF-8?B?R3LDvMOfZQ==?="), "Grüße");
  assert.equal(mimeHeaderDecode("=?utf-8?Q?Gr=C3=BC=C3=9Fe_aus?= Berlin"), "Grüße aus Berlin", "Q words too");
  assert.equal(mimeHeaderDecode("=?UTF-8?B?R3LDvA==?=\r\n =?UTF-8?B?w59l?="), "Grüße", "the blank between two words goes");
  assert.equal(mimeHeaderDecode("=?x-nope?B?AAAA?= stays"), "=?x-nope?B?AAAA?= stays", "an unknown charset is left alone");
  assert.equal(mimeHeaderEncode("=?UTF-8?B?R3LDvMOfZQ==?="), "=?UTF-8?B?R3LDvMOfZQ==?=", "not encoded twice");
  const long = "Übergabe — Vertragsentwurf für das Büro in Köln, 日本語のテキスト 🎉 und noch ein langer Schluss";
  const encd = mimeHeaderEncode(long);
  assert(encd.split("\r\n ").length > 2 && encd.split("\r\n ").every((w) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w) && w.length <= 75), "folded encoded-words of at most 75: " + encd);
  assert.equal(mimeHeaderDecode(encd), long, "it decodes back, no character split across words");
  const mime = b64url(gmailRawMime([["To", "a@x"], ["Subject", long]], "x"));
  assert(mime.split("\r\n").every((l) => l.length <= 76 && /^[\x00-\x7f]*$/.test(l)), "the head is ASCII, every line within 76");
  assert.equal(mimeHeaderDecode(mime.slice(mime.indexOf("Subject: ") + 9, mime.indexOf("\r\nMIME-Version"))), long);
  // update: the Subject the draft holds (encoded or not) goes out encoded once
  const upCalls = [];
  const upApi = async (path, opts = {}) => {
    upCalls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (path === "drafts/dU?format=full") return { id: "dU", message: { id: "mU", threadId: "tU", payload: { mimeType: "text/plain", body: { data: b64u("old") },
      headers: hdrs({ To: "a@x", Subject: upApi.subject }) } } };
    return { id: "dU", message: { threadId: "tU" } };
  };
  for (const held of ["Re: Grüße", "=?UTF-8?B?" + Buffer.from("Re: Grüße").toString("base64") + "?="]) {
    upApi.subject = held;
    await createDraftOps(upApi).update("dU", "new");
    const m2 = b64url(upCalls.filter((c) => c.method === "PUT").pop().body.message.raw);
    assert(m2.includes("Subject: =?UTF-8?B?" + Buffer.from("Re: Grüße").toString("base64") + "?=\r\n"), "update re-emits " + held + ": " + m2.slice(0, 120));
  }
  await createDraftOps(upApi).update("dU", "new", "", "Ein neuer Betreff: Übersicht");
  assert.equal(mimeHeaderDecode(/Subject: (.*)\r\n/.exec(b64url(upCalls.filter((c) => c.method === "PUT").pop().body.message.raw))[1]), "Ein neuer Betreff: Übersicht");
  // file names
  const att = b64url(gmailRawMime([["To", "a@x"]], "body", { attachments: [
    { name: "Übersicht 2026.pdf", mime: "application/pdf", bytes: new TextEncoder().encode("hi") },
    { name: 'a "quoted" name.txt', mime: "text/plain", bytes: new TextEncoder().encode("hi") }] }));
  assert(att.includes('Content-Type: application/pdf; name="_bersicht 2026.pdf";\r\n name*=UTF-8\'\'%C3%9Cbersicht%202026.pdf\r\n'
    + 'Content-Disposition: attachment; filename="_bersicht 2026.pdf";\r\n filename*=UTF-8\'\'%C3%9Cbersicht%202026.pdf\r\n'), "an RFC 2231 name beside the ASCII stand-in: " + att.slice(att.indexOf("application/pdf") - 20, att.indexOf("application/pdf") + 260));
  assert(att.includes('Content-Disposition: attachment; filename="a \\"quoted\\" name.txt"\r\n'), "quotes in an ASCII name are escaped");
  assert(att.split("\r\n").every((l) => /^[\x00-\x7f]*$/.test(l)), "no raw non-ASCII byte in any header");
  console.log("headers: subject encoded-words, file names: pass");
}

// Address headers (swg-tasks rev9 B2): in To / Cc / Bcc / From / Reply-To a
// non-ASCII display name is RFC 2047 encoded-words, mailbox by mailbox — the
// <addr> never, an ASCII mailbox byte for byte, a quoted name with a comma
// one mailbox; what a draft holds encoded goes out again as it is; list and
// get show the names decoded
{
  const ew = (t) => "=?UTF-8?B?" + Buffer.from(t).toString("base64") + "?=";
  // ASCII: byte for byte, whatever it holds
  for (const plain of ["Counter Party <cp@x.de>", "a@x", "a@x, b@y", '"Party, Counter" <cp@x.de>,  Second <s@x.de>', "", ew("Jörg") + " <j@x.de>"]) {
    assert.equal(mimeAddressEncode(plain), plain, "unchanged: " + plain);
  }
  // the spec's case: the quoted non-ASCII name is encoded without its quotes, the ASCII mailbox is untouched
  assert.equal(mimeAddressEncode('"Jörg Müller" <j@x.de>, Ana <a@x.de>'), ew("Jörg Müller") + " <j@x.de>, Ana <a@x.de>");
  assert.equal(mimeAddressEncode("Jörg Müller <j@x.de>"), ew("Jörg Müller") + " <j@x.de>", "an unquoted name");
  assert.equal(mimeAddressEncode('Ana <a@x.de>, "Müller, Jörg" <j@x.de>,Zoë<z@x.de>'), "Ana <a@x.de>, " + ew("Müller, Jörg") + " <j@x.de>," + ew("Zoë") + " <z@x.de>", "a comma inside quotes does not split; a missing blank before < is added");
  assert.equal(mimeAddressEncode('"Jörg \\"the\\" Müller" <j@x.de>'), ew('Jörg "the" Müller') + " <j@x.de>", "escaped quotes inside the name");
  assert.equal(mimeAddressEncode("jörg@x.de, Ana <a@x.de>"), "jörg@x.de, Ana <a@x.de>", "a bare address is never encoded");
  assert.equal(mimeAddressEncode("Ana <ana@köln.example>"), "Ana <ana@köln.example>", "nor is the address in angle brackets");
  assert.equal(mimeAddressEncode("Jörg <j@köln.example>"), ew("Jörg") + " <j@köln.example>", "the name is, the address beside it is not");
  assert.equal(mimeAddressEncode(ew("Jörg") + " Müller <j@x.de>"), ew("Jörg Müller") + " <j@x.de>", "a half-encoded name is decoded first, encoded once");
  const longName = "Übergabe — Vertragsentwurf für das Büro in Köln, 日本語のテキスト und noch ein langer Schluss";
  const longEnc = mimeAddressEncode(`"${longName}" <l@x.de>`);
  assert(longEnc.endsWith("?= <l@x.de>") && longEnc.split("\r\n ").length > 2 && longEnc.split("\r\n ").every((w) => /^[\x21-\x7e ]+$/.test(w) && w.length <= 76), "a long name folds between encoded-words: " + longEnc);
  assert.equal(mimeHeaderDecode(longEnc.slice(0, longEnc.lastIndexOf(" <"))), longName);
  // back for display
  assert.equal(mimeAddressDecode(ew("Jörg Müller") + " <j@x.de>, Ana <a@x.de>"), "Jörg Müller <j@x.de>, Ana <a@x.de>");
  assert.equal(mimeAddressDecode(ew("Müller, Jörg") + " <j@x.de>"), '"Müller, Jörg" <j@x.de>', "a decoded name with a comma is quoted again");
  assert.equal(mimeAddressDecode('"' + ew("Jörg") + '" <j@x.de>'), "Jörg <j@x.de>", "an encoded-word some senders put in quotes");
  assert.equal(mimeAddressDecode('"Party, Counter" <cp@x.de>'), '"Party, Counter" <cp@x.de>', "nothing encoded: as it is");
  for (const v of ['"Jörg Müller" <j@x.de>, Ana <a@x.de>', '"Müller, Jörg" <j@x.de>', "Zoë <z@x.de>, b@y"]) {
    assert.equal(mimeAddressEncode(mimeAddressDecode(mimeAddressEncode(v))), mimeAddressEncode(v), "shown, handed back, the same on the wire: " + v);
  }
  // the message: every address header, and only those
  const mime = b64url(gmailRawMime([["From", "Jörg Müller <me@x.de>"], ["To", '"Jörg Müller" <j@x.de>, Ana <a@x.de>'], ["Cc", "Zoë <z@x.de>"], ["Bcc", "René <r@x.de>"],
    ["Reply-To", "Büro <b@x.de>"], ["Subject", "plain"], ["References", "<id@x>"]], "x"));
  assert(mime.startsWith(`From: ${ew("Jörg Müller")} <me@x.de>\r\nTo: ${ew("Jörg Müller")} <j@x.de>, Ana <a@x.de>\r\nCc: ${ew("Zoë")} <z@x.de>\r\nBcc: ${ew("René")} <r@x.de>\r\nReply-To: ${ew("Büro")} <b@x.de>\r\nSubject: plain\r\nReferences: <id@x>\r\nMIME-Version: 1.0\r\n`), mime.slice(0, 400));
  assert(mime.slice(0, mime.indexOf("MIME-Version")).split("\r\n").every((l) => /^[\x00-\x7f]*$/.test(l)), "no raw non-ASCII byte in the head");
  assert(b64url(gmailRawMime([["To", "Counter Party <cp@x.de>"], ["Subject", "s"]], "x")).startsWith("To: Counter Party <cp@x.de>\r\nSubject: s\r\n"), "an ASCII To is the bytes it always was");
  // the ops: compose encodes; update re-emits what the draft holds, encoded once; list and get show the names
  const adCalls = [];
  const held = { From: ew("Jörg Müller") + " <me@x.de>", To: ew("Müller, Jörg") + " <j@x.de>, Ana <a@x.de>", Cc: ew("Zoë") + " <z@x.de>", Subject: "s" };
  const adApi = async (path, opts = {}) => {
    adCalls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (path === "drafts/dA?format=full") return { id: "dA", message: { id: "mA", threadId: "tA", payload: { mimeType: "text/plain", body: { data: b64u("old") }, headers: hdrs(held) } } };
    if (path.startsWith("drafts?")) return { drafts: [{ id: "dA" }] };
    return { id: "dA", message: { threadId: "tA" } };
  };
  const adOps = createDraftOps(adApi);
  const cr = await adOps.compose('"Jörg Müller" <j@x.de>, Ana <a@x.de>', "Hallo", "x", { cc: "Zoë <z@x.de>" });
  assert.equal(cr.to, '"Jörg Müller" <j@x.de>, Ana <a@x.de>', "the answer names the recipients as they were given");
  assert(b64url(adCalls.filter((c) => c.method === "POST").pop().body.message.raw).startsWith(`To: ${ew("Jörg Müller")} <j@x.de>, Ana <a@x.de>\r\nCc: ${ew("Zoë")} <z@x.de>\r\nSubject: Hallo\r\n`), "compose encodes the names");
  await adOps.update("dA", "new");
  const upRaw = b64url(adCalls.filter((c) => c.method === "PUT").pop().body.message.raw);
  assert(upRaw.startsWith(`From: ${held.From}\r\nTo: ${held.To}\r\nCc: ${held.Cc}\r\nSubject: s\r\n`), "update re-emits the held headers, not encoded twice: " + upRaw.slice(0, 300));
  const got = await adOps.get("dA");
  assert.deepEqual([got.from, got.to, got.cc], ["Jörg Müller <me@x.de>", '"Müller, Jörg" <j@x.de>, Ana <a@x.de>', "Zoë <z@x.de>"], "get shows the names: " + JSON.stringify([got.from, got.to, got.cc]));
  const li = (await adOps.list()).drafts[0];
  assert.deepEqual([li.from, li.to, li.cc], [got.from, got.to, got.cc], "list too");
  await adOps.update("dA", "new", got.to);
  assert(b64url(adCalls.filter((c) => c.method === "PUT").pop().body.message.raw).includes(`\r\nTo: ${held.To}\r\n`), "the shown To handed back is the same header again");
  assert(!adCalls.some((c) => /send/i.test(c.path)), "nothing sends");
  console.log("headers: address display names encoded, addresses never: pass");
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
