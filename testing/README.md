# Sub8 testing suite

Automated testing + monitoring + safe self-healing for Sub8, in one repeatable,
idempotent run. It replaces the ad-hoc `tools/test-battery.mjs` (now a thin shim
that calls this suite) and keeps feeding the same dashboard.

```
node testing/suite.mjs                 # full run
node testing/suite.mjs --no-cloud-unit # skip the slow sub8-cloud npm-test lane
node testing/suite.mjs --no-heal       # detect only, never mutate anything
```

Pure Node ESM, no dependencies. Safe to run unattended every ~10 minutes: every
check is read-only except one narrowly-scoped, idempotent healer (below), and
network/tooling outages record `SKIP`, never a false `FAIL`.

**Do not run the suite while a build is in flight.** `server/`, `web/` and
`electron/` are TypeScript, and `tsc -b` emits the `.mjs`/`.js` *in place*, next
to each source. Tests import those emitted files, so a `tsc -b --force` running
concurrently rewrites a module mid-import and the test fails for reasons that
have nothing to do with the code. `test/mcp-desk.mjs` failed twice this way
during the TypeScript conversion and passes 12-for-12 under pure concurrency —
the build, not the parallelism, was the variable. Let a build finish first.

## Architecture

```
testing/
  suite.mjs            runner: runs lanes, heals/flags, writes results, prints
                       summary, ALERTS on any real FAIL
  lib/
    util.mjs           http/exec/wrangler/stripe/DO helpers; loads secrets from
                       sub8-cloud/.env WITHOUT ever printing their values
    report.mjs         Reporter: battery JSON (rolling history ~300) + heal log
    alert.mjs          fire a PushNotification-style alert on a real FAIL
  checks/
    cloud-unit.mjs     runs `npm test` in sub8-cloud, one row per PASS/FAIL
    cloud.mjs          live prod auth gating, stripe webhook, payment catalog
    local.mjs          local app health + running-bot↔container drift + GUI-PATH
    docker.mjs         dockerStatus + planDockerInstall cases + resolveDockerHost
    prompts.mjs        behavior rules in the shipped system prompt + freeze fix
    latency.mjs        turn p50/p95 duration + error-rate SLOs from turnlog telemetry
    fleet.mjs          DigitalOcean droplets ↔ D1 computers reconciliation
  heal/
    healers.mjs        safe self-heal (mark stale warm 'destroying') + flaggers
```

## Lanes — what each checks

**cloud-unit** — runs the sub8-cloud unit suite (`npm test`) and records one row
per `PASS`/`FAIL` line. Same suite that runs in the cloud repo's CI.

**cloud** (live prod against `https://sub8.bot`):
- prod worker health (`/api/health` → 200)
- auth gating: `/api/billing/{admin-free,grant-credit,promo}`, `/api/admin/overview`,
  `/api/computers` (create), and the mobile `/api/brain/desk-action` proxy all
  reject unauthenticated calls (401/403)
- Stripe webhook rejects an unsigned body and a bad-signature body (both 400)
- payment catalog: every one of the 5 SKUs (`vm.1g`…`vm.16g`) has an active
  Stripe Price whose `unit_amount` matches the catalog (test vs live mode auto-
  detected from the key). `SKIP` if `STRIPE_SECRET_KEY` isn't configured.

**local** (the desktop app on this machine, `http://127.0.0.1:8901`):
- app health (`/api/health`), `/api/ready`, `/api/docker` status shape
- **drift reconcile**: every bot the app reports `running` must map to a real
  `docker ps` container (`localbot-<id8>`); a running bot with no live container
  is flagged
