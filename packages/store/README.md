# @sub8/store

The disk layer. Everything under `data/` that the host owns is read and written
here, under one file lock per file, so two processes (the server, the MCP
server, `host-cli`) cannot clobber each other.

## What is here

Three entry points, because the three modules keep their own names:

| import | was | owns |
| --- | --- | --- |
| `@sub8/store` | `server/store.mjs` | `bots.json`, `conversations/`, `settings.json`, `screens/` |
| `@sub8/store/channels` | `server/channels.mjs` | `channels.json` and the desk `group.json` mirror |
| `@sub8/store/trace` | `server/trace.mjs` | `traces/<botId>.jsonl` |

`trace` and `channels` are subpaths rather than one flat barrel because
`trace.write` / `trace.read` are only meaningful with `trace.` in front of
them. Callers keep the shape they already had — `import * as trace from
"@sub8/store/trace"`.

## `dataDir` lives here now

`server/paths.mjs` used to own `dataDir` and this module re-exported it. That is
now the other way round: `dataDir` is exported from here and `server/paths.mjs`
re-exports it, so there is one definition of "where the user's data lives" and
it sits with the code that writes there. `paths.mjs` keeps `appRoot` and
`fileRoot`, which derive from **its own file location** and cannot move (see
`packages/constants/README.md`).

It binds at import time, from `SUB8BOT_DATA` / `OCTOBOT_DATA`, falling back to
`<cwd>/data`. Tests that want a scratch data dir must set the env var **before**
the first `import` of this package — `botsPath`, `channelsPath` and the traces
dir are all module-level constants derived from it.

## The cross-tree import is gone

`server/store.mjs` imported `../web/palette.js` for `AVATAR_COLORS` — the server
reaching sideways into the web tree. It now takes them from `@sub8/constants`,
which is the only dependency this package has.

## What is deliberately NOT here

- **`vm.mjs`.** `syncGroupJsonToDesk` takes a `writer(dest, text)` instead of
  importing the container tunnel, the same injection `@sub8/automations` uses.
- **The routine model.** `@sub8/automations` owns `Routine`. `StoredRoutine`
  here is only the slice `upsertBot`'s merge touches, plus `runs`, which that
  package does not model.
- **`deleteChannel`.** Agents cannot delete a room; `removeChannel` is
  host-only, for the sidebar and for tests.

## Types

Rows on disk were written by older builds, so almost every field is optional and
every record keeps an index signature: a field this version does not know about
survives a read/modify/write round trip instead of being dropped.
