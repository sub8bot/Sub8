# @sub8/harness-protocol

The wire contract between **Sub8 Cloud** (the Cloudflare Worker, `cloud/src/`) and the
**desk harness** that runs on a desk droplet (`server/desk-harness/`).

It owns three shapes and nothing else:

| Shape | Endpoint | Produced by | Consumed by |
|---|---|---|---|
| `TurnRequest` | `POST /turn` body | `harnessTurn()` — `cloud/src/harness-client.mjs` | `normalizeTurn()` — `server/desk-harness/harness.mjs` |
| `TurnEvent` (`tool`/`delta`/`done`/`error`) | `POST /turn` NDJSON response | `feedGrokLine` / `feedClaudeLine` / `runTurn` — `server/desk-harness/harness.mjs` | `createNdjsonParser()` — `cloud/src/harness-client.mjs`, `runDeskTurn()` — `server/desk-client.mjs` |
| `HarnessHealth` (`{ok,harness,grok,mcp,tools}`) | `GET /health` | `server/desk-harness/server.mjs` | `harnessHealthy()` on **both** sides |

Plus `StopResponse` for `POST /stop`, the port/path constants, and the provider
predicates both sides branch on.

**No transport lives here.** Sockets, chunked HTTP, retries, `cloudflare:sockets`
fallback, spawning grok — all of that stays where it is. This package is the
boundary check that runs *between* the transport and the application.

Zero runtime deps, strict TS, `tsc` → `dist/` with `.d.ts`, `node --test`.

```
npm test        # tsc && node --test test/harness-protocol.test.mjs
```

## Why this seam

The two implementations are coupled by a hand-maintained, untyped contract, and
`GET /health` could not see the coupling. When the desk snapshot's file list
rotted, `mcp-sub8` died on a missing import while `/health` still answered
`{"ok":true,"harness":true,"grok":true}`. Every turn came back toolless for three
days and nothing detected it.

That probe is now deeper: the desk runs a real `mcp-sub8` handshake (cached, off
the request path) and answers `mcp` + `tools`. Both are OPTIONAL, so a desk still
running the old harness omits them and reads as **unknown**, never down.

The events on this wire have exactly two failure modes and both are silent:

1. **A line the receiver does not recognise is dropped.** Today both clients
   `JSON.parse` a line, ignore a throw, and ignore an unknown `type`. A harness
   that grows an event the Worker has not been taught looks exactly like a
   harness that has gone quiet.
2. **A line the receiver mis-decodes still parses.** Replacement characters land
   *inside* a JSON string, so a corrupted `done` event is structurally perfect
   and carries a wrong reply. That is the em-dash bug: `—` is 3 bytes and 1 JS
   char, and decoding each TCP read independently splits it.

`createTurnEventDecoder` closes both: it decodes once across chunks (hand it
`Uint8Array`, not strings), and it *reports* every rejected line with a reason
instead of swallowing it.

## What is in here

**Constants** — `HARNESS_PORT` (3011, currently hardcoded in four files),
`HEALTH_PATH`, `TURN_PATH`, `STOP_PATH`, `NDJSON_CONTENT_TYPE`, `TURN_EVENT_TYPES`.

**Types** — `TurnRequest`, `SimpleTurnRequest` (the older `{botId,text,model}`
shape `normalizeTurn` still accepts), `HistoryMessage`, `ModelSpec`,
`TurnCallback`, `GrokAuthFile`/`GrokAuthRecord`, `ClaudeCredentials`,
`ToolEvent`, `DeltaEvent`, `DoneEvent`, `ErrorEvent`, `TurnUsage`,
`HarnessHealth`, `HarnessToolsState`, `StopResponse`, `TurnStreamResult`.

**Guards** — `isToolEvent` / `isDeltaEvent` / `isDoneEvent` / `isErrorEvent` /
`isTurnEvent`, `turnEventReject` (why a value was rejected: `not-json`,
`not-object`, `missing-type`, `unknown-type`, `bad-shape`), `parseTurnEventLine`,
`encodeTurnEvent` (validates before writing, so a producer bug fails at the
producer), `isHarnessHealth` / `harnessIsUp` / `harnessCanTurn` / `harnessToolsState` /
`harnessHasTools` / `parseHarnessHealth`, `isStopResponse`, `isGrokAuthFile`,
`isTurnRequest` / `assertTurnRequest`, and `turnRequestProblems(body): string[]`.

`turnRequestProblems` carries the cross-field invariants that have actually
broken production, not just type hygiene:

- an OAuth provider with no `auth` (grok runs signed out and answers "Not signed in");
- a Claude provider with a `grok-*` `model.id` (the desk spawns the claude CLI, `--model grok-4.6` just fails);
- `model.provider` disagreeing with the top-level `provider` (`normalizeTurn` prefers the top level, so the two sides pick different agents);
- a flat `{access_token}` blob where a keyed `${issuer}::${clientId}` auth.json belongs (grok-build silently ignores it).

