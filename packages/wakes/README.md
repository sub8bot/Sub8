# @sub8/wakes

The durable per-Bot wake queue, and the SendMessage reminders a turn gets when
it goes quiet.

Moved verbatim from `server/wakes.mjs` (247 lines) and
`server/turn-reminders.mjs` (72 lines), both zero internal imports.

## What is here

- **The queue** — `enqueueWake`, `takeWake`, `takeWakeOfType`, `takeWakeById`,
  `takeMatchingWake`, `listWakes`, `listQueuedBotIds`. One FIFO per bot,
  mirrored to `<data>/wakes.json` so a wake survives a restart.
- **Lanes** — `takeWake` is not strictly FIFO. A user wake beats a priority peer
  wake, which beats an ordinary peer/channel wake, which beats an automation
  (routine, shell, completion). `takeWakeOfType` deliberately does *not* jump the
  lane, so draining a finished shell cannot swallow a teammate's note.
- **`WAKE_TYPES` / `AUTO_DRAIN_WAKE_TYPES`** — the seven kinds the queue accepts,
  and the four the host pumps live. Completions keep their own subscribers.
- **`turnPromptForWake`** — what the parent actually reads when a durable wake
  becomes a turn.
- **Turn reminders** — `reminderFor` / `reminderMessage`. A turn that opens with
  tool calls and no `send_message` gets an ack nudge; one that runs past
  `SEND_THRESHOLD` tool calls in silence gets a delivery nudge. Both arrive as
  hidden user lines, never as chat bubbles.

## Where the data lives

`SUB8BOT_DATA` (or the legacy `OCTOBOT_DATA`, or `<cwd>/data`) → `wakes.json`.
The path is read per call, so a test can point it at a tmpdir before importing —
`load()` runs once at import time, and every write after that is
fire-and-forget. `flushWakes()` awaits the write chain when a test needs the
file on disk.

## What is deliberately NOT here

Who produces a wake, and who turns one into a turn. `server/teammate.mjs`,
`server/channels.mjs`, `server/subagents.mjs` and `server/code-agent.mjs` push;
`server/index.mjs` pumps and starts the turn. This package only owns the ledger
and the lane order.
