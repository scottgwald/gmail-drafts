# gmail-drafts

The Gmail **draft** lifecycle over plain REST, as one runtime-neutral ES module.
Consumed as a git submodule by [swg-tasks](https://github.com/scottgwald/swg-tasks)
(Cloudflare Worker) and by a local Bun MCP server, so both run the same code.

```js
import { createDraftOps, gmailRestApi } from "./vendor/gmail-drafts/gmail-drafts.js";

const api = gmailRestApi(() => getAccessToken());   // one account
const drafts = createDraftOps(api);

await drafts.reply(threadId, body);        // To = counterparty, From = the thread's send-as alias
await drafts.compose(to, subject, body);
await drafts.list();                       // { drafts: [{draft_id, thread_id, to, subject}], total }
await drafts.get(draftId);                 // headers + plain-text body
await drafts.update(draftId, body, to, subject);   // to/subject optional; keeps threadId + headers
await drafts.delete(draftId);
```

`api(path, opts)` is any authenticated Gmail REST call relative to
`users/me/` that returns parsed JSON (`{}` for an empty body); `gmailRestApi`
builds one from a token getter. Only `fetch`, `TextEncoder`/`TextDecoder`
and `btoa`/`atob` are used.

## Rules baked in

- **reply** addresses the last message *without* the `SENT` label (Reply-To,
  else From), not the last message overall, which would self-address the
  draft whenever you spoke last. `From:` is the last `SENT` message's From,
  so alias-run threads keep their alias. In-Reply-To/References chain to the
  newest message; `threadId` is always sent.
- **update** re-reads the draft's metadata first and carries `threadId` and
  From/To/Subject/In-Reply-To/References forward; a bare PUT would silently
  detach the draft from its conversation.
- **delete** tolerates the 204 empty body.
- **Draft-only by construction.** No function builds a URL containing
  `send`; the test asserts it across the whole lifecycle. Do not add one.

## Test

```
npm test          # node test/gmail-drafts.test.mjs
bun test/gmail-drafts.test.mjs
```