**Decoder** — `createTurnEventDecoder({onEvent, onMalformed})` (streaming, byte-safe,
async `push`/`finish`) and `decodeTurnEvents(input, onEvent?)` (whole-body,
synchronous). Both return the same `TurnStreamResult`: `content` (the trimmed
final `done`, `""` if the stream ended without one), `done`, `error`, per-type
`counts`, and `malformed` / `malformedCount`.

**Provider predicates** — `isClaudeProvider`, `isOAuthProvider`. See the drift note below.

## Adoption

### Who imports what

| File | Repo | Imports | Replaces |
|---|---|---|---|
| `cloud/src/harness-client.mjs` | cloud (submodule) | `createTurnEventDecoder`, `assertTurnRequest`, `parseHarnessHealth`/`harnessIsUp`, `isStopResponse`, `HARNESS_PORT`, `isClaudeProvider`/`isOAuthProvider` | local `createNdjsonParser`, `consumeNdjsonStream`, inline `body.ok && body.harness`, the local `HARNESS_PORT`, `row.provider === "claude"` |
| `cloud/src/brain.mjs` | cloud | `TurnEvent` types (jsdoc `@type`) | the untyped `event` in `relayDropletTurn`'s `onEvent` |
| `cloud/src/digitalocean.mjs` | cloud | `HARNESS_PORT` | its own `HARNESS_PORT` const (firewall rule + bake) |
| `server/desk-harness/server.mjs` | this repo | `encodeTurnEvent`, `HarnessHealth`, `TURN_PATH`/`HEALTH_PATH`/`STOP_PATH`, `NDJSON_CONTENT_TYPE`, `HARNESS_PORT` | the raw `` emit = (obj) => res.write(`${JSON.stringify(obj)}\n`) `` and the literal health object |
| `server/desk-harness/harness.mjs` | this repo | `turnRequestProblems`, `isClaudeProvider`, `isOAuthProvider`, `TurnEvent` types | the hand-rolled checks inside `normalizeTurn`, the local `isClaudeProvider` |
| `server/desk-client.mjs` | this repo | `createTurnEventDecoder`, `parseHarnessHealth`, `harnessIsUp`, `harnessCanTurn`, `DESK_HARNESS_CONTAINER_PORT` → `HARNESS_PORT` | `parseNdjsonLine`, `consumeNdjson`, the inline `body?.ok && body?.harness && body?.grok === true` |

Consumption from `.mjs` follows the pattern already used for `@sub8/orchestration`
in `server/memory.mjs`, `server/code-agent.mjs` — a relative
import of the built `dist/`, not a package name:

```js
import { createTurnEventDecoder } from "../packages/harness-protocol/dist/index.js";
```

Cloud cannot do that (a Worker cannot import across the repo boundary), so it
**vendors** the built `dist/` exactly like orchestration does:
`cloud/scripts/sync-orchestration.mjs` → `cloud/vendor/orchestration/`. Add a
sibling copy step (or generalise that script) to produce
`cloud/vendor/harness-protocol/`, and import from there.

### Migration order

Adopt **producers before consumers**, and on each side **validate before you
switch behaviour**. Each step is separately revertible and none of them changes
the bytes on the wire.

1. **Land the package.** (this pass) Types, guards, decoder, tests. Nothing imports it.
2. **Desk producer, non-enforcing.** In `server/desk-harness/server.mjs`, route
   `emit` through `encodeTurnEvent`, but catch and fall back to the raw
   `JSON.stringify` + log on throw. This proves the harness only ever emits
   shapes the guards accept, without risking a turn. Run the existing
   `node server.mjs --selftest` and `test/desk-harness.mjs` — the selftest drives
   the whole parse→emit pipeline with a canned stream and no droplet, so it is
   the cheap check.
3. **Desk producer, enforcing.** Drop the fallback. From here a malformed event
   cannot leave the desk.
4. **In-repo consumer.** Swap `server/desk-client.mjs`'s `parseNdjsonLine` /
   `consumeNdjson` for `createTurnEventDecoder`, and its health booleans for
   `harnessIsUp` / `harnessCanTurn`. Covered by `test/desk-client.mjs` and
   `test/in-desk-harness.mjs`. Do this before cloud: it is in one repo, has
   tests, and shakes out any guard that is too strict.
5. **Cloud vendoring.** Add the `harness-protocol` copy step to
   `cloud/scripts/sync-orchestration.mjs` (or a sibling). No source change yet.
6. **Cloud consumer.** Replace `createNdjsonParser` / `consumeNdjsonStream` in
   `cloud/src/harness-client.mjs` with `createTurnEventDecoder`. Two behaviours
   must be preserved deliberately, because they are the client's, not the
   contract's: `harnessTurn` **throws** on an `error` event (`isHarnessAppError`
   in `brain.mjs` depends on the message), and it throws
   `"harness turn ended without a result"` when `content` is `""`. Both are now
   one `if` on the `TurnStreamResult`.
