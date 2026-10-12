# Control API

Sub8 exposes a local HTTP API that other apps and agent harnesses on the same computer can use to list bots, send them messages, follow their progress and stop them. It is the same surface the chat box uses: a message sent here starts a turn when the bot is idle and is steered into the running turn when the bot is busy.

- Base URL: `http://127.0.0.1:8787/api/control/v1` (the port follows the running app)
- Auth: `Authorization: Bearer <token>`
- Only connections from this computer (loopback) are accepted. Requests that carry an `Origin` header (web pages) are refused.
- The API covers bots that run on this Mac. Cloud bots are not listed in v1.

## Turning it on and finding the token

The app writes `control.json` to its data folder at startup:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Sub8/data/control.json` |
| Linux | `~/.config/Sub8/data/control.json` |
| Windows | `%APPDATA%\Sub8\data\control.json` |

```json
{
  "url": "http://127.0.0.1:8787/api/control/v1",
  "token": "s8c_...",
  "version": 1,
  "enabled": true
}
```

The file is created with mode 0600. A harness discovers the API by reading it; read it again on a 401, since the token can be regenerated.

Settings > Control API has the on/off switch ("Allow other apps to control Sub8", on by default), a Copy button for the token, Regenerate (old token stops working immediately), the file path, and ready-to-paste commands. When the switch is off every request answers `403 disabled`.

This token is separate from the app's internal token used by bots' own tools. The data folder is not mounted into bot computers, so bots cannot read it.

## Errors

Errors are JSON with a stable `code`:

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "missing or invalid bearer token; ..." } }
```

| Status | code | When |
| --- | --- | --- |
| 400 | `bad_request` | Missing or empty `text` |
| 401 | `unauthorized` | No token or wrong token |
| 403 | `forbidden` | Not loopback, or a browser request |
| 403 | `disabled` | Switched off in Settings |
| 404 | `not_found` | Unknown bot or route |
| 409 | `ambiguous` | More than one bot has that name; use the id |

## Addressing bots

Every `:bot` path segment takes a bot id or the bot's exact name (case-insensitive). URL-encode names with spaces.

## Endpoints

### GET /status

```json
{ "ok": true, "app": "Sub8", "version": "0.3.43", "api": 1,
  "bots": { "total": 3, "idle": 2, "working": 1, "paused": 0, "error": 0 } }
```

### GET /bots

```json
{ "ok": true, "bots": [ {
  "id": "5f0c...", "name": "Scout", "description": "",
  "provider": "claude", "model": "opus", "location": "local",
  "status": "working",
  "turn": { "request": "Find flights to Lisbon", "requestAt": 1760300000000, "doing": "Opened google.com/flights" },
  "lastReply": { "id": "a1760...", "text": "Done. Three options...", "ts": 1760290000000 },
  "teamId": null, "updatedAt": 1760300004000
} ] }
```

`status` is one of:

- `idle`: ready for a message
- `working`: a turn is running (`turn` describes it)
- `paused`: the bot's computer is paused, or its harness hit a usage limit
- `error`: the bot's computer reported an error

### GET /bots/:bot

The same summary plus `recent`, the last 10 chat messages.

### GET /bots/:bot/messages?since=&limit=&activity=

Chat messages oldest first. `since` is a millisecond timestamp (exclusive), `limit` defaults to 50 (max 500, most recent kept), `activity=1` also includes tool and thinking rows.

```json
{ "ok": true, "botId": "5f0c...", "hasMore": false, "messages": [
  { "id": "u1760...", "role": "user", "text": "Find flights to Lisbon", "ts": 1760300000000 },
  { "id": "a1760...", "role": "assistant", "text": "Here are three...", "ts": 1760300090000 }
] }
```

Assistant rows can carry `kind` (`choices`, `secret-request`, `notice`), and `choices` rows list `{id, label}` options. Choices and secret requests are answered in the app.

### POST /bots/:bot/messages

Body: `{ "text": "...", "wait": false, "timeoutMs": 120000 }`

```json
{ "ok": true, "botId": "5f0c...", "messageId": "u1760...", "ts": 1760300000000, "delivery": "started" }
```

`delivery` is `started` (a new turn) or `steered` (the bot was busy; the message went into the running turn). With `"wait": true` the response also carries `wait`, the same object `POST /wait` returns.

### POST /bots/:bot/wait?timeoutMs=&since=

Long-poll until the bot is idle and has replied after `since` (default: the latest user message), or until it has been idle for a few seconds without replying, or until `timeoutMs` (default 120000, max 600000). `GET` works too.

```json
{ "ok": true, "botId": "5f0c...", "done": true, "timedOut": false, "status": "idle",
  "reply": { "id": "a1760...", "role": "assistant", "text": "Here are three...", "ts": 1760300090000 },
  "replies": [ ... ] }
```

On timeout: `"done": false, "timedOut": true` with the current `status`.

### POST /bots/:bot/stop

Stops the running turn, like the Stop button.

```json
{ "ok": true, "botId": "5f0c...", "stopped": true }
```

`stopped` is false when nothing was running.

### GET /events?bot=

Server-sent events. `bot` (an id) limits the stream to one bot.

```
event: hello
data: {"ts":1760300000000,"version":"0.3.43"}

event: status
data: {"botId":"5f0c...","status":"working","ts":1760300000100}

event: message
data: {"botId":"5f0c...","message":{"id":"a1760...","role":"assistant","text":"Done.","ts":1760300090000}}
```

`status` events fire when a bot's status changes and may include a `bot` summary. `message` events carry new user and assistant chat rows. A comment line is sent every 15 seconds as a keepalive.

## Examples

```sh
FILE="$HOME/Library/Application Support/Sub8/data/control.json"
TOKEN=$(node -p 'require(process.argv[1]).token' "$FILE")
API=$(node -p 'require(process.argv[1]).url' "$FILE")

curl -s -H "Authorization: Bearer $TOKEN" "$API/bots"
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Summarize the open tabs","wait":true,"timeoutMs":300000}' "$API/bots/Scout/messages"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/bots/Scout/stop"
curl -sN -H "Authorization: Bearer $TOKEN" "$API/events"
```

## sub8ctl

`bin/sub8ctl.mjs` is a dependency-free Node client. In the installed app it is at `/Applications/Sub8.app/Contents/Resources/app.asar.unpacked/bin/sub8ctl.mjs`; Settings > Control API shows the exact path. From a source checkout, `npm link` puts `sub8ctl` on the PATH.

```sh
sub8ctl status
sub8ctl bots
sub8ctl show Scout
sub8ctl send Scout "Check the build and report back" --wait --timeout 600
sub8ctl stop Scout
sub8ctl tail Scout          # recent messages, then follows new ones
sub8ctl events [--bot Scout]
```

`--json` prints raw JSON. `--file <path>` or `SUB8_CONTROL_FILE` points at a different control.json. Exit codes: 0 ok, 1 error, 2 usage, 3 auth refused.

## MCP

`sub8ctl mcp` is a stdio MCP server with these tools: `list_bots`, `get_bot`, `read_messages`, `send_message` (optional `wait` and `timeout_seconds`), `wait_for_bot`, `stop_bot`.

Claude Code:

```sh
claude mcp add sub8 -- node "/Applications/Sub8.app/Contents/Resources/app.asar.unpacked/bin/sub8ctl.mjs" mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.sub8]
command = "node"
args = ["/Applications/Sub8.app/Contents/Resources/app.asar.unpacked/bin/sub8ctl.mjs", "mcp"]
```

This server is for harnesses outside Sub8. Bots inside Sub8 use their own built-in tools.
