# Desk Host Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Do not start this plan until the operator says to.** This file is the spec. It is not a license to provision droplets, pack paying customers, or retag `sub8-desk:trixie`.
>
> **Context survival:** Read **Notes before implementation** before any task. After each task (and each gate), append to **Notes after implementation**. Never delete the before-notes. Compacted sessions start here, not from chat.

**Goal:** Make a Sub8 desk a portable Docker container plus a named `/config` volume, so the same `docker run` works on this Mac and on a cloud Docker host, then (later) pack many hard-limited customer desks onto a fleet of hosts and bill RAM + disk reservations.

**Architecture:** Three contract packages with no secrets, no Stripe, and no DigitalOcean. `@sub8/desk-runtime` builds the `docker run` argv. `@sub8/desk-images` snapshots and restores named volumes through an injected runner. `@sub8/desk-place` bin-packs reservations onto host capacity. The desktop server and the Cloud Worker both consume those packages. Provisioning hosts, billing, and tokens stay in `cloud/`.

**Tech Stack:** existing monorepo (`packages/*` strict TypeScript, `node --test`, Express `:8787`, Cloudflare Worker + D1, DigitalOcean droplets, Docker named volumes). No new runtime dependencies in the packages.

## Global Constraints

- `packages/` rule 6, copied verbatim: **No secrets, no billing, no provisioner.** Those stay in `cloud/`. `packages/` is the contract layer both sides agree on.
- Packages follow `packages/README.md`: extend `tsconfig.base.json`, `composite: true`, `tsBuildInfoFile` under `node_modules/.cache/sub8-tsbuildinfo/<name>.tsbuildinfo`, tests are `packages/<name>/test/*.test.mjs` importing `../dist/index.js`, `dependencies` empty except other `@sub8/*`.
- Image tag `sub8-desk:trixie` (`SLIM_IMAGE` in `server/vm.mts`) is the golden empty webtop. Never retag it with a customer's disk. Customer state is a named volume mounted at `/config`.
- `docker commit` is not a backup. Volume data is not in the image.
- Chat threads and vault stay host-side (`@sub8/store`, `vault.enc`). Restoring a desk does not move conversations.
- Cloud bot ids stay `cloud-{computerId}` (`chiefBotId` in `cloud/src/cloud-team.ts`). Restore rewrites desk tokens; it does not rewrite bot identity.
- Local published ports stay loopback (`127.0.0.1`). Cloud packing of paying customers is forbidden until the Worker stream proxy (`STREAM_VIA_WORKER`) is on, so noVNC is not on a public `:3000`.
- Do not oversubscribe RAM or disk. CPU may oversubscribe 1.5×. One container must not be able to take 100% of a host: `--memory`, `--memory-swap` equal to memory, `--cpus`, `--pids-limit`, disk quota or block volume.
- Small SKUs (`vm.1g`, `vm.2g`, `vm.4g`) may pack onto shared hosts after Gate 3. `vm.8g` and `vm.16g` stay `dedicated: true` (one desk per host) until packing is proven on internal desks.
- Current DigitalOcean floor stays until packing ships: `createSizeForSku` returns `s-2vcpu-4gb` for everything except `vm.8g` / `vm.16g` because golden snapshots are 80 GB disk (`cloud/src/digitalocean.ts`).
- Do not run `npm run dev`. Do not kill node/Electron. Do not commit unless a task step says to. Do not push unless asked.
- After adding a workspace package, add `"@sub8/<name>": "file:packages/<name>"` to the **root** `package.json` dependencies and run `npm install` so electron-builder's lockfile has the entry (regression: `@sub8/identities` missing from the lockfile broke the 0.3.34 build).
- Cloud Worker cannot import `packages/` at deploy time. Any package the Worker needs must be added to `PACKAGES` in `cloud/scripts/sync-orchestration.mjs` and copied into `cloud/vendor/<name>`.
- Head is `1813683` (`Sub8 0.3.35 — freebots.lol from the title bar.`) at plan writing. Working tree was clean.

## Ship gates (do not skip)

| Gate | After tasks | What must be true before continuing |
|---|---|---|
| **1 — local image manager** | 1–7 | Operator can snapshot and restore a local desk volume from the Computers panel. Cloud provisioning unchanged. |
| **2 — identical docker run on a dedicated droplet** | 8–9 | Cloud `user_data` uses `deskRunArgs` and `-v <volume>:/config`. A local snapshot can be restored onto a **dedicated** droplet. Still one droplet per computer. |
| **3 — internal packing** | 10–12 | Bin-pack works in tests. One fat host can run two **internal** desks with cgroup caps. Paying customers still 1:1. |
| **4 — paying shared hosts** | 13 | `STREAM_VIA_WORKER=1` on prod. `vm.2g`/`vm.4g` may pack. `vm.8g`/`vm.16g` stay dedicated. |

## File map

| Path | Responsibility |
|---|---|
| `packages/desk-runtime/` | Pure `docker run` argv + `DeskLimits`. No `child_process`, no DO, no Stripe. |
| `packages/desk-images/` | Snapshot/restore/list of named volumes via an injected `run(argv)` function. |
| `packages/desk-place/` | Pure bin-pack: does this host have room for this reservation? |
| `server/vm.mts` | Local Docker I/O. `deskCreateArgs` becomes a thin wrapper around `deskRunArgs`. |
| `server/desk-images.mts` | Local catalog under `SUB8BOT_DATA/desk-images/`. Calls `@sub8/desk-images` with a real docker runner. |
| `server/index.mts` | HTTP for snapshot/restore. |
| `server/computers.mts` | Existing computer rows; snapshot is keyed by `computer.id` / `volume`. |
| `web/app.ts` | Computers panel: Snapshot / Restore / Delete image. |
| `cloud/src/billing/catalog.ts` | Add `diskGb`, `milliCpus`, `dedicated` on `Sku`. Still the only place dollars live. |
| `cloud/src/digitalocean.ts` | `deskUserData*` shell must `docker run` from `deskRunArgs(...).join(" ")` plus a named volume. |
| `cloud/src/desk-limits.ts` | Maps `Sku` → `DeskLimits` + `Reservation`. Billing-aware; not a package. |
| `cloud/src/hosts.ts` | D1 `desk_hosts` rows, warm host pool, `placeReservation`. Provisioner. |
| `cloud/migrations/0006_desk_hosts.sql` | Host fleet table. |
| `cloud/migrations/0007_computer_volume.sql` | `computers.host_id`, `volume_name`. |
| `cloud/scripts/sync-orchestration.mjs` | Vendor `desk-runtime` and `desk-place` (Worker generates argv / packs). Do **not** vendor `desk-images` (needs Docker). |
| `docs/vm-manager.md` | Append snapshot actions once Gate 1 ships. |

---

## Notes before implementation

Written 2026-08-31 after reading the tree at plan HEAD `1813683` (`Sub8 0.3.35`). These are facts about **shipping code**, not the desired end state. Do not “fix” this section as tasks land — append after-notes instead.

### How to use this section after a compact

1. The goal, gates, and tasks above are the spec.
2. This section is the map of what already exists, so you do not rediscover it by grepping cold.
3. **Notes after implementation** (end of this file) is the log of what you actually changed. If a before-note disagrees with an after-note, the after-note wins for current code.
4. Do not run `npm run dev`. Do not kill node/Electron. Do not commit unless a task step says to.

### Three runtimes, not one app

| Layer | Owns | Path |
|---|---|---|
| Desktop | UI, local bots, local Docker desks, vault, Mac chats | Electron + Express `:8787` (`server/`, `web/`, `packages/`) |
| Worker | Auth, Stripe, droplet lifecycle, cloud chats, desk tokens | `cloud/src/` on Cloudflare (D1 + KV). Private submodule. |
| Desk | Linux webtop + Chrome + harness | Docker tag `sub8-desk:trixie`. Local: Colima. Cloud: one container named `sub8-desk` on a DigitalOcean droplet. |

`packages/` is the contract both sides agree on: **no secrets, no billing, no provisioner** (`packages/README.md` rule 6). The Worker cannot import `packages/` at deploy time. `cloud/scripts/sync-orchestration.mjs` copies `dist/` into `cloud/vendor/<name>`.

**Vendored today:** only `orchestration` and `harness-protocol`. `orchestration` is vendored but has **no** `cloud/src` import in the current tree. `identities` README claims Cloud vendors it; that is false — Cloud has its own `cloud/src/identities.ts` and no `cloud/vendor/identities/`.

This plan must vendor `desk-runtime` (Task 8) and `desk-place` (Task 11). Do **not** vendor `desk-images` (needs Docker).

### Package scaffold (copy this, not folklore)

Copy `packages/constants/package.json` + `tsconfig.json`, not `@sub8/orchestration`’s root-dep story.

- `package.json`: `private`, `type: module`, `main`/`types`/`exports` pointing at `./dist`, `files: ["dist","src","README.md"]`, scripts `tsc` + `node --test test/*.test.mjs`, `devDependencies` only `typescript` + `@types/node`. `dependencies` empty except other `@sub8/*`.
- `tsconfig.json`: extends `../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`, `composite: true`, `tsBuildInfoFile: ../../node_modules/.cache/sub8-tsbuildinfo/<name>.tsbuildinfo`.
- Tests import `../dist/index.js`.
- After adding a package: `{ "path": "./packages/<name>" }` in root `tsconfig.json` **and** `"@sub8/<name>": "file:packages/<name>"` in **root** `package.json` dependencies, then `npm install`. Regression: `@sub8/identities` missing from the lockfile broke the 0.3.34 electron-builder. `@sub8/orchestration` is in workspaces + tsconfig but **not** in root `dependencies` — do not copy that omission.