7. **Cloud producer.** Call `assertTurnRequest(payload)` in `harnessTurn` before
   the POST. This is the step that would have caught the Claude-user-runs-grok
   bug at the Worker instead of on the droplet.
8. **Port + provider de-duplication.** Point `cloud/src/digitalocean.mjs`,
   `cloud/src/harness-client.mjs`, `server/desk-client.mjs` and
   `server/desk-harness/server.mjs` at `HARNESS_PORT`, and both sides at
   `isClaudeProvider` / `isOAuthProvider`.

### The desk-snapshot bake

`cloud/scripts/rebuild-desk-snapshot.mjs` computes the rsynced bundle from the
**real import graph** of the harness entrypoints (`harnessBundle()`), following
relative specifiers and resolving `.mjs`. A relative import of
`../../packages/harness-protocol/dist/index.js` from `server/desk-harness/*.mjs`
is therefore picked up automatically, along with the `./constants.js`,
`./events.js`, … it pulls in — `rsync --relative` recreates the paths under
`/opt/sub8-harness/`.

**One caveat, and it is the same class of rot the graph was added to fix:**
`dist/` is gitignored, so the bundle carries whatever was last built in the
working tree. `npm run build` (or `npm test`) in this package must run **before**
a bake, and step 2 above should not land until that is wired into the bake path.
The on-droplet selftest in step 4 of the snapshot script is the backstop: it
imports the whole bundle, so a missing `dist/` fails the bake instead of shipping
a desk that answers `/health` and nothing else.

## What breaks if the two sides drift

This is the point of the package, so concretely — each of these is a real
failure mode of *this* wire, with the guard that now catches it:

| Drift | Symptom today | Caught by |
|---|---|---|
| Harness emits a new event type (`{type:"status"}`) | Silently dropped by both clients. Indistinguishable from a stalled turn. | `turnEventReject` → `unknown-type`, surfaced via `onMalformed` |
| Harness renames a field (`{type:"tool", tool:"computer"}`) | Chat renders an activity row named `"tool"` forever, or none at all | `isToolEvent` → `bad-shape` |
| `done` stops carrying `usage` | `usage` stays `null`; token accounting silently zeroes | `isDoneEvent` accepts (optional today) — the type is the notice that it is optional |
| Per-chunk UTF-8 decode reintroduced | **Every reply containing an em dash is corrupted**, and the corrupt line still parses | pinned by two tests: every byte-split of a non-ASCII stream, plus a test that asserts the naive decode *does* corrupt |
| Worker sends a Claude turn as `grok-oauth` | The user's Claude subscription silently runs grok | `turnRequestProblems` → provider/model.id and model.provider/provider checks |
| Provider matched exactly on one side, by prefix on the other | `"claude-max"` is Claude to the desk and not-Claude to the Worker | one `isClaudeProvider`, imported by both |
| Port changes in one of four files | Desk unreachable; `/health` never answers, so it reads as "desk down" | one `HARNESS_PORT` |
| `mcp-sub8` dies (missing import, EACCES) | **Every turn runs with zero tools** and `/health` still answers `{ok:true,harness:true,grok:true}` — three days undetected | the desk's own handshake probe → `mcp:false`, read by `harnessToolsState` → `"down"` |
| A desk that predates the probe | — | `mcp` absent → `harnessToolsState` → `"unknown"`, which must never bench it |
| Stream ends with no `done` | `""` reply; the Worker throws a generic error | `TurnStreamResult.content === ""` with `counts`/`malformed` to say *why* |

## Not in here (yet)

- The `/claude/auth*` endpoints (`{ok, loggedIn, authMethod}`, `/start`,
  `/code`, `/logout`, `/export`, `/import`). Same seam, same drift risk — the
  next thing to type.
- **Consumers of `mcp`/`tools`.** The deeper `/health` has landed on the desk
  (`server/desk-harness/server.mjs` runs a cached mcp-sub8 handshake and reports
  `mcp` + `tools`), and `harnessToolsState` / `harnessHasTools` are here to read
  it — but nothing routes on it yet. `harnessHealthy` / `harnessCanTurn` in
  `server/desk-client.mjs` and `cloud/src/harness-client.ts` are unchanged on
  purpose: producers before consumers, and only after enough desks report the
  field that `"unknown"` is rare. Whatever adopts it must bench on `"down"` and
  never on `"unknown"`, or it takes every old desk out of service.
- Anything about **how** bytes are moved. Transport stays in the clients.

## Conventions

Mirrors `packages/orchestration`: strict TS extending the repo's
`tsconfig.base.json`, `tsc` build to `dist/` with declarations, `node --test`
against `dist/`, fixtures under `fixtures/`, zero runtime dependencies.
