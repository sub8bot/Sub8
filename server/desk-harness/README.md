# desk-harness — host the real grok-build harness on a Sub8 desk droplet (Phase 1)

_Prototype scaffold. BUILD + docs only. Nothing here is deployed, pushed, or enabled on prod. Everything is gated behind `DESK_HARNESS=1`._

## What this is

The pi-executor (`sub8-cloud/src/desk-executor-source.mjs`) **reimplements** the agent
loop on the droplet. This service instead **hosts the real harness** — the
`grok` CLI from [`xai-org/grok-build`](https://github.com/xai-org/grok-build)
(Apache-2.0, Rust) — so cloud parity with local is exact, no reimplementation
drift. grok-build is natively headless, so **no fork is needed**: we run it
unchanged and inject config + auth only.

- `harness.mjs` — drives `grok -p --output-format streaming-json` (the format
  `parseGrokStream` in `../host-cli.mjs` already understands), auto-attaches
  `mcp-sub8` pointed at the droplet's OWN desk, and translates grok's stream into
  the executor `/turn` NDJSON contract.
- `server.mjs` — the single HTTP surface: `GET /health`, `POST /turn`.

### Reused unchanged (no duplication)

- `writeGrokHome(botId, mcpEnv)` from `../host-cli.mjs` — writes `GROK_HOME/config.toml`
  with `[mcp_servers.sub8]` → `node mcp-sub8.mjs`. Same code the local app uses.
- `mcp-sub8.mjs` — same desktop tools (computer/browser/shell via `vm.*`). When
  this harness injects `SUB8_CLOUD_CALLBACK_URL`, state tools (teammates, jobs,
  routines, `ask_user`) POST to the Worker via `mcp-cloud.mjs`. Local grok-build
  is unchanged when that env is unset.
- `parseGrokStream`, `foldGrokVisibleText`, `grokBin`, `hostEnv` — from `../host-cli.mjs`.

### The `/turn` contract (matches the executor)

`POST /turn` streams NDJSON events **identical to the pi-executor**, so the
DeskTurn DO drives grok-build with the **same relay code**
(`sub8-cloud/src/executor-client.mjs` → `brain.mjs`):

```
{ "type": "tool",  "name": "computer", "args": { "action": "open", ... } }
{ "type": "delta", "text": "..." }
{ "type": "done",  "content": "final reply", "usage": { llmCalls, promptTokens, completionTokens } }
{ "type": "error", "message": "..." }
```

`brain.mjs` reads `event.name` + `event.args.action` for tool rows and
`event.content` from `done` — all satisfied above.

Request body — accepts **both** shapes:

- Executor / harness-client contract:
  `{ content, history?, system?, display?, model:{ provider, id, apiKey, baseUrl }, callback:{ url, computerId, botId }, auth? }`
- Task's simple shape: `{ botId, text, model, provider, auth }`

Missing `botId` falls back to `callback.botId`, then `desk-local`. `callback.url`
is written into GROK_HOME as `SUB8_CLOUD_CALLBACK_URL` (plus computer/bot/desk
token/display) so mcp-cloud can reach `POST /api/brain/executor-tool`.

Port is **3011** (`DESK_HARNESS_PORT`), deliberately different from the
pi-executor's 3010 so both can coexist during A/B on one droplet.

---

## Throwaway-droplet procedure (live, first proof)

Run all of this **on a scratch droplet you can destroy**. `$REPO` = this repo
checked out on the droplet.

### 1. Install grok-build

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version    # confirm the CLI is on PATH (harness.mjs finds it via grokBin())
```

### 2. Give the harness a local desk to drive

The droplet already runs a desktop container (the sub8-cloud image uses container
`sub8-desk`, driven by `desk-agent.py`). Point a **test bot row** at that
container so `mcp-sub8` drives it over **local `docker exec`** (no HTTP round
trips). `mcp-sub8` requires `bot.vm.status === "running"` and `bot.vm.container`.

Add one bot to `$SUB8BOT_DATA/bots.json` (default `data/bots.json`):

```jsonc
[
  {
    "id": "desk-test",
    "name": "Desk Test",
    "vm": { "status": "running", "container": "sub8-desk", "display": ":1" },
    "messages": [], "routines": [], "harness": { "provider": "grok-build" }
  }
]
```

> Alternative (loopback HTTP instead of docker exec): set
> `vm.deskUrl = "http://127.0.0.1:3001"` + `vm.deskToken = <desk token>` so
> `isRemoteDesk` fires. Note `mcp-sub8.mjs` still guards on `bot.vm.container`,
> so keep `container` set even for the loopback path, or relax that one guard.

### 3. Provide auth (Phase-1 proof = API key, no interactive login)

```sh
export XAI_API_KEY=xai-...          # harness sets this in grok's spawn env
```

Or pass it per-turn as `model.apiKey`. (OAuth injection: see below.)

### 4. Run the service (flag-gated)

```sh
export DESK_HARNESS=1                       # required — service refuses without it
export DESK_TOKEN=$(cat /var/lib/sub8/desk-token)   # or any shared secret for the test
export SUB8BOT_DATA=$REPO/data              # where bots.json lives
cd $REPO && node server/desk-harness/server.mjs
# → desk-harness on :3011 (grok=true)
```

### 5. Drive a turn and confirm it steers the desktop + streams back

```sh
curl -N -X POST http://127.0.0.1:3011/turn \
  -H "Authorization: Bearer $DESK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"botId":"desk-test","content":"Open example.com and tell me the page heading.",
       "model":{"provider":"xai","id":"grok-4.6","apiKey":"'"$XAI_API_KEY"'"}}'
