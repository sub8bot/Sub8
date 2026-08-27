# @sub8/control

Take control: the flag that says a human is driving this Bot's computer, the
ledger of asks for it, and the wake that fires when the desk comes back.

Moved verbatim from `server/control.mjs` (91 lines, zero internal imports). The
emitted JS is token-for-token the original.

## What is here

- **The flag** — `setHumanControl` / `isHumanControl`. In-memory only, on
  purpose: a server restart means nobody is at the keyboard any more, so the
  state should not survive it.
- **The ask** — `requestBoxHelp` / `pendingBoxHelp` / `clearBoxHelp`. The
  `request_box_help` tool asks the human to step in for a login, 2FA, a captcha
  or a payment. It does *not* flip the flag — only the Take control button does
  — and the row it writes pins `hostFs: false, external: false`, because spec
  External* (the host Mac filesystem) is out of scope and the record has to say
  so.
- **The handback** — `releaseHumanControl` returns what was pending, and
  `boxHelpReleasedWake` turns that into the durable wake the host enqueues.
  Without it, a Bot that asked for a login sits idle after the human is done.
- **`requestExternal`** — throws, always. It exists so the refusal has one place
  and one error code (`EXTERNAL_OUT`) rather than being re-argued per caller.

## Error codes

`requestBoxHelp`, `releaseHumanControl` and `boxHelpReleasedWake` throw an Error
carrying `code: "NEED_BOT"` when the bot id is missing; `requestExternal` throws
`code: "EXTERNAL_OUT"`. `server/index.mjs` branches on those to pick a status.

## What is deliberately NOT here

The route and the wake queue. `POST /api/bots/:id/control` lives in
`server/index.mjs`, which is also what calls `enqueueWake` from `@sub8/wakes`
with the wake this package builds — asserted by `test/control-route.mjs`.