Root `package.json` already has file: deps for: automations, choice, constants, control, desk-ports, harness-auth, harness-protocol, identities, shell-exec, skills, store, wakes, web-fetch. Workspaces: `packages/*`.

### Two different things named “computer”

**Local** (`data/computers.json`, `server/computers.mts`):

```ts
// Computer id is a UUID. Container/volume names use first 8 chars.
containerForId(id) => `localbot-${id.slice(0,8)}`
volumeForId(id)    => `localbot-config-${id.slice(0,8)}`
```

A bot points at a computer via `bot.vm.computerId` (cached `container`/`volume`/`novncPort`). Detach keeps the disk. Destroy wipes the volume. Legacy rows still use the old **bot-id** prefix (`docs/vm-manager.md`: migrate on first load, do not recreate running boxes). `sweepOrphans` keeps anything in `computers.json`, not only bot-owned desks.

Computers panel (`web/app.ts`, search `Keep the computer`): Pause / Resume / Start / Stop / Destroy / Attach / Detach. **No Snapshot / Restore UI today.** HTTP: `GET /api/computers`, `POST /api/computers/:id/{pause,resume,reboot,start,stop,destroy,detach,attach}`, pause-all / resume-quit. Session-gated like other computer routes.

**Cloud** (D1 `cloud/migrations/0004_computers.sql`): id `cmp_` + 12 hex (`newId` in `cloud/src/computers.ts`). Comment on the table: “One droplet per row.” Columns: `user_id`, `sku`, `provider_id`, `external_id`, `ipv4`, `status`, `stream_url`, `error`, `stripe_sub_id`, timestamps. **No `host_id`. No `volume_name`.** `0005` only adds `attach_lock`. Status machine: `warming` → `warm` (pool) / `attaching` → `assigned` (paying) / `destroying` / `dead`.

`createComputer` inserts one D1 row then one `createDroplet`. Droplet name `sub8-${sku without dot}-${id.slice(-6)}`. Warm pool (`WARM_POOL_TARGET` default `"2"` in `cloud/wrangler.jsonc`, cron `*/10`) mints **whole desks** (`createComputer` with `pool: true`, default `vm.4g`), not empty Docker hosts. Task 12’s `WARM_HOST_TARGET` is a different object.

Cloud bot identity: `chiefBotId(computerId) => \`cloud-${computerId}\`` (`cloud/src/cloud-team.ts`). Workers: `cloud-${computerId}-${slug}`. Desktop mirror: `cloudBotId` in `server/account.mts`. Restore must **not** rewrite this id.

The Mac app already talks to cloud desks when Cloud is on: `server/cloud/index.mts` `liveComputers` / `liveCreateComputer` → Worker `/api/computers`. UI place: `web/cloud-place.mts` (`account.view === "cloud"`). Local `/api/computers` is a different registry. Do not merge those tables. Packaged Electron often defaults `SUB8_CLOUD=0` (`electron/main.mts`); the code path exists.

### The desk disk — the whole plan in one sentence

**Local already has a portable disk. Cloud does not.**

Local `deskCreateArgs` (`server/vm.mts` ~529–604) already:

- `docker volume create` then `-v <volume>:/config` (`startVm` ~2238–2242)
- `--memory` / `--memory-swap` equal, `--shm-size` from `deskShm()` (`LOCALBOT_SHM` or `256m`)
- loopback only: `127.0.0.1:${port}-${port+DISPLAY_SLOTS-1}:3000-${3000+DISPLAY_SLOTS-1}` and `127.0.0.1:${hport}:${HARNESS_PORT}`
- env: `PUID=1000`, `PGID=1000`, `TZ=America/New_York`, `TITLE=My Computer`, `SELKIES_MANUAL_WIDTH=1024`, `SELKIES_MANUAL_HEIGHT=768`, `DESK_HARNESS=1`
- extra: `--dns 8.8.8.8`, `--dns 1.1.1.1`, `--add-host host.docker.internal:host-gateway`, `--label ${INSTALL_LABEL}=${installId()}`
- `--platform` `linux/arm64` or `linux/amd64` via `dockerPlatform()`
- `--hostname computer`, `--restart unless-stopped`
- **no** `--cpus`, **no** `--pids-limit`, **no** `--privileged`
- **no** `docker commit` anywhere in `server/vm.mts`

`DISPLAY_SLOTS = 8` (`packages/desk-ports/src/ports.ts`). `HARNESS_PORT = 3011` (`packages/harness-protocol/src/constants.ts`; deliberately not 3010, the old pi executor). `harnessHostPort(novnc) = novnc + 8`.

Frozen by `test/desk.mjs`: memory/shm/swap, image last, `13109-13116:3000-3007`, `13117:3011`, every `-p` starts with `127.0.0.1:`, `DESK_HARNESS=1`, `host.docker.internal`. Also `test/display.mjs`, `test/desk-client.mjs`. Task 3 must keep every existing assertion and add `--cpus`, `--pids-limit`, and `-v <volume>:/config`.

Local default RAM: `deskMemory()` → `LOCALBOT_MEMORY` or `"2g"` solo; team scales `2+(n-1)` capped at `6g`. Not SKU-shaped. Task 3 maps `"2g"` → `limitsFromRamMb(2048)` then overlays `memory`/`memorySwap` so frozen tests still match. If `LOCALBOT_MEMORY` is a value the rungs would not produce, overlay onto the 2 GB rung — do not invent a parser.

**Cloud `docker run` has no `-v`.** Both `deskUserData` and `deskUserDataFromSnapshot` (`cloud/src/digitalocean.ts` ~337–343 and ~446–452):

```
docker run -d --name sub8-desk --restart unless-stopped \
  --platform linux/amd64 \
  --hostname computer \
  --shm-size 256m --memory ${mem} --memory-swap ${mem} \
  -e TITLE=Sub8 -e TZ=UTC [-e RFB_EXPOSE=1] \
  ${dockerPortFlags(rfbExpose)} \
  sub8-desk:trixie
```

`/config` is the container writable layer. `vm/Dockerfile` sets `HOME=/config` and has **no `VOLUME` directive**. Persistence is “the droplet disk,” not a named volume. Snapshot boot does `docker rm -f sub8-desk` then a fresh run — it **throws away** container writable-layer state on purpose (comment at `digitalocean.ts` ~443–445). There is `docker cp … sub8-desk:/config/…` for executor logs, which proves `/config` exists inside the image, not that it is a volume.

`dockerPortFlags` (`digitalocean.ts` ~283–286): always `-p 3000:3000 -p 3002:3001 -p 3003:3002 … -p 3008:3007` (host 3001 skipped). When `rfbExpose`: also `-p 5900:5900` … `-p 5907:5907`. No bind address ⇒ Docker publishes on **`0.0.0.0` (public on the droplet)**. `deskRunArgs` `hostWebPorts()` must copy this skip, not invent a clean `3000-3007` map. Do not push RFB twice (the sketch in Task 2 had a dead `rfb` local; the `else` branch already adds RFB when `rfbExpose`).

There is **no** local volume snapshot/restore in shipping code (no `snapshotVolume`, no Computers “Snapshot disk”). Cloud “restore” today means boot another empty desk from the golden **droplet** snapshot. Customer-portable `/config` tarball is this plan, not current code.

### Three different things people call “image”

1. **Docker tag** `sub8-desk:trixie` (`SLIM_IMAGE` in `server/vm.mts:369`). Golden empty webtop. Local build from `vm/Dockerfile`. Cloud from-scratch path `docker build -t sub8-desk:trixie`. Fallback local image `linuxserver/webtop:ubuntu-xfce`. **Never retag this with a customer Chrome profile.**
2. **DigitalOcean droplet snapshot** (`DIGITALOCEAN_IMAGE` in wrangler). ~80 GB golden *host*: Docker installed, `sub8-desk:trixie` pulled, harness rsynced to `/opt/sub8-harness` by `cloud/scripts/rebuild-desk-snapshot.mjs`. This is why `createSizeForSku` floors `vm.1g`/`vm.2g`/`vm.4g` onto `s-2vcpu-4gb` (`digitalocean.ts` ~215–231): small DO sizes are 25/50 GB disk and DO 422s “Cannot create a droplet with a smaller disk than the image.” From-scratch 1 GB also OOMs during docker build. `vm.8g` → `s-4vcpu-8gb`, `vm.16g` → `s-8vcpu-16gb`. `sizeForSku` still has the true small sizes; `createSizeForSku` is what `createComputer` uses. **Do not change `createSizeForSku` in Task 8.**
3. **Customer disk** — local named volume `localbot-config-<id8>`. Does not exist in cloud yet. That is what `@sub8/desk-images` tars. Planned cloud name: `sub8-config-${computerId}`.

### Memory overlay — do not put this in the package

Cloud `deskUserData*` today (`digitalocean.ts` ~317 and ~433):

| SKU billed | Catalog `ramMb` | Container `--memory` today |
|---|---|---|
| `vm.1g` | 1024 | `1g` |
| `vm.2g` | 2048 | `2g` |
| `vm.4g` | 4096 | **`3g`** |
| `vm.8g` | 8192 | **`6g`** |
| `vm.16g` | 16384 | **`12g`** |

