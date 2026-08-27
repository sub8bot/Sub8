# @sub8/shell-exec

Background shells on a Bot's desk: start one, decide whether to wait for it, and
leave a wake behind when a job that outlived its turn finishes.

Moved verbatim from `server/background-shell.mjs` (119 lines, one internal
import — `node:crypto`). The emitted JS is token-for-token the original.

## What is here

- **`startShell`** — the whole decision. A job that finishes inside
  `blockUntilMs` comes back `done` and the turn just continues. One that does
  not comes back `{ background: true, status: "running" }`, and the model is
  expected to move on and call `await_shell` later.
- **`awaitShell`** — join a specific id, or the newest still-running job.
- **`listShells` / `getShell` / `attachToBot`** — the per-bot view the UI and the
  `await_shell` tool read. `attachToBot` replaces the row in place, so a job
  never appears twice.
- **`setOnCompleteWake`** — the seam. A backgrounded job that finishes hands a
  `{ type: "shell" }` wake to whatever the host installed; `server/agent.mjs`
  installs `enqueueWake` from `@sub8/wakes`. Nothing is queued for a job the
  turn actually waited on — that would wake a Bot to tell it what it already
  knows.

## Two things that are injected, on purpose

The **runner** (`run`) and the **wake sink** (`setOnCompleteWake`). The desk is a
Docker container reached through `server/vm.mjs`, and the wake ledger is
`@sub8/wakes`; neither belongs inside this package. Both being parameters is
also what lets the tests run the whole lifecycle against a promise gate with no
container in sight.

## What is deliberately NOT here

The shell itself. This package never spawns a process — `vm.shell` does, and
this only tracks what it is doing.
