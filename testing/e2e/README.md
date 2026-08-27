# E2E tests

HTTP scenarios against a throwaway Sub8 server. Each run starts
`node server/index.mjs` on a free `127.0.0.1` port with `SUB8BOT_DATA` set to a
temp directory, so it never touches `./data` or the packaged app's userData.

```bash
node testing/e2e/run.mjs
```

Scenarios in `scenarios/*.mjs` (`run({ client, skip })`):

- `health` — `GET /api/health` → 200 on a temp server
- `channels-http` — `POST /api/channels` then `GET` list (no Docker)
- `delivery-helper` — in-process `assertUserTurnDelivery` (always runs)
- `code-agent-no-stripe` — in-process `launchCodeAgent` on a fake vm; no `computers.json` row
- `docker-desk` — SKIP (not a failure) if Docker is down or no `localbot-*` is running