12g is “OS ate 4g of a 16g VM.” Packed hosts reserve OS on the **host** (`HOST_RAM_RESERVE_MB = 2048` in `@sub8/desk-place`) and give the container the billed RAM. Dedicated droplets keep this historical overlay in `cloud/src/desk-limits.ts` as `limitsForSku(skuId, { dedicated })`, **not** in `@sub8/desk-runtime`. If you put 12g in the package, packed 16g desks become 12g forever.

Sku catalog (`cloud/src/billing/catalog.ts`): `id`, `name`, `ramMb`, `maxBots`, `unitAmountCents`, `highlight`, `blurb`. Dollars here are display/seed only; Stripe Prices are source of truth. Task 8 adds `diskGb`, `milliCpus`, `dedicated` **without changing prices**. Defaults in the task table. `dedicated` is ignored until Task 11.

### Ports, stream proxy, why Gate 4 is not optional

Local noVNC is loopback (`deskCreateArgs` comment: websockify has no auth; publishing `0.0.0.0` put click-and-type on the LAN). Cloud noVNC is public `:3000`. `STREAM_VIA_WORKER` is implemented (`cloud/src/desk-stream.ts` — Worker as websockify, raw TCP to x11vnc RFB) and **unset in `cloud/wrangler.jsonc`**. Docs: `docs/authenticated-desk-stream.md` — “half-landed, not active”; “Verified on a live desk: no.” Flag on also needs a snapshot rebuild for `RFB_EXPOSE` (`vm/desk-init.sh`). Turning the flag on is **not** this plan’s job; packing paying SKUs **requires** it to already be on.

`createComputer` sets `rfbExpose = STREAM_VIA_WORKER === "1"`. Flag off → `handleDeskStream` returns null; clients keep `http://<ipv4>:3000`.

Packing paying customers onto one public IP without the Worker relay would put several unauthenticated websockify fronts on one box. Task 13 409s `PACK_SHARED_HOSTS=1` for non-admins unless `STREAM_VIA_WORKER=1`. Packed publish must not be `0.0.0.0:3000`.

### Tokens — two secrets, do not mix them

| Credential | Issued | Stored | Purpose |
|---|---|---|---|
| Local internal / MCP | Desktop boot (`server/index.mts` `loadOrCreateInternalToken`) | `data/internal-token`; env `SUB8_INTERNAL_TOKEN`; **also written into the local container as `/config/.desk-token`** plus grok MCP toml (`server/vm.mts` ~2744) | In-desk MCP → host `:8787` (`SUB8_INTERNAL_URL`) |
| Cloud desk-token | Worker on provision (`createComputer`) | KV `desk:<computerId>`; droplet `/var/lib/sub8/desk-token` | Worker ↔ droplet harness/agent Bearer |

Cloud user_data already rewrites `/var/lib/sub8/desk-token`. Harness on droplet: `DESK_TOKEN` or that file (`server/desk-harness/server.mts`). Synthetic loopback bot in snapshot path (`deskHarnessBotsShell`) embeds the token into `${HARNESS_DIR}/data/bots.json` as `desk-local`.

Task 9: rewrite the cloud desk-token on restore. **Do not** scp the local MCP/`/config/.desk-token` onto a public droplet. A volume tarball from a local desk may contain that file — restore onto cloud must not leave it as a live credential.

### What lives where (restore must not move the wrong layer)

| Layer | Location | Contents |
|---|---|---|
| Host `dataDir` | `SUB8BOT_DATA` / `data/` | `bots.json`, `computers.json`, `conversations/`, `settings.json`, `identities.json`, `vault.enc`, `.vault.key`, screens, traces |
| Docker named volume | `/config` in the webtop | Linux home, Chrome profile, `/config/agent-data` (`AGENT_DATA_ROOT` in `@sub8/orchestration`), workspace, possibly `.desk-token` |
| D1 | Worker | `computers` (+ events), users, providers, billing — not chat blobs |
| KV / DO | Worker | `desk:<id>` token; `chat:<userId>:<computerId>[:botId]`; routines; team keys; turn queue |

Chat threads and vault stay host-side (`@sub8/store`, `vault.enc`). Cloud chats live in Worker KV (`cloud/src/brain.ts` `chat:` keys), not in the volume and not in Mac `conversations/`. Restoring a desk does not move conversations.

### How a cloud turn reaches the box (so you do not “simplify” it)

`POST /brain/chat` → Durable Object `DeskTurn` → `finishChat` → if harness healthy, `harnessTurn` POSTs `http://{ipv4}:3011/turn` (fallback `cloudflare:sockets`). Parallel: `/brain/desk-action` → droplet `:80` desk-agent (Python, inlined as `DESK_AGENT_SOURCE`) which `docker exec`s into `sub8-desk`. Executor (pi, `:3010`) is a separate systemd unit on the droplet.

Harness bundle (~ `server/*.mjs` the harness + mcp-sub8 need) is **rsynced into the golden snapshot** (`rebuild-desk-snapshot.mjs`), not imported as a package at droplet boot. `user_data` has a 64 KB limit; the bundle does not go in the cloud-init script. From-scratch `deskUserData` still clones GitHub and `docker build`s; snapshot path assumes image + agent + executor already on disk.

Local turns never leave the Mac: `server/agent.mts` → `server/vm.mts` docker exec / screenshot.

Same Docker tag, two control planes. The new packages exist so **argv and packing math** can be identical without dragging DO/Stripe into `packages/` or Docker into the Worker.

### Pause / stop / destroy (Gate 1 snapshot must use the right one)

| Action | Docker | Volume |
|---|---|---|
| Pause | `docker pause` | kept |
| Resume | `docker unpause` | kept |
| Stop (panel) | `stop` then `rm -f` container | **kept** |
| Destroy | `rm -f` + `volume rm -f` | **gone** |
| Quit | pause-all, `pausedByQuit: true` | kept |

`performSnapshot` (Task 6): pause (or stop) then tar, unpause in `finally`. `performRestore`: **stop** (not pause) — overlaying `/config` under a live Chrome is corruption — then `restoreVolume`, start. Never snapshot the golden image. Never `docker commit`. Docker missing → API `503 { error: "Docker is not running." }`, do not hang.

### Exact local argv order (Task 2/3 must not reshuffle without tests)

```
run -d
  --platform <linux/arm64|linux/amd64>
  --name <name>
  --hostname computer
  --restart unless-stopped
  --dns 8.8.8.8 --dns 1.1.1.1
  --shm-size <deskShm()>
  --memory <deskMemory()>
  --memory-swap <same>
  -e PUID=1000 -e PGID=1000 -e TZ=America/New_York
  -e TITLE=My Computer
  -e SELKIES_MANUAL_WIDTH=1024 -e SELKIES_MANUAL_HEIGHT=768
  -e DESK_HARNESS=1
  --add-host host.docker.internal:host-gateway
  --label sub8.install=<sha16 of dataDir>
  -v <volume>:/config
  -p 127.0.0.1:<port>-<port+7>:3000-3007
  -p 127.0.0.1:<harnessPort|port+8>:3011
  <image>
```

Task 2’s `deskRunArgs` puts cgroup flags before `extraArgs`/`env`/`-v`/`-p`. Local wrapper puts dns/label/add-host in `extraArgs`. Tests check membership and `-p` loopback, not full array equality — except desk-images snapshot argv, which Task 4 tightens to `assert.deepEqual` on the exact tar array.

### What is already true vs what this plan adds

**Already true:** local named `/config` volume; loopback publish; `sub8-desk:trixie` as golden empty; Computer ≠ Bot locally; cloud 1:1 droplets; container `--memory` caps (with dedicated overlay); warm *desk* pool; Worker stream proxy code sitting dark; Mac Cloud client; `HARNESS_PORT` vendored.

**Not true yet:** shared `deskRunArgs`; `--cpus` / `--pids-limit`; cloud named volume; volume tar snapshot/restore; Computers Snapshot UI; D1 `desk_hosts`; bin-pack; `PACK_SHARED_HOSTS`; warm **hosts** that do not already run a customer container; SKU `dedicated` / `diskGb` / `milliCpus`.

### Landmines (do not rediscover these)

- `ExactOptionalPropertyTypes` is on. Do not pass `harnessPort: undefined` into `deskCreateArgs` / `deskRunArgs`.
- `deskCreateArgs` options are optional only so a bare call cannot throw; `name` and `port` are required in practice (`server/vm.mts` comment).
- First `-v` is the config volume. Task tests use `args[args.indexOf("-v") + 1]`. Do not insert another `-v` before it without updating tests.
- Adding cgroup flags only affects **new** `docker run`. Running containers keep create-time argv until stop+recreate.
- Cloud from-scratch user_data still has no `DESK_HARNESS=1` on the container; snapshot path enables via `/etc/sub8/desk-harness.env`. Do not “fix” that in this plan unless a task says to.
- `host.docker.internal:host-gateway` is a local Docker Desktop-ism. Do not blindly copy it onto droplets via `extraArgs`.
- Worker tests import `.ts` directly (`cloud/test/*`). Desktop tests import emitted `server/*.mjs` and `packages/*/dist/index.js`.
- After a workspace package: root `file:` dep + `npm install` + lockfile.
- Do not stream gigabyte tarballs through the Worker (Task 9). Prefer scp runbook in `docs/vm-manager.md` if R2 is not already in wrangler.

---

### Task 1: Scaffold `@sub8/desk-runtime` with `DeskLimits`