- **GUI-launch regression**: docker detection must still find the CLI under a
  stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`, what a Finder-launched app gets)
- If the app is closed, these record `SKIP` (the stripped-PATH check still runs).

**docker** (`server/vm.mjs` logic):
- `dockerStatus()` resolves to a well-formed status on this machine
- `planDockerInstall` cases: bare CLI → install an engine (not "recover"),
  CLI + Docker Desktop/Colima → "recover", running daemon → "noop",
  linux bare → engine-get-docker, windows bare + winget → winget-desktop
- `resolveDockerHost()` returns a sane host (never forces a dead socket)

**prompts** (regression guards on the shipped prompt):
- the behavior rules are present in `sub8-cloud/src/desk-system-source.mjs`:
  captcha "try it, don't bail", chief/orchestrator delegation, act-don't-announce,
  two-computers boundary, never-type-a-password
- the freeze fix (`intentNudges`) is still in the `brain.mjs` turn loop

**fleet** (DigitalOcean ↔ D1 reconciliation, read-only):
- (a) stale warm/warming desks with no ipv4 older than 15 min — auto-healable
- (b) orphan droplets: live on DigitalOcean with **no** D1 row — flagged, with
  droplet ids + estimated `$/mo`
- (c) warm desks still waiting for an IP (any age) — informational
- Needs `DIGITALOCEAN_TOKEN` + wrangler D1 access; records `SKIP` if unavailable.

**latency** (turn-duration + error-rate SLOs from the cloud turn telemetry):
- reads the `{"turnlog":{...}}` lines the brain emits (`sub8-cloud/src/brain.mjs
  logTurn` — `ms`, `outcome`, `llmCalls`, tokens, `tools`, `reply`, …), the same
  telemetry `analyze-turns` and the dashboard consume
- sources: `SUB8_DASH_TURNLOG` (comma-separated list of files, same var the
  dashboard uses) if set, else the default `data/turnlog.jsonl` if it exists
- over the recent window (last `SUB8_LAT_WINDOW` turns, default 200) records:
  - **p50 turn duration** — informational, always `PASS`, metric in the detail
  - **p95 turn duration** — `FAIL` only if it exceeds `SUB8_LAT_P95_CAP_MS`
    (default 120000ms / 120s)
  - **turn error-rate** — share of turns whose `outcome` is error-ish (`error`,
    `failed`, `timeout`, `aborted`, `crash`; the happy paths are `done` /
    `executor`). `FAIL` only if it exceeds `SUB8_LAT_ERR_MAX` (default 0.25 = 25%)
- if no turnlog source exists, or a source has zero turnlog lines, every check
  records `SKIP` (never `FAIL`) so an unwired-telemetry run stays green.
- when a turnlog **is** present, p95 over cap is a real `FAIL` and the suite
  exits non-zero (`node test/latency.mjs` locks this).

## Alerting on failure

When (and only when) a run has at least one **real** `FAIL` (status `FAIL`, not
`FLAG` or `SKIP`), `suite.mjs` fires a PushNotification-style alert via
`lib/alert.mjs`. Green runs, and runs with only `FLAG`/`SKIP` rows, stay silent —
so an unattended 10-minute cron never pages on non-failures.

The suite is a plain Node script (no PushNotification tool here), so the alert is:
1. **always** — one JSON line appended to `data/test-alerts.jsonl` (a durable
   trail: `{at, kind, failed, counts, summary, fails:[{tid,lane,reply}]}`)
2. **if `SUB8_ALERT_CMD` is set** — that command is exec'd (`sh -c`) with a
   one-line human summary as its `$1` argument, the full alert JSON on stdin, and
   also in the `SUB8_ALERT_JSON` env var. Wire it to anything: Pushover, ntfy, a
   Slack webhook `curl`, `terminal-notifier`, an SMS gateway, etc. A failing
   alert command is logged, never fatal — it can't change the run's exit code.

## Auto-healed vs flagged-for-approval

**Auto-healed** (executed, idempotent, logged):
- **stale IP-less warm desks** → marked `destroying` in D1. The worker's own cron
  (`retryDestroys`) then performs the actual DigitalOcean destroy on its schedule.
  Mirrors `computers.reapStaleWarm`. Idempotent: the `WHERE` clause only matches
  rows still stuck, so re-running is a no-op. Disable with `--no-heal`.

**Flagged for approval** (detected + logged, never executed — these are gated):
- orphan droplets (destroying a droplet directly)
- local running-bot ↔ container drift (rebuilding/recovering a desk)
- anything involving deploys

Every heal entry is `{action, target, done|flagged, detail}` and is appended to
`data/test-heal-log.jsonl`.

## How it feeds the dashboard

`report.write()` merges the run into `data/test-battery.json` (rolling history
capped at ~300) in the exact schema `tools/test-dashboard.mjs` already reads:
`{ results: [{status, tid, lane, at, secs, reply}], pending: {}, updatedAt }`.
Set `SUB8_DASH_BATTERY` to redirect the output path. Statuses: `PASS`, `FAIL`,
`FLAG` (needs approval), `SKIP` (unavailable).

## Exit code

Non-zero **only** when there is a real `FAIL`. `FLAG` (needs approval) and `SKIP`
(unavailable) never fail the run, so an unattended 10-minute cron stays green
while still surfacing orphans and drift on the dashboard.
