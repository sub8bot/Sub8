# Orchestration

Sub8’s local desktop and Cloud desk share one orchestration contract. This page is the public map (aliases, paths, rooms vs teams). It does **not** dump the grok-bot system prompt.

The long technical dump lives at [`grok-bot-orchestration.md`](../grok-bot-orchestration.md) in the repo root. That file is a **spec dump** of the Grok Bot / Cursor layout (agents, channels, wakes, tools). It may be untracked; treat it as the source notes, not shipping product copy.

Workspace layout: [workspace.md](workspace.md). Shared types: [`packages/orchestration`](../packages/orchestration).

## Shared packages

Local Electron and the Cloud droplet must not grow two copies of tool names, `agent-data` paths, channel `group.json`, or code-agent session types.

| Piece | Where |
|---|---|
| `@sub8/orchestration` | `bot/packages/orchestration` (public) |
| Cloud copy | `sub8-cloud/vendor/orchestration` via `scripts/sync-orchestration.mjs` |

A Cloudflare Worker cannot `import` this repo at deploy time, so Cloud **vendors** the built `dist/`. Billing, provisioner, and secrets stay in the private cloud repo.

Canonical MCP names stay snake_case (`send_message`, `cloud_agent`, …). Spec names are aliases in the same handler — do not rename overnight.

## Path map

Spec paths under `/home/box` map onto the Sub8 desk at `/config`. Do not rebase the container to `/home/box`. User-facing language is “my computer”, never “box”.

| Spec | Sub8 |
|---|---|
| `/home/box` | `/config` |
| `/home/box/agent-data` | `/config/agent-data` (`AGENT_DATA_ROOT`) |
| `/workspace` | `/config/workspace` |

Code-agent `cwd` must stay under `/config` (same disk as Shell). Solo agents and channels are folders under `/config/agent-data/agents/<uuid>/`. A folder with `group.json` is a channel.

## Tool aliases

Source of truth: `TOOL_ALIASES` in `packages/orchestration/src/tools.ts` (MCP repeats the same map in `server/mcp-sub8.mjs`).

| Spec | Sub8 (keep) | Notes |
|---|---|---|
| `SendMessage` | `send_message` | Talk to the human. On a user turn: ack first; last `send_message` is the result. Ack ≠ delivery. |
| `CloudAgent` | `cloud_agent` | **IN-BOX** coding session on this same VM / same `/config`. `launch` / `list` / `get` / `reply` / `cancel` / `delete`. Not a second droplet, not a Stripe SKU, not billed per run. |
| `SendToAgent` | `message_teammate` | Peer or channel UUID. Fire-and-forget wake; do not poll. |
| `CreateAgent` | `create_teammate` | New teammate UUID + `profile.json` on the desk. |
| `CreateChannel` | `create_channel` | Room + `group.json`. HTTP `/api/channels` exists; MCP name is the alias target. |
| `UpdateChannel` | `update_channel` | Add/remove members. Max 6; refuse empty. |
| `Task` | `task` | In-process subagent on this desk (`server/subagents.mjs`). |
| `CheckSubagent` | `check_subagent` | List/get Task workers. |
| `MessageSubagent` | `message_subagent` | Wake a running Task. |
| `StopSubagent` | `stop_subagent` | Stop a Task. Does not destroy the desk. |
| `WebSearch` | `web_search` | Existing tool. |
| `WebFetch` | `web_fetch` | `@sub8/web-fetch`. Public HTTP only. |
| `Screenshot` | `computer` | `computer` action `screenshot`. |
| `RequestBoxHelp` | `request_box_help` | Ask the human to press **Take control** (`@sub8/control`). Login / 2FA / captcha / payment. Never host `/Users` — spec External* is out. |

`cloud_agent` is another way to talk to work already on the computer. Cursor-hosted VMs are out of scope.

## Channels vs teams

Keep both. They are not the same type.

| | Channel | Team |
|---|---|---|
| What | A **room** with a shared transcript | A **shared desk** plus the job bar |
| Store | Host `data/channels.json`; desk mirror `group.json` v1 | Host `data/teams.json`; chief / workers / `set_job` |
| Membership | UUID list, max 6, never empty | Screens on one computer (`maxBots` on the Cloud SKU) |
| Billing | Not a VM | One desk. Do not bill a channel as a computer |

Agents create/update rooms; deleting a channel is a user action.

## KV backend (tests)

Cloud tests that hammer KV can avoid Cloudflare rate limits with a sidecar droplet. **No secrets in this repo.**

- `KV_BACKEND=cloudflare` — default (Worker `wrangler.jsonc`)
- `KV_BACKEND=do` — HTTP store on droplet **`sub8-kv-store-DO-NOT-DELETE`** (desk reaper skips that name)

Tokens and URLs live in gitignored `.dev.vars` on the private cloud checkout. Prod stays Cloudflare until you change it on purpose.

## Experiments

Do **not** `git push`, `wrangler deploy`, or `gh release` from orchestration work. Local `git commit` is fine. Do not bake tokens into snapshots.

## This Mac vs Cloud

- **This Mac** needs no Sub8 account. Local Docker / Colima desks are free and stay on the machine.
- **Cloud** is sign-in plus a paid/entitled desk. `POST /api/computers` returns **402 `NEED_BILLING`** when `used >= entitledQty`. Code-agent launch on an already-attached desk must not create a second computer or a Stripe call.

### `past_due` (keep current)

Stripe `past_due` still counts as entitled (`active|trialing|past_due`). Do not suspend desks on `past_due` unless that is an explicit billing task with a webhook test. `canceled` / `unpaid` / missing sub → entitled 0 → next attach 402.

## Mobile

`sub8-cloud/mobile` is a **viewer** of the same Cloud Worker store (computers, team, thread, chat, Take control). It does not run a second agent loop, grok-build, or local LLM.

## Desk snapshot

Rebuilding the golden desk image: `sub8-cloud/docs/rebuild-desk-snapshot.md`. Do **not** bake `XAI_API_KEY`, Stripe, vault, or `.dev.vars` into the snapshot. `DESK_HARNESS` stays off on prod `wrangler.jsonc`.