**Files:**
- Create: `packages/desk-runtime/package.json`
- Create: `packages/desk-runtime/tsconfig.json`
- Create: `packages/desk-runtime/src/types.ts`
- Create: `packages/desk-runtime/src/limits.ts`
- Create: `packages/desk-runtime/src/index.ts`
- Create: `packages/desk-runtime/test/desk-runtime.test.mjs`
- Create: `packages/desk-runtime/README.md`
- Modify: `tsconfig.json` (add `{ "path": "./packages/desk-runtime" }` to `references`)
- Modify: `package.json` (root `dependencies`: `"@sub8/desk-runtime": "file:packages/desk-runtime"`)

**Interfaces:**
- Consumes: nothing
- Produces: `DeskLimits`, `limitsFromRamMb(ramMb: number): DeskLimits`

- [x] **Step 1: Write the failing test**

Create `packages/desk-runtime/test/desk-runtime.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { limitsFromRamMb } from "../dist/index.js";

test("1 GB desk is a 1g cgroup with a half CPU and a pid cap", () => {
  assert.deepEqual(limitsFromRamMb(1024), {
    memory: "1g",
    memorySwap: "1g",
    shm: "256m",
    cpus: "0.5",
    pids: 256,
  });
});

test("4 GB desk is the default dedicated webtop", () => {
  assert.deepEqual(limitsFromRamMb(4096), {
    memory: "4g",
    memorySwap: "4g",
    shm: "256m",
    cpus: "1.0",
    pids: 512,
  });
});

test("16 GB billed RAM is 16g on the container, not 12g", () => {
  // 12g was a dedicated-droplet leftover (OS ate 4g of a 16g VM).
  // Packed hosts reserve OS on the host, not by shrinking the SKU.
  assert.equal(limitsFromRamMb(16384).memory, "16g");
  assert.equal(limitsFromRamMb(16384).cpus, "4.0");
});

test("unknown RAM rounds down to the next known rung, never throws", () => {
  assert.equal(limitsFromRamMb(3000).memory, "2g");
  assert.equal(limitsFromRamMb(0).memory, "1g");
  assert.equal(limitsFromRamMb(-1).memory, "1g");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `(cd packages/desk-runtime && npx tsc && node --test test/desk-runtime.test.mjs)`
Expected: FAIL — package / `limitsFromRamMb` missing.

- [x] **Step 3: Write the package**

`package.json` — copy `packages/constants/package.json`, name `@sub8/desk-runtime`, description `Pure docker run argv and cgroup limits for a Sub8 desk. No Docker I/O, no provisioner.`

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "../../node_modules/.cache/sub8-tsbuildinfo/desk-runtime.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../desk-ports" }, { "path": "../harness-protocol" }]
}
```

`src/types.ts`:

```ts
export interface DeskLimits {
  memory: string;
  memorySwap: string;
  shm: string;
  cpus: string;
  pids: number;
}
```

`src/limits.ts` — rungs, highest `ramMb` ≤ input wins, else the 1 GB rung:

```ts
import type { DeskLimits } from "./types.js";

const RUNGS: ReadonlyArray<{ ramMb: number } & DeskLimits> = [
  { ramMb: 1024, memory: "1g", memorySwap: "1g", shm: "256m", cpus: "0.5", pids: 256 },
  { ramMb: 2048, memory: "2g", memorySwap: "2g", shm: "256m", cpus: "0.5", pids: 384 },
  { ramMb: 4096, memory: "4g", memorySwap: "4g", shm: "256m", cpus: "1.0", pids: 512 },
  { ramMb: 8192, memory: "8g", memorySwap: "8g", shm: "256m", cpus: "2.0", pids: 768 },
  { ramMb: 16384, memory: "16g", memorySwap: "16g", shm: "256m", cpus: "4.0", pids: 1024 },
];

export function limitsFromRamMb(ramMb: number): DeskLimits {
  const n = Number(ramMb);
  let picked = RUNGS[0]!;
  for (const rung of RUNGS) {
    if (Number.isFinite(n) && n >= rung.ramMb) picked = rung;
  }
  const { memory, memorySwap, shm, cpus, pids } = picked;
  return { memory, memorySwap, shm, cpus, pids };
}
```

`src/index.ts` exports types + `limitsFromRamMb` only for now.

README states what belongs (argv + limits) and what does not (docker spawn, DO, Stripe, volume tar).

- [x] **Step 4: Wire the workspace and run tests**

Add the tsconfig reference and root `file:` dependency. `npm install` at repo root. `npm run typecheck` and `node --test packages/desk-runtime/test/desk-runtime.test.mjs`.
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/desk-runtime tsconfig.json package.json package-lock.json
git commit -m "feat: add @sub8/desk-runtime cgroup limits."
```

---

### Task 2: `deskRunArgs` — loopback publish (local)

**Files:**
- Create: `packages/desk-runtime/src/run.ts`
- Modify: `packages/desk-runtime/src/types.ts`
- Modify: `packages/desk-runtime/src/index.ts`
- Modify: `packages/desk-runtime/test/desk-runtime.test.mjs`
- Modify: `packages/desk-runtime/package.json` (`dependencies`: `"@sub8/desk-ports": "*"`, `"@sub8/harness-protocol": "*"`)
- Modify: `packages/desk-runtime/tsconfig.json` (references already added in Task 1)

**Interfaces:**
- Consumes: `DeskLimits` from Task 1; `DISPLAY_SLOTS` from `@sub8/desk-ports`; `HARNESS_PORT` from `@sub8/harness-protocol`
- Produces: `DeskRunSpec`, `LoopbackPublish`, `deskRunArgs(spec: DeskRunSpec): string[]`

- [x] **Step 1: Write the failing test** (append)

```js
import { DISPLAY_SLOTS, HARNESS_PORT } from "@sub8/desk-ports";
import { deskRunArgs, limitsFromRamMb } from "../dist/index.js";

