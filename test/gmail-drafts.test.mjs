// Walks the whole draft lifecycle against a recording fake `api`, then the
// REST adapter against a fake fetch. Plain asserts, no framework: runs under
// `node test/gmail-drafts.test.mjs` and `bun test/gmail-drafts.test.mjs`.
import assert from "node:assert";
import { createDraftOps, gmailRestApi, gmailRawMime, mailBodyText } from "../gmail-drafts.js";

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

const calls = [];
const api = async (path, opts = {}) => {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ path, method, body });
  if (path.startsWith("threads/th3")) {
    return { messages: [
      { id: "m1", labelIds: ["INBOX"], payload: { headers: hdrs({ From: "Counter Party <cp@x.de>", Subject: "Hello", "Message-ID": "<mid1@x>" }) } },
      { id: "m2", labelIds: ["SENT"], payload: { headers: hdrs({ From: "Scott Greenwald <scottgwald@gmail.com>", Subject: "Re: Hello", "Message-ID": "<mid9@x>" }) } },
    ] };
  }
  if (path === "drafts" && method === "POST") return { id: "drX", message: { id: "mX", threadId: body.message.threadId || "tNew" } };
  if (path === "drafts?maxResults=15") return { drafts: [{ id: "drX" }, { id: "drBroken" }] };
  if (path === "drafts/drBroken?format=metadata") throw new Error("gmail drafts/drBroken 404");
  if (path === "drafts/drX?format=metadata") {
    return { id: "drX", message: { threadId: "th3", payload: { headers: hdrs({
      From: "Scott Greenwald <scottgwald@gmail.com>", To: "Counter Party <cp@x.de>", Subject: "Re: Hello",
      "In-Reply-To": "<mid9@x>", References: "<mid9@x>" }) } } };
  }
  if (path === "drafts/drX?format=full") {
    return { id: "drX", message: { threadId: "th3", payload: {
      headers: hdrs({ From: "Scott Greenwald <scottgwald@gmail.com>", To: "Counter Party <cp@x.de>", Subject: "Re: Hello" }),
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/html", body: { data: Buffer.from("<p>Hi &amp; bye</p>").toString("base64url") } }],
    } } };
  }
  if (path === "drafts/drX" && method === "PUT") return { id: "drX", message: { threadId: body.message.threadId } };
  if (path === "drafts/drX" && method === "DELETE") return {};
  throw new Error("unexpected call " + method + " " + path);
};

const ops = createDraftOps(api);

// reply: counterparty + alias + threading
{
  const r = await ops.reply("th3", "hello again");
  assert.equal(r.draftId, "drX");
  assert(r.to.includes("cp@x.de"), "targets the counterparty, not the last (own) message: " + r.to);
  assert(r.from && r.from.includes("scottgwald@gmail.com"), "adopts the thread's send-as alias");
  assert.equal(r.subject, "Re: Hello");
  const post = calls.filter((c) => c.path === "drafts" && c.method === "POST").pop();
  assert.equal(post.body.message.threadId, "th3", "threadId sent with the draft");
  const mime = b64url(post.body.message.raw);
  assert(mime.includes("From: Scott Greenwald <scottgwald@gmail.com>\r\n"), "From header in MIME");
  assert(mime.includes("To: Counter Party <cp@x.de>\r\n"));
  assert(mime.includes("In-Reply-To: <mid9@x>\r\n") && mime.includes("References: <mid9@x>\r\n"), "threads to the newest message");
  assert(mime.endsWith("\r\n\r\nhello again"), "blank line then body");
  console.log("reply: pass");
}

// reply on a thread with no SENT message: no From header at all
{
  const noSent = async (path) => path.startsWith("threads/") ? { messages: [
    { id: "a", labelIds: ["INBOX"], payload: { headers: hdrs({ From: "A <a@x>", Subject: "S", "Message-ID": "<a@x>" }) } } ] }
    : { id: "d2", message: { threadId: "t" } };
  const r = await createDraftOps(noSent).reply("t", "x");
  assert.equal(r.from, undefined);
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
  console.log("compose: pass");
}

// list: hydrated, and a failed hydrate still emits the bare id
{
  const r = await ops.list();
  assert.equal(r.total, 2);
  assert.deepEqual(r.drafts[0], { draft_id: "drX", thread_id: "th3", to: "Counter Party <cp@x.de>", subject: "Re: Hello" });
  assert.deepEqual(r.drafts[1], { draft_id: "drBroken" });
  console.log("list: pass");
}

// get: html fallback stripped to text
{
  const r = await ops.get("drX");
  assert.equal(r.thread_id, "th3");
  assert.equal(r.body, "Hi & bye");
  console.log("get: pass");
}

// update: keeps thread + headers, overrides only what's given
{
  const r = await ops.update("drX", "new text");
  assert.equal(r.threadId, "th3");
  const put = calls.filter((c) => c.method === "PUT").pop();
  assert.equal(put.body.message.threadId, "th3", "update keeps the thread");
  const mime = b64url(put.body.message.raw);
  assert(mime.includes("To: Counter Party <cp@x.de>\r\n") && mime.includes("In-Reply-To: <mid9@x>\r\n") && mime.endsWith("new text"));
  await ops.update("drX", "t2", "other@x.de", "New subject");
  const mime2 = b64url(calls.filter((c) => c.method === "PUT").pop().body.message.raw);
  assert(mime2.includes("To: other@x.de\r\n") && mime2.includes("Subject: New subject\r\n"));
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

// MIME: UTF-8 survives, empty headers dropped
{
  const mime = b64url(gmailRawMime([["From", ""], ["To", "a@x"], ["Subject", "Grüße"]], "ß€"));
  assert.equal(mime, 'To: a@x\r\nSubject: Grüße\r\nContent-Type: text/plain; charset="UTF-8"\r\nMIME-Version: 1.0\r\n\r\nß€');
  assert.equal(mailBodyText({ mimeType: "text/plain", body: { data: Buffer.from("plain ü").toString("base64url") } }), "plain ü");
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