```

Expect a stream of `{"type":"tool",...}` (computer/browser/shell via mcp-sub8),
`{"type":"delta",...}`, then one `{"type":"done","content":...}`. Watch the
desktop (VNC/noVNC) — Chrome should navigate. That proves the full path:
`POST /turn → grok-build → mcp-sub8 → droplet desk → NDJSON back`, identical to
local.

`GET /health` (no auth) returns `{ ok, harness:true, grok }` for readiness probes.

---

## Grok-OAuth injection path (Phase 3 — cloud users already do device flow)

The app implements Grok OAuth (device flow, token in `brain:<userId>`, refreshed
by the Worker). To run grok-build on the **user's own Grok** with no new auth
plumbing, inject grok-build's `auth.json` — the same file `vm.pushHostGrokAuth`
copies into a local container's `/config/.grok/auth.json`.

`writeHarnessHome` writes `auth` to `GROK_HOME/auth.json` after `writeGrokHome`.
grok-build 1.0.5 ignores a flat `{access_token}` blob. The harness-client sends
the oidc record (and C1 writes it as received):

```jsonc
{ "botId": "...", "content": "...",
  "provider": "grok-oauth",
  "auth": {
    "https://auth.x.ai::<clientId>": {
      "auth_mode": "oidc",
      "key": "<access_token>",
      "refresh_token": "...",
      "expires_at": "...",
      "oidc_issuer": "https://auth.x.ai",
      "oidc_client_id": "<clientId>",
      "user_id": "<uuid>",          // required by grok-build 1.0.5
      "create_time": "<iso8601>"    // required by grok-build 1.0.5
    }
  }
}
```

API-key turns (`provider` not oauth, `model.apiKey` or `XAI_API_KEY`) set
`XAI_API_KEY` in grok's spawn env and **unlink** `GROK_HOME/auth.json` so a
copied host login cannot shadow the key. OAuth turns do the reverse: write
`auth.json` and delete `XAI_API_KEY` from the spawn env even if the droplet
shell has one.

> Difference from `executor-client.mjs`: the pi-executor passes only the OAuth
> **bearer** as `model.apiKey`. grok-build wants the **auth.json file**, so the
> harness client sends the full `auth` object for `grok-oauth` and reserves
> `model.apiKey`/`XAI_API_KEY` for API-key providers (Phase 2: Claude API,
> OpenRouter, Grok API — same hosted harness, backend chosen from the brain).
> Never bake a token into the golden image; inject per-session and revoke.

---

## How the DeskTurn DO would call it (flag-gated)

The Worker already has `sub8-cloud/src/harness-client.mjs` (C3, sibling of
`executor-client.mjs`). `harnessEnabled(env)` is `String(env.DESK_HARNESS) === "1"`
and health/turn talk to **:3011**. Flag stays **off** in `wrangler.jsonc` — do not
enable on prod from this repo.

```js
} else if (desk?.ipv4 && secret?.token && harnessEnabled(env) && (await harnessHealthy(env, desk.ipv4))) {
  const text = await harnessTurn(env, { ipv4, deskToken, content, history, system, display, row, computerId, botId }, onEvent);
```

Because the NDJSON event shapes match the pi-executor, `onEvent` (tool-row / done
relay) is unchanged. Any harness failure throws so `brain.mjs` falls back to the
Worker loop. A second option is still to point the executor seam at 3011; the
contract is the same.

`grok acp` (ACP JSON-RPC over stdio, same protocol as `../hermes-acp.mjs`) is the
streaming upgrade path for finer-grained deltas; `-p --output-format
streaming-json` is the first proof because `parseGrokStream` already handles it.

---

## Selftest

```sh
node server/desk-harness/server.mjs --selftest   # or: node test/desk-harness.mjs
```

Runs a **canned grok stream** through the real parse→emit pipeline with a mocked
spawn (no grok binary, no droplet) and asserts:

1. `writeHarnessHome` reuses `writeGrokHome` → `config.toml` auto-attaches
   `[mcp_servers.sub8]` (mcp-sub8) carrying this bot's id; OAuth path injects `auth.json`.
2. `POST /turn` emits `tool` + `delta` + exactly one `done` (with `usage`) and no
   `error`, matching the executor contract; `done.content` is the folded reply.
3. API-key path sets `XAI_API_KEY` + `GROK_HOME`, runs `--output-format streaming-json`,
   and does not leave `GROK_HOME/auth.json`.
4. OAuth path writes the oidc `auth.json` and omits `XAI_API_KEY` even if the
   process env has one.
5. `server.mjs` refuses to listen unless `DESK_HARNESS=1`; with the flag, `GET /health`
   is `{ ok, harness:true, grok }` on `DESK_HARNESS_PORT` (default **3011**) and
   `POST /turn` is 401 without the desk bearer.

`test/desk-harness.mjs` is wired into `npm test`.

## Next live-droplet test step

On a throwaway droplet, run steps 1–5 above with a real `XAI_API_KEY` and confirm
the `POST /turn` stream **drives the actual desktop** (Chrome navigates on the
VNC screen) and returns a coherent `done.content`. That single run validates the
one thing the selftest mocks: real `grok` launching `mcp-sub8` against a live
desk. Then repeat with the OAuth `auth.json` injection to validate Phase 3.