test("loopback run args mount /config, cap cgroups, and never bind 0.0.0.0", () => {
  const args = deskRunArgs({
    name: "localbot-deadbeef",
    volume: "localbot-config-deadbeef",
    image: "sub8-desk:trixie",
    platform: "linux/arm64",
    hostname: "computer",
    limits: limitsFromRamMb(2048),
    publish: { kind: "loopback", novncPort: 13109, harnessPort: 13109 + DISPLAY_SLOTS },
    env: ["PUID=1000", "PGID=1000", "TZ=America/New_York", "TITLE=My Computer", "DESK_HARNESS=1"],
    extraArgs: ["--dns", "8.8.8.8", "--dns", "1.1.1.1", "--add-host", "host.docker.internal:host-gateway"],
  });
  assert.equal(args[0], "run");
  assert.equal(args.at(-1), "sub8-desk:trixie");
  assert.equal(args[args.indexOf("--name") + 1], "localbot-deadbeef");
  assert.equal(args[args.indexOf("-v") + 1], "localbot-config-deadbeef:/config");
  assert.equal(args[args.indexOf("--memory") + 1], "2g");
  assert.equal(args[args.indexOf("--memory-swap") + 1], "2g");
  assert.equal(args[args.indexOf("--shm-size") + 1], "256m");
  assert.equal(args[args.indexOf("--cpus") + 1], "0.5");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "384");
  const ports = args.filter((_, i) => args[i - 1] === "-p");
  for (const p of ports) assert.ok(String(p).startsWith("127.0.0.1:"), p);
  assert.ok(ports.some((p) => p === `127.0.0.1:13109-${13109 + DISPLAY_SLOTS - 1}:3000-${3000 + DISPLAY_SLOTS - 1}`));
  assert.ok(ports.some((p) => p === `127.0.0.1:${13109 + DISPLAY_SLOTS}:${HARNESS_PORT}`));
  assert.ok(!args.includes("--privileged"));
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL — `deskRunArgs` is not exported.

- [x] **Step 3: Implement `deskRunArgs`**

```ts
import { DISPLAY_SLOTS } from "@sub8/desk-ports";
import { HARNESS_PORT } from "@sub8/harness-protocol";
import type { DeskLimits } from "./types.js";

export type LoopbackPublish = {
  kind: "loopback";
  novncPort: number;
  harnessPort: number;
};

export type HostPublish = {
  kind: "host";
  rfbExpose: boolean;
};

export type DeskPublish = LoopbackPublish | HostPublish;

export interface DeskRunSpec {
  name: string;
  volume: string;
  image: string;
  platform: string;
  hostname: string;
  limits: DeskLimits;
  publish: DeskPublish;
  env: readonly string[];
  extraArgs?: readonly string[];
  restart?: string;
}

function hostWebPorts(): string[] {
  // Matches today's cloud/src/digitalocean.ts dockerPortFlags (3001 skipped on the host).
  const web = ["-p", "3000:3000", "-p", "3002:3001", "-p", "3003:3002", "-p", "3004:3003", "-p", "3005:3004", "-p", "3006:3005", "-p", "3007:3006", "-p", "3008:3007"];
  const rfb = ["-p", "5900:5900", "-p", "5901:5901", "-p", "5902:5902", "-p", "5903:5903", "-p", "5904:5904", "-p", "5905:5905", "-p", "5906:5906", "-p", "5907:5907"];
  return web;
}

export function deskRunArgs(spec: DeskRunSpec): string[] {
  const restart = spec.restart || "unless-stopped";
  const args: string[] = [
    "run", "-d",
    "--platform", spec.platform,
    "--name", spec.name,
    "--hostname", spec.hostname,
    "--restart", restart,
    "--shm-size", spec.limits.shm,
    "--memory", spec.limits.memory,
    "--memory-swap", spec.limits.memorySwap,
    "--cpus", spec.limits.cpus,
    "--pids-limit", String(spec.limits.pids),
  ];
  if (spec.extraArgs) args.push(...spec.extraArgs);
  for (const e of spec.env) args.push("-e", e);
  args.push("-v", `${spec.volume}:/config`);
  if (spec.publish.kind === "loopback") {
    const p = spec.publish.novncPort;
    args.push("-p", `127.0.0.1:${p}-${p + DISPLAY_SLOTS - 1}:3000-${3000 + DISPLAY_SLOTS - 1}`);
    args.push("-p", `127.0.0.1:${spec.publish.harnessPort}:${HARNESS_PORT}`);
  } else {
    args.push(...hostWebPorts());
    if (spec.publish.rfbExpose) {
      args.push("-p", "5900:5900", "-p", "5901:5901", "-p", "5902:5902", "-p", "5903:5903", "-p", "5904:5904", "-p", "5905:5905", "-p", "5906:5906", "-p", "5907:5907");
    }
  }
  args.push(spec.image);
  return args;
}
```

Refactor `hostWebPorts` so RFB is only added when `rfbExpose` is true (do not push RFB twice). Export `DeskRunSpec` from `index.ts`.

- [x] **Step 4: Run tests**

Run: `node --test packages/desk-runtime/test/desk-runtime.test.mjs` after `npx tsc -b packages/desk-runtime`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/desk-runtime package-lock.json
git commit -m "feat: deskRunArgs builds local and host docker argv."
```

---

### Task 3: Local `deskCreateArgs` wraps `deskRunArgs` without changing ports

**Files:**
- Modify: `server/vm.mts` (`deskCreateArgs` around line 529)
- Modify: `test/desk.mjs` (keep every existing assertion; add `--cpus` and `--pids-limit` and `-v`)

**Interfaces:**
- Consumes: `deskRunArgs`, `limitsFromRamMb`, `DeskRunSpec`
- Produces: same `string[]` shape `test/desk.mjs` already asserts, plus the new cgroup flags

- [x] **Step 1: Extend `test/desk.mjs` so the new flags are required**

After the existing `--memory` assertions:

```js
assert.ok(args.includes("--cpus"));
assert.ok(args.includes("--pids-limit"));
assert.equal(args[args.indexOf("-v") + 1], "localbot-config-deadbeef:/config");
```

Keep the loopback bind loop, `DESK_HARNESS=1`, `host.docker.internal`, `13109-13116:3000-3007`, and `13117:3011` checks. They are the regression net.

- [x] **Step 2: Run `node test/desk.mjs` and confirm `--cpus` fails**

Expected: FAIL `args.includes("--cpus")`.

- [x] **Step 3: Rewrite `deskCreateArgs` as a wrapper**

Preserve today's env (`PUID`, `PGID`, `TZ`, `TITLE`, `SELKIES_MANUAL_WIDTH=1024`, `SELKIES_MANUAL_HEIGHT=768`, `DESK_HARNESS=1`), dns, label, add-host, and `deskMemory()` / `LOCALBOT_MEMORY`. Map memory string `"2g"` → `limitsFromRamMb(2048)` so tests that freeze `deskMemory()` still match `--memory`. If `LOCALBOT_MEMORY` is set to a value `limitsFromRamMb` would not produce, overlay `memory`/`memorySwap` onto the 2 GB rung instead of inventing a new parser.

```ts
import { deskRunArgs, limitsFromRamMb } from "@sub8/desk-runtime";

export function deskCreateArgs(opts = {}) {
  const { name, volume, port, image, harnessPort } = opts;
  const img = image || resolvedImage || SLIM_IMAGE;
  const mem = deskMemory();
  const ramMb = mem === "1g" ? 1024 : mem === "2g" ? 2048 : mem === "3g" ? 3072 : mem === "4g" ? 4096 : mem === "5g" ? 5120 : mem === "6g" ? 6144 : 2048;
  const limits = { ...limitsFromRamMb(ramMb), memory: mem, memorySwap: mem, shm: deskShm() };
  const hport = harnessPort || harnessHostPort(port);
  return deskRunArgs({
    name: name,
    volume: volume,
    image: img,
    platform: dockerPlatform(),
    hostname: "computer",
    limits,
    publish: { kind: "loopback", novncPort: port, harnessPort: hport },
    env: [
      "PUID=1000",
      "PGID=1000",
      "TZ=America/New_York",
      "TITLE=My Computer",
      "SELKIES_MANUAL_WIDTH=1024",
      "SELKIES_MANUAL_HEIGHT=768",
      "DESK_HARNESS=1",
    ],
    extraArgs: [
      "--dns", "8.8.8.8",
      "--dns", "1.1.1.1",
      "--add-host", "host.docker.internal:host-gateway",
      "--label", `${INSTALL_LABEL}=${installId()}`,
    ],
  });
}
```

ExactOptionalPropertyTypes: do not pass `harnessPort: undefined`. Only call `deskCreateArgs` with a real port.

- [x] **Step 4: Run tests**

Run: `node test/desk.mjs && node test/desk-client.mjs && node test/display.mjs && node test/vm-status.mjs`
Expected: PASS. `test/desk.mjs` still requires every `-p` value to start with `127.0.0.1:`.

- [x] **Step 5: Commit**

```bash
git add server/vm.mts test/desk.mjs
git commit -m "refactor: local deskCreateArgs delegates to @sub8/desk-runtime."
```

---

### Task 4: Scaffold `@sub8/desk-images` (injected docker, no real daemon)

**Files:**
- Create: `packages/desk-images/package.json`
- Create: `packages/desk-images/tsconfig.json`
- Create: `packages/desk-images/src/types.ts`
- Create: `packages/desk-images/src/argv.ts`
- Create: `packages/desk-images/src/index.ts`
- Create: `packages/desk-images/test/desk-images.test.mjs`
- Create: `packages/desk-images/README.md`
- Modify: `tsconfig.json`, root `package.json` (`file:packages/desk-images`), `npm install`

**Interfaces:**
- Consumes: nothing from Task 1 except the idea that the volume name is the disk
- Produces:
  - `DockerRun = (argv: string[]) => Promise<{ ok: boolean; out: string; err: string }>`
  - `snapshotArgs(volume: string, archiveAbs: string): string[]`
  - `restoreArgs(volume: string, archiveAbs: string): string[]`
  - `listVolumeArgs(): string[]`

- [x] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { snapshotArgs, restoreArgs } from "../dist/index.js";

test("snapshot tars a named volume into a host path; it does not docker commit", () => {
  const argv = snapshotArgs("localbot-config-deadbeef", "/tmp/desk.tgz");
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("--rm"));
  assert.ok(argv.includes("localbot-config-deadbeef:/from:ro"));
  assert.ok(argv.some((a) => String(a).includes("/tmp/desk.tgz") || argv.includes("/to")));
  assert.ok(!argv.includes("commit"));
  assert.equal(argv.at(-2) === "tar" || argv.includes("tar") || argv.some((a) => String(a).startsWith("tar ")), true);
});

test("restore untars into the named volume", () => {
  const argv = restoreArgs("localbot-config-deadbeef", "/tmp/desk.tgz");
  assert.ok(argv.includes("localbot-config-deadbeef:/to"));
  assert.ok(!argv.includes("commit"));
});
```

Tighten the tar assertion in the implementation: snapshot argv is exactly:

```
["run", "--rm", "-v", "VOLUME:/from:ro", "-v", "HOSTDIR:/to", "alpine:3.20", "tar", "-C", "/from", "-czf", "/to/BASENAME", "."]
```

where `HOSTDIR` is `dirname(archiveAbs)` and `BASENAME` is `basename(archiveAbs)`. Test that exact array with `assert.deepEqual`.

- [x] **Step 2: Run to verify fail**

- [x] **Step 3: Implement `argv.ts`**

Use `path.posix` only if paths are already POSIX; on macOS `path.dirname` / `path.basename` from `node:path` is correct because the injected runner is local Docker.

Refuse archives whose basename is empty or contains `..`. Throw `Error("desk-images: bad archive path")`.

- [x] **Step 4: Tests pass**

- [x] **Step 5: Commit**

```bash
git add packages/desk-images tsconfig.json package.json package-lock.json
git commit -m "feat: add @sub8/desk-images volume tar argv."
```

---

### Task 5: Snapshot/restore orchestration (still fake docker)

**Files:**
- Create: `packages/desk-images/src/ops.ts`
- Modify: `packages/desk-images/src/index.ts`
- Modify: `packages/desk-images/test/desk-images.test.mjs`

**Interfaces:**
- Consumes: `snapshotArgs` / `restoreArgs` / `DockerRun`
- Produces:
  - `ensureVolumeArgs(volume: string): string[]` → `["volume", "create", volume]`
  - `snapshotVolume({ run, volume, archiveAbs }): Promise<void>`
  - `restoreVolume({ run, volume, archiveAbs }): Promise<void>`

- [x] **Step 1: Failing test with a recording runner**

```js
import { snapshotVolume, restoreVolume } from "../dist/index.js";

function recorder() {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.slice());
    return { ok: true, out: "", err: "" };
  };
  return { calls, run };
}

test("snapshotVolume shells the tar argv and throws when docker fails", async () => {
  const { calls, run } = recorder();
  await snapshotVolume({ run, volume: "vol-a", archiveAbs: "/tmp/a.tgz" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], snapshotArgs("vol-a", "/tmp/a.tgz"));
  const bad = async () => ({ ok: false, out: "", err: "boom" });
  await assert.rejects(() => snapshotVolume({ run: bad, volume: "vol-a", archiveAbs: "/tmp/a.tgz" }), /boom/);
});

test("restoreVolume creates the volume first, then untars", async () => {
  const { calls, run } = recorder();
  await restoreVolume({ run, volume: "vol-a", archiveAbs: "/tmp/a.tgz" });
  assert.equal(calls[0][0], "volume");
  assert.equal(calls[0][1], "create");
  assert.deepEqual(calls[1], restoreArgs("vol-a", "/tmp/a.tgz"));
});
```

- [x] **Step 2: Fail, then implement `ops.ts`**

If `run` returns `{ ok: false }`, throw `new Error(err || out || "docker failed")`.

`volume create` may fail if it exists — treat stderr matching `/already exists/i` as success.

- [x] **Step 3: Tests pass + commit**

```bash
git add packages/desk-images
git commit -m "feat: snapshotVolume and restoreVolume with injected docker."
```

---

### Task 6: Local catalog + HTTP API

**Files:**
- Create: `server/desk-images.mts`
- Modify: `server/index.mts` (add routes next to the computers routes around the existing `/api/computers` handlers)
- Create: `test/desk-images-api.mjs`

**Interfaces:**
- Consumes: `snapshotVolume` / `restoreVolume`; `computers.mts` rows (`volume`, `container`, `id`)
- Produces: files under `path.join(dataDir, "desk-images")` and catalog `desk-images.json`

Catalog row:

```ts
export interface DeskImage {
  id: string;
  computerId: string;
  volume: string;
  fileName: string;
  bytes: number;
  createdAt: number;
  note: string;
}
```

Routes (session-gated the same way other `/api/computers` routes are):

- `GET    /api/computers/:id/images`
- `POST   /api/computers/:id/images` body `{ note?: string }`
- `POST   /api/computers/:id/images/:imageId/restore`
- `DELETE /api/computers/:id/images/:imageId`

- [x] **Step 1: Write `test/desk-images-api.mjs` against the catalog helpers, not live Docker**

Export `buildCatalog` / `addImage` / `removeImage` from `server/desk-images.mts` so the test does not boot Express. Pattern: `test/vault.mjs` and `packages/store/test/*`.

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCatalog, addImageRow, readCatalog } from "../server/desk-images.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-img-"));
process.env.SUB8BOT_DATA = dir;
const cat = createCatalog(dir);
const row = addImageRow(cat, { computerId: "c1", volume: "vol-c1", fileName: "img.tgz", bytes: 12, note: "before cloud" });
assert.equal(row.computerId, "c1");
assert.equal(readCatalog(dir).length, 1);
```

Then a second test: `performSnapshot` with injected `run` records argv and writes a fake file so `bytes > 0`.

- [x] **Step 2: Fail, implement `server/desk-images.mts`**

`performSnapshot` must:

1. Resolve computer by id (throw 404).
2. Pause or stop the container via the injected `docker` used by `server/vm.mts` — add an optional `control: { stop, start }` parameter so tests do not talk to Docker. Default implementation calls existing `docker(["pause", name])` / `unpause`.
3. `snapshotVolume`.
4. `unpause` in a `finally`.
5. `fs.stat` the archive, append catalog.

`performRestore` must stop the container (not pause — overlaying `/config` under a live Chrome is corruption), `restoreVolume`, start.

Never snapshot the golden image. Never call `docker commit`.

Wire routes in `server/index.mts` after computers delete/destroy. JSON errors use the same `{ error }` shape as nearby handlers.

- [x] **Step 3: Run `node test/desk-images-api.mjs` and `node test/api-hardening.mjs`**

Expected: PASS. Hardening must still reject computer ids that are not in the catalog.

- [x] **Step 4: Commit**

```bash
git add server/desk-images.mts server/index.mts test/desk-images-api.mjs
git commit -m "feat: local desk volume snapshot API."
```

---

### Task 7: Computers panel — Snapshot / Restore

**Files:**
- Modify: `web/app.ts` (computers modal; search for `Keep the computer` / computers panel around the destroy copy)
- Modify: `web/styles.css` only if a new row action needs it
- Modify: `docs/vm-manager.md` (append a **Snapshots** section)

**Interfaces:**
- Consumes: the four HTTP routes
- Produces: UI only

- [x] **Step 1: Add acts + a delegated-act test if the panel uses `data-act`**

`test/delegated-acts.mjs` currently tracks 169 acts. If new acts are `desk-snap`, `desk-restore`, `desk-image-del`, add them to that list the same way `lol` was added.

- [x] **Step 2: UI copy (exact)**

On a computer detail pane, below Start/Stop/Destroy:

- Button **Snapshot disk** — subtitle: “Saves this Linux desk’s files and Chrome profile. Chat stays in Sub8.”
- List of snapshots: date, size, note, **Restore**, **Delete**
- Restore confirm: “This replaces the desk’s files with the snapshot. The bot’s chat does not change.”

Do not put this in the vault modal. Do not mention DigitalOcean in the local UI.

- [x] **Step 3: Manual check (no `npm run dev`)**

If `:8787` is already up, reload the app and snapshot a stopped test computer. If Docker is required and missing, the API must return 503 `{ error: "Docker is not running." }` instead of hanging.

- [x] **Step 4: Commit**

```bash
git add web/app.ts web/styles.css docs/vm-manager.md test/delegated-acts.mjs
git commit -m "feat: snapshot and restore a local desk from Computers."
```

**Gate 1.** Stop unless the operator asks to continue. Cloud is still one droplet per computer with no named volume.

---

### Task 8: Cloud `user_data` uses `deskRunArgs` + named volume

**Files:**
- Modify: `cloud/scripts/sync-orchestration.mjs` (`PACKAGES` becomes `["orchestration", "harness-protocol", "desk-runtime"]`)
- Modify: `cloud/src/digitalocean.ts` (`deskUserData`, `deskUserDataFromSnapshot`)
- Create: `cloud/src/desk-limits.ts`
- Modify: `cloud/test/snapshot-bake.mjs` and any test that snapshots user_data strings (search `sub8-desk:trixie`)
- Modify: `cloud/src/billing/catalog.ts` (`diskGb`, `milliCpus`, `dedicated` on `Sku`)

**Interfaces:**
- Consumes: `deskRunArgs`, `limitsFromRamMb`
- Produces: cloud boot script still a string, but the `docker run` line is `docker ${deskRunArgs(...).join(" ")}` with `publish.kind === "host"` and `volume: "sub8-config-${computerId}"`

SKU field defaults (do not change prices):

| id | diskGb | milliCpus | dedicated |
|---|---|---|---|
| `vm.1g` | 25 | 500 | false |
| `vm.2g` | 25 | 500 | false |
| `vm.4g` | 40 | 1000 | false |
| `vm.8g` | 80 | 2000 | true |
| `vm.16g` | 160 | 4000 | true |

`dedicated` is ignored until Task 11. `createSizeForSku` does not change in this task.

- [x] **Step 1: Failing cloud test**

In `cloud/test/computers.mjs` or a new `cloud/test/desk-run.mjs`:

```js
import assert from "node:assert/strict";
import { deskUserDataFromSnapshot } from "../src/digitalocean.ts";

const sh = deskUserDataFromSnapshot({ sku: "vm.4g", computerId: "cmp_abc", deskToken: "t", workerUrl: "https://sub8.bot" });
assert.match(sh, /sub8-config-cmp_abc:\/config/);
assert.match(sh, /--cpus/);
assert.match(sh, /--pids-limit/);
assert.doesNotMatch(sh, /docker commit/);
assert.match(sh, /--name sub8-desk/);
```

Worker tests that import `.ts` already do this style in `cloud/test/*`.

- [x] **Step 2: Fail because there is no `-v`**

- [x] **Step 3: Implement**

`cloud/src/desk-limits.ts`:

```ts
import { limitsFromRamMb, type DeskLimits } from "../vendor/desk-runtime/index.js";
import { skuById, type Sku } from "./billing/catalog.ts";

export function limitsForSku(skuId: string): DeskLimits {
  const sku = skuById(skuId);
  return limitsFromRamMb(sku ? sku.ramMb : 4096);
}
```

Vendor path must match whatever `sync-orchestration.mjs` copies (today `vendor/orchestration` is the dist folder). After copy, import like other vendored packages in `cloud/src`. If orchestration is imported from `../vendor/orchestration/index.js`, do the same.

Replace the hand-rolled `docker run` in both user_data builders. Keep `docker rm -f sub8-desk`. Add `docker volume create sub8-config-${computerId}` before run. Keep desk-agent / executor / ready-callback as they are.

`--memory` for `vm.16g` becomes `16g` via `limitsFromRamMb`. That will OOM a dedicated `s-8vcpu-16gb` if you also pack OS on it — **do not switch paying 16g desks to packing in this task**. For dedicated droplets only, overlay memory with the historical map (`1g/2g/3g/6g/12g`) when `dedicated === true`, and use full `limitsFromRamMb` when `dedicated === false`. Put that overlay in `limitsForSku(skuId, { dedicated })` in `cloud/src/desk-limits.ts`, not in the package.

```ts
export function limitsForSku(skuId: string, { dedicated }: { dedicated: boolean }): DeskLimits {
  const base = limitsFromRamMb(skuById(skuId)?.ramMb || 4096);
  if (!dedicated) return base;
  const overlay: Record<string, string> = { "vm.1g": "1g", "vm.2g": "2g", "vm.4g": "3g", "vm.8g": "6g", "vm.16g": "12g" };
  const memory = overlay[skuId] || base.memory;
  return { ...base, memory, memorySwap: memory };
}
```

- [x] **Step 4: `cd cloud && node scripts/sync-orchestration.mjs && npm test`**

Expected: PASS. Snapshot bake tests still see `sub8-desk:trixie`.

- [x] **Step 5: Commit** (cloud submodule and parent if both dirty)

```bash
git add cloud/src/digitalocean.ts cloud/src/desk-limits.ts cloud/src/billing/catalog.ts cloud/scripts/sync-orchestration.mjs cloud/vendor/desk-runtime cloud/test
git commit -m "feat: cloud desks mount a named /config volume from deskRunArgs."
```

---

### Task 9: Restore a local snapshot onto a dedicated cloud desk (operator path)

**Files:**
- Create: `cloud/src/desk-transfer.ts` (Worker: signed upload slot metadata only)
- Modify: `server/desk-images.mts` (export archive path; no cloud tokens in the package)
- Modify: `docs/vm-manager.md` with the operator restore steps

This task is **not** a one-click “Move to Cloud” button. It is the smallest path that proves the volume is the portable image.

Flow:

1. Local snapshot exists (Gate 1).
2. Operator creates a Cloud computer (today’s 1:1 droplet).
3. Worker endpoint `POST /api/computers/:id/volume-import` (admin-only) accepts a multipart or a pre-signed note that the host agent should fetch.
4. Host: stop `sub8-desk`, `restoreVolume` into `sub8-config-${id}`, start with the same `deskRunArgs`.
5. Rewrite `/var/lib/sub8/desk-token` (already in user_data). Do not copy local MCP tokens onto the public internet.

- [x] **Step 1: Admin-only test in `cloud/test/computers.mjs`**

Non-admin → 403. Admin with unknown computer → 404. Admin with `status=assigned` → 202 `{ ok: true, volume: "sub8-config-..." }`.

- [x] **Step 2: Implement the route behind `isAdmin`**

Do not stream gigabyte tarballs through the Worker. Store the snapshot in R2 or a signed PUT later; for v1, SSH/scp onto the droplet is an operator runbook in `docs/vm-manager.md` if R2 is not already in `wrangler.jsonc`. Prefer documenting `scp` + `docker run --rm -v sub8-config-$ID:/to -v /tmp:/from alpine tar ...` over building R2 in this task.

- [x] **Step 3: Commit runbook + admin stub**

```bash
git commit -m "feat: admin volume-import stub and restore runbook."
```

**Gate 2.** A dedicated droplet can receive a `/config` tarball. Paying UX is still “create a Cloud computer.”

---

### Task 10: `@sub8/desk-place` bin-pack

**Files:**
- Create: `packages/desk-place/` (same scaffold as constants)
- Modify: `tsconfig.json`, root `package.json`, `npm install`
- Vendor into cloud in Task 11, not now

**Interfaces:**

```ts
export interface HostSnapshot {
  id: string;
  ramMb: number;
  diskGb: number;
  milliCpus: number;
  reservedRamMb: number;
  reservedDiskGb: number;
  reservedMilliCpus: number;
  dedicated: boolean;
  region: string;
}

export interface Reservation {
  ramMb: number;
  diskGb: number;
  milliCpus: number;
  dedicated: boolean;
}

export function hostFits(host: HostSnapshot, want: Reservation): boolean;
export function pickHost(hosts: readonly HostSnapshot[], want: Reservation): HostSnapshot | null;
export function usableHost(ramMb: number, diskGb: number, milliCpus: number): {
  ramMb: number; diskGb: number; milliCpus: number;
};
```

Constants (exported, tested):

```ts
export const HOST_RAM_RESERVE_MB = 2048;
export const HOST_DISK_RESERVE_GB = 30;
export const HOST_CPU_RESERVE_MILLI = 200;
export const CPU_OVERSUBSCRIBE = 1.5;
```

`usableHost` subtracts those reserves.

`hostFits`:

- region is not compared here (caller filters)
- if `host.dedicated` or `want.dedicated`: fits only when `reservedRamMb === 0` and the usable ram/disk/cpu ≥ want
- else: `reservedRamMb + want.ramMb <= usable ram`, same for disk; CPU allows `reservedMilliCpus + want.milliCpus <= usable milliCpus * CPU_OVERSUBSCRIBE`

`pickHost`: filter `hostFits`, sort remaining RAM ascending (tightest fit), return first. Empty → `null`.

- [ ] **Step 1: Tests**

```js
test("a 64 GB host packs fifteen 4 GB desks and rejects the sixteenth", () => {
  const raw = usableHost(65536, 500, 16000);
  let host = { id: "h1", ...raw, reservedRamMb: 0, reservedDiskGb: 0, reservedMilliCpus: 0, dedicated: false, region: "nyc3" };
  const want = { ramMb: 4096, diskGb: 40, milliCpus: 1000, dedicated: false };
  let n = 0;
  while (hostFits(host, want)) {
    n += 1;
    host = { ...host, reservedRamMb: host.reservedRamMb + want.ramMb, reservedDiskGb: host.reservedDiskGb + want.diskGb, reservedMilliCpus: host.reservedMilliCpus + want.milliCpus };
  }
  assert.equal(n, 15); // (65536-2048)/4096 = 15.5 → 15
});

test("dedicated SKUs never co-tenant", () => {
  const host = { id: "h1", ramMb: 16384, diskGb: 200, milliCpus: 8000, reservedRamMb: 4096, reservedDiskGb: 40, reservedMilliCpus: 1000, dedicated: false, region: "nyc3" };
  assert.equal(hostFits(host, { ramMb: 8192, diskGb: 80, milliCpus: 2000, dedicated: true }), false);
});

test("pickHost returns null when every host is full", () => {
  assert.equal(pickHost([], { ramMb: 4096, diskGb: 40, milliCpus: 1000, dedicated: false }), null);
});
```

- [ ] **Step 2–5: implement, pass, commit**

```bash
git commit -m "feat: add @sub8/desk-place host bin-pack."
```

---

### Task 11: D1 `desk_hosts` + place-or-provision (flagged off)

**Files:**
- Create: `cloud/migrations/0006_desk_hosts.sql`
- Create: `cloud/migrations/0007_computer_volume.sql`
- Create: `cloud/src/hosts.ts`
- Modify: `cloud/src/computers.ts` (`createComputer` placement)
- Modify: `cloud/scripts/sync-orchestration.mjs` (add `desk-place`)
- Modify: `cloud/test/computers.mjs`

SQL:

```sql
CREATE TABLE IF NOT EXISTS desk_hosts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_id TEXT,
  ipv4 TEXT,
  region TEXT NOT NULL,
  ram_mb INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  milli_cpus INTEGER NOT NULL,
  dedicated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'warming',
  error TEXT,
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_desk_hosts_status ON desk_hosts(status);

ALTER TABLE computers ADD COLUMN host_id TEXT;
ALTER TABLE computers ADD COLUMN volume_name TEXT;
```

`PACK_SHARED_HOSTS` env, default `"0"`. When `"0"`, `createComputer` is byte-compatible with today (one droplet, `host_id` null). When `"1"` and `sku.dedicated === false`, `pickHost` on live hosts; `null` → `provisionHost` (a droplet sized for packing, e.g. `s-8vcpu-32gb`, image = golden snapshot, user_data starts docker only — no `sub8-desk` until a place call).

Do not implement the host agent HTTP in this task beyond a function `hostDockerRun(ipv4, token, argv)` that tests mock. Production path stays 1:1 until Gate 3.

- [ ] **Step 1: Tests with mocked D1 like `cloud/test/computers.mjs`**

When `PACK_SHARED_HOSTS=0`, create still calls `createDroplet` once per computer.

When `PACK_SHARED_HOSTS=1` and two `vm.4g` creates against one mocked host with 32 GB, second create must **not** call `createDroplet`. Third that does not fit does call it.

- [ ] **Step 2–5: implement behind the flag, commit**

```bash
git commit -m "feat: optional shared-host placement behind PACK_SHARED_HOSTS."
```

---

### Task 12: Warm **hosts** plus per-container caps on the fat box

**Files:**
- Modify: `cloud/src/hosts.ts` (warm pool of hosts, parallel to `WARM_POOL_TARGET` desks)
- Modify: `cloud/wrangler.jsonc` vars: `WARM_HOST_TARGET` default `"0"`
- Modify: `cloud/src/digitalocean.ts` — host user_data: install docker, pull `sub8-desk:trixie`, **do not** start a customer container
- Add cgroup flags already produced by `deskRunArgs` (Task 2). No extra work if Task 8 landed.

- [ ] **Step 1: Test warm host refill does not create customer `computers` rows**

- [ ] **Step 2: Cron in existing `scheduled()`: if `WARM_HOST_TARGET>0`, keep that many `desk_hosts` in `warm`**

- [ ] **Step 3: Manual internal soak (operator):** one 32 GB droplet, two internal volumes, two `deskRunArgs` with `vm.2g` limits. Run `stress-ng --vm 2 --vm-bytes 3g` in desk A; desk B screenshot still returns. If B dies, packing is not proven — do not enable for paying SKUs.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: warm Docker hosts without a customer desk."
```

**Gate 3.** Packing is internal-only.

---

### Task 13: Paying shared hosts (only after stream proxy)

**Files:**
- Modify: `docs/authenticated-desk-stream.md` — packing requires `STREAM_VIA_WORKER=1`
- Modify: `cloud/src/computers.ts` — refuse `PACK_SHARED_HOSTS=1` for a non-admin if `STREAM_VIA_WORKER !== "1"` (throw 409 `"Shared hosts need the Worker stream proxy."`)
- No public `-p 3000:3000` on shared hosts. `publish.kind` for packed desks becomes loopback-on-the-host (`127.0.0.1:3000`) plus Worker relay, **or** host ports bound to the droplet's private interface only. Do not ship public websockify.

- [ ] **Step 1: Test the 409**
- [ ] **Step 2: Implement the guard**
- [ ] **Step 3: Commit**

```bash
git commit -m "fix: never pack paying desks without the Worker stream proxy."
```

**Gate 4.** Operator may set `PACK_SHARED_HOSTS=1` for `vm.1g`/`vm.2g`/`vm.4g`. Dedicated SKUs unchanged.

---

## Self-review

**Spec coverage**

| Requirement | Task |
|---|---|
| Same docker container locally and in cloud | 2, 3, 8 |
| Backup local image / image manager | 4–7 |
| Spin that image on DigitalOcean | 8–9 |
| Packages-first, no provisioner in packages | 1, 4, 10 + Global Constraints |
| Droplet is a Docker host | 8, 11–12 |
| Hundreds of customers via a host fleet | 10–12 |
| Limits from host specs | 10 `usableHost` / `hostFits` |
| Charge RAM and disk | Task 8 SKU `diskGb`; billing still Stripe products in `cloud/` |
| Spin another host when full | 11 `pickHost` → null → `provisionHost`; 12 warm hosts |
| One container cannot take 100% | Task 1–2 `--memory` `--cpus` `--pids-limit`; swap capped; Task 8 disk via volume size later |
| `vm.8g`/`vm.16g` dedicated | Task 8 `dedicated: true`; Task 10 `hostFits` |

**Out of scope (do not sneak in)**

- One-click “Move this bot to Cloud” in the rail
- Retagging `sub8-desk:trixie` with user Chrome
- Kubernetes / Fly / Hetzner adapters (the provisioner seam is `createDroplet` / `provisionHost`; a later provider implements the same host record)
- Firecracker / Kata
- R2 image store (runbook scp at Gate 2)
- Changing Stripe prices
- Packing paying customers before `STREAM_VIA_WORKER`

**Placeholder scan:** none of TBD / implement later / similar to Task N remain.

**Type names used everywhere:** `DeskLimits`, `DeskRunSpec`, `deskRunArgs`, `limitsFromRamMb`, `snapshotVolume`, `restoreVolume`, `HostSnapshot`, `Reservation`, `hostFits`, `pickHost`, `usableHost`.

---

## Notes after implementation

**How to write here (every agent, every session):**

- After each task commit, append a `### Task N — <date>` block: what landed, files actually touched (if different from the spec), tests run and the literal pass/fail, surprises vs the before-notes, line numbers that moved.
- After each ship gate, append a `### Gate N — <date>` block: what the operator can do now, what is still forbidden, env flags still off.
- If you diverge from a task (needed extra file, overlay rule, skipped a step), say so here in one sentence. Do not silently rewrite the task.
- Never delete **Notes before implementation**. If code now disagrees with a before-note, this section is the correction.
- Compacted sessions: read before-notes, then this log from the bottom, then the next unchecked task.

**Status at execution start (2026-08-31):** operator licensed Gate 1 (Tasks 1–7). Branch `feat/desk-host-fleet` from `1813683`. SDD ledger: `.superpowers/sdd/2026-08-31-desk-host-fleet/progress.md`. Stop after Gate 1. Resume phrase: “continue desk host fleet”.

### Log

_(append below, newest last)_

### Task 1 — 2026-08-31

Landed `ccd330f` `feat: add @sub8/desk-runtime cgroup limits.` Review clean (spec ✅, quality Approved). Package `@sub8/desk-runtime` with `limitsFromRamMb` + `DeskLimits`, root `file:` dep + lockfile, tsconfig reference. Tests 4/4. Next: Task 2 `deskRunArgs`.

### Task 2 — 2026-08-31

Landed `769fe26` `feat: deskRunArgs builds local and host docker argv.` Review clean (spec ✅, quality Approved). `deskRunArgs` + loopback/host publish. Minor deferred: host publish / rfbExpose untested (brief only required loopback). Next: Task 3 wrap `deskCreateArgs`.

### Task 3 — 2026-08-31

Landed `77fd415` `refactor: local deskCreateArgs delegates to @sub8/desk-runtime.` Review clean (spec ✅, quality Approved). Local `deskCreateArgs` wraps `deskRunArgs`; `--cpus` / `--pids-limit` / `-v` asserted. Minors deferred: argv flag order vs old `deskCreateArgs`; `harnessPort ||` treats `0` as absent.

**Paused here (operator, 2026-08-31):** do not start Task 4 until resume. Resume phrase: “continue desk host fleet”. Next: Task 4 `@sub8/desk-images` argv. Gate 1 still open (Tasks 4–7).

### Task 4 — 2026-08-31

Landed `35c83ff` `feat: add @sub8/desk-images volume tar argv.` Review clean. Snapshot/restore argv + `listVolumeArgs` + bad-path throw. Next: Task 5 ops with injected runner.

### Task 5 — 2026-08-31

Landed `9e29368` + fix `de65295`. Review then fix-round: already-exists / create-fail / tar-fail covered. Next: Task 6 local catalog + HTTP API.

### Task 6 — 2026-08-31

Landed `069ddde` `feat: local desk volume snapshot API.` Review Approved. Routes registered before `:action`. Docker-down 503. Minors deferred: silent unpause on snapshot 200; restore finally can mask errors. Next: Task 7 Computers panel UI.

### Task 7 — 2026-08-31

Landed `45f8e02` `feat: snapshot and restore a local desk from Computers.` Review Approved. Acts `desk-snap` / `desk-restore` / `desk-image-del`. Exact copy in Computers detail. Live :8787 was not restarted (constraint), so a running app needs a reload/restart to pick up `/images` routes. Minors deferred: no delete confirm; GET errors look like empty list; snapshot POSTs `{}` (no note editor).

### Gate 1 — passed 2026-08-31 (code)

Operator can snapshot/restore a local desk volume from the Computers panel once the desktop server is running this branch. Cloud provisioning unchanged (1:1 droplets, no named `/config` volume). **Do not start Task 8 until the operator asks for Gate 2.**

Paused. Resume phrase: “continue desk host fleet” (Gate 2 = Tasks 8–9).

### Task 8 — 2026-09-01

Landed cloud `44cd81d` `feat: cloud desks mount a named /config volume from deskRunArgs.` (the cloud submodule carried 27 files of operator WIP before this task; committed first as `894aed1`, octopus characters as `59155f5`). Re-vendoring also refreshed `vendor/harness-protocol` to the current dist. `cloud/src/desk-limits.ts` adds `limitsForSku(sku, { dedicated })` with the 1g/2g/3g/6g/12g overlay kept out of the package. `Sku` gains `diskGb` / `milliCpus` / `dedicated` (prices untouched). Both `deskUserData*` now emit `docker volume create sub8-config-<id>` then `docker ${deskRunArgs(...)}` with `publish.kind === "host"`; `dockerPortFlags` is gone (map pinned by `cloud/test/desk-run.mjs`). **Divergence:** `desk-runtime` imports `@sub8/desk-ports` and `@sub8/harness-protocol`, so `sync-orchestration.mjs` now vendors transitive `@sub8/*` deps and rewrites bare specifiers to `../<name>/index.js` — `vendor/desk-ports/` is new (the before-note listed only orchestration + harness-protocol). Tests: `desk-run.mjs` RED→GREEN; `cd cloud && npm test` EXIT 0; `npm run typecheck` EXIT 0; `wrangler deploy --dry-run` EXIT 0 with the argv in the bundle. Wire: vm.4g still `--memory 3g`, vm.16g still `12g`; new `--cpus`, `--pids-limit`, `-v sub8-config-<id>:/config`. Only new droplets affected; nothing provisioned. `dedicated: true` hard-coded until Task 11. Next: Task 9.

### Task 9 — 2026-09-01

Landed cloud `25ca6b2` `feat: admin volume-import stub and restore runbook.` plus parent `archivePath()` in `server/desk-images.mts` and the runbook in `docs/vm-manager.md`. `POST /computers/:id/volume-import` behind `user.admin`: 403 / 404 / 202 `{ ok, computerId, volume, container, host, runbook }`, and **409 unless `assigned`** (my addition — warm-pool and dying desks are never named as targets). `cloud/src/desk-transfer.ts` is metadata only; no R2 in wrangler, so bytes go over scp per the spec. Runbook mirrors `restoreArgs` and deletes `/config/.desk-token` after untar. Tests: four cases RED→GREEN in `cloud/test/computers.mjs`; full cloud chain, typecheck, and `test/desk-images-api.mjs` EXIT 0. Not exercised on a live droplet; nothing provisioned.

### Gate 2 — passed 2026-09-01 (code)

New droplets boot the desk from `deskRunArgs` with `-v sub8-config-<id>:/config` and cpu/pid caps; an admin can name an assigned droplet's volume and follow the scp runbook to restore a local snapshot onto it. Still one droplet per computer; paying UX is still "create a Cloud computer"; `createSizeForSku` unchanged. Not verified against a live droplet. **Do not start Task 10 (Gate 3, packing) until the operator asks.** `STREAM_VIA_WORKER` still unset.

### Task 10 — not started

### Task 11 — not started

### Task 12 — not started

### Gate 3 — not passed

### Task 13 — not started

### Gate 4 — not passed

`STREAM_VIA_WORKER` still unset in prod wrangler. `PACK_SHARED_HOSTS` does not exist. Paying desks must stay 1:1.
