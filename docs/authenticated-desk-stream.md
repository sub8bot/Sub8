# Authenticated Cloud desk stream

**Status: half-landed, not active.** Recovered from an unfinished agent worktree
(`.claude/worktrees/agent-a96f8da1c07c89bfa`) where it sat uncommitted and would
have been lost to a `git worktree prune`.

Where the pieces are, as of 2026-08-26:

| Piece | State |
|---|---|
| Worker proxy (`cloud/src/desk-stream.ts`, `handleDeskStream`, `applyStreamUrl`) | in master |
| Client uses the server-supplied absolute `streamUrl` (`web/app.ts`) | in master |
| Droplet `RFB_EXPOSE` gate (`vm/desk-init.sh`, `vm/desk-display.sh`) | in master (ported with this doc) |
| `STREAM_VIA_WORKER` in `cloud/wrangler.jsonc` | **not set — the proxy is OFF** |
| Verified on a live desk | **no** |

So the direct, unauthenticated path is still what desks actually use. Turning the
flag on also needs a snapshot rebuild to carry the `RFB_EXPOSE` gate to droplets,
which is blocked on `DIGITALOCEAN_TOKEN`.

The firewall port list in `cloud/scripts/desk-firewall.mjs` is defence-in-depth
*beneath* this, not a substitute for it.

---

# Authenticated Cloud desk stream — plan

Goal: stop publishing the desk droplet's noVNC/websockify (`:3000`, `:3002-3008`) on
its public IP with no auth. Serve the noVNC stream through the Cloudflare Worker over
WSS with the existing session gate, tunnelling to the droplet with `cloudflare:sockets`
raw TCP — the same mechanism `deskViaSocket` already uses for `/brain/desk-action`.

Nothing here is deployed. Everything is behind `STREAM_VIA_WORKER`, so the current
direct path keeps working until the proxy is verified on a live desk.

---

## Design chosen: (b) "Worker as websockify" — raw TCP to x11vnc

Two designs were on the table:

- **(a) Worker relays client-WS ⇆ droplet websockify-WS.** The Worker would terminate
  the browser WebSocket (native `WebSocketPair`) *and* speak the WebSocket protocol as a
  client to websockify over raw TCP — a hand-rolled RFC6455 codec (masking, 7/16/64-bit
  lengths, opcodes, fragmentation, ping/pong) reading a partial TCP stream. No droplet
  changes beyond the firewall.
- **(b) Worker acts as websockify itself.** The Worker terminates the browser WebSocket
  and relays the raw binary payloads byte-for-byte to x11vnc's RFB TCP port. noVNC-over-WS
  carries raw RFB bytes in binary messages, which is exactly what the RFB TCP port speaks,
  so the relay is a **dumb byte pipe with zero protocol logic**. Requires exposing the
  x11vnc RFB port (locked to Cloudflare by firewall).

**Picked (b).** Reasoning:

1. **Reliability on the hot path.** The relay runs on every desk, every frame. In (b) it
   is `read → send` in both directions; Cloudflare does all WebSocket framing on the
   browser side. In (a) we would hand-roll a WebSocket codec over `cloudflare:sockets` and
   get it exactly right against partial reads and interleaved control frames — precisely
   the code that is hard to make correct and hard to test against a real VNC stream. A raw
   byte pipe cannot mis-frame a binary stream.
2. **Simplicity.** The relay in `src/desk-stream.mjs` (`relayVnc`) is ~40 lines with no
   VNC/WebSocket knowledge. (a) would be ~150 lines of frame codec.
3. **The infra cost of (b) is one-time and gated.** Exposing the RFB port is a reviewed,
   flag-gated change baked once into the golden snapshot; it does not touch local desks
   (the container only binds RFB off-loopback when `RFB_EXPOSE=1`).

The one thing (b) needs that (a) doesn't is the extra RFB port on the droplet. That is not
new *exposure*: both designs leave an unauthenticated service (websockify in (a), RFB in
(b)) reachable only behind the Cloudflare-ranges firewall, with the Worker session gate as
the real auth. See "Residual risk & optional hardening" below.

### noVNC static assets

The client must never touch the raw IP, so `vnc.html` + noVNC's JS are **proxied** over the
same raw-TCP mechanism to the container's websockify HTTP server (`proxyAsset`), serving the
exact, version-matched noVNC the container already ships (no vendoring, no drift). noVNC's
own page derives its WebSocket URL from the `path` query param, so `streamUrlForComputer`
loads `…/vnc.html?…&path=api/desk/<id>/websockify` and the browser connects the WS to our
Worker route on the same origin (session cookie flows, `SameSite=Lax`, same-site GET + WS).

### Ports

- Assets: droplet `3000` (display 1), `3002-3008` (displays 2-8) → container websockify.
  `deskAssetPort(display)` = `streamHostPort(display)`.
- RFB / WS: droplet `5900-5907` → container x11vnc (display N → `5899+N`).
  `deskRfbPort(display)` = `5899+display`.

---

## Files added / changed

### sub8-cloud (Worker) — code path

- **`src/desk-stream.mjs`** (new): the whole proxy.
  - `handleDeskStream(request, env, path, user)` — matches `/api/desk/:id/**`, gates with
    `gateDesk` (owner + `status==="assigned"` + `ipv4`; admins may view any), then either
    `relayVnc` (WS upgrade on `/websockify`) or `proxyAsset` (everything else).
  - `deskStreamEnabled`, `streamUrlForComputer`, `applyStreamUrl`, `deskAssetPort`,
    `deskRfbPort`. Returns `null` (route absent) whenever `STREAM_VIA_WORKER` is off.
- **`src/index.mjs`**: import + route (before the ASSETS fallback), and
  `applyStreamUrl(env, …)` wrapped around every `publicComputer(...)` in the responses that
  carry a stream URL (`GET/POST /computers`, `GET /computers/:id`, `/account`, admin
  overview). Flag off → identical bytes as today.
- **`src/computers.mjs`**: `createComputer` passes `rfbExpose = STREAM_VIA_WORKER==="1"`
  into the user-data builders. `streamUrlFor()` unchanged (still the legacy DB default).
- **`src/digitalocean.mjs`**: `dockerPortFlags(rfbExpose)` and an `-e RFB_EXPOSE=1`; when
  `rfbExpose` the docker run also publishes `5900-5907`. Off → byte-identical to today.
- **`test/desk-stream.mjs`** (new) + wired into `npm test`: port maths, flag gating, URL
  shape, route inertness when off, and 401 when signed out. Full suite passes.

### bot repo — container + client

- **`vm/desk-init.sh`, `vm/desk-display.sh`**: x11vnc keeps `-localhost` unless
  `RFB_EXPOSE=1`, in which case it binds off-loopback so docker `-p` can publish the RFB
  port. Local desks (no env) are unchanged.
- **`web/app.js`** `streamUrl(bot)`: prefers a server-provided absolute cloud URL
  (`bot.vm.streamUrl` / `bot.streamUrl`, the flag-gated Worker path) and falls back to the
  local `127.0.0.1` noVNC path. Reversible from the server flag alone.

### Ops (as code, NOT applied)

- **`scripts/desk-firewall.mjs`** (new): dry-run by default; `--apply` creates/updates a DO
  cloud firewall named `sub8-desk-stream` on tag `sub8`, allowing inbound
  `3000, 3002-3008, 5900-5907` **only** from live Cloudflare IPv4+IPv6 ranges.

---

## Rollout order

1. **Build & review.** Land the code above. `STREAM_VIA_WORKER` unset everywhere ⇒ zero
   behaviour change; direct `:3000` path still serves every existing desk.
2. **Test on one live desk (no snapshot rebuild yet).**
   - Manually give one assigned desk the RFB exposure the proxy needs, without rebuilding:
     on that droplet, `docker rm -f sub8-desk` and re-run it adding `-e RFB_EXPOSE=1` and
     `-p 5900:5900 … -p 5907:5907` (copy the exact run line from `digitalocean.mjs`), or
     just add `-p 5900:5900` and restart x11vnc inside the container with `RFB_EXPOSE=1`.
   - Set `STREAM_VIA_WORKER=1` in `.dev.vars` and run `npm run dev` (wrangler dev) pointed
     at that desk, **or** `wrangler deploy` to a preview/workers.dev URL (not the prod
     route) with the var set. Do **not** flip the var on the prod `sub8.bot` worker yet.
   - Verify (see below). Confirm the direct path still works for other desks.
3. **Golden snapshot rebuild.** With the container changes reviewed, rebuild the golden
   snapshot (docs/deploy.md "Golden snapshot") from the updated `vm/` so new desks bake the
   `RFB_EXPOSE`-aware x11vnc. Point `DIGITALOCEAN_IMAGE` at the new snapshot id.
4. **Firewall.** `node scripts/desk-firewall.mjs` (review the dry-run), then `--apply`.
   Confirm Cloudflare can still reach the ports (the Worker still streams) and the public
   internet cannot (see verification). Do this **while the direct path is still allowed**,
   then as the final lock-down remove the public exposure (below).
5. **Flip prod.** Set `STREAM_VIA_WORKER=1` on the prod worker. New desks now expose RFB
   and all clients get Worker stream URLs. Watch a real session.
6. **Close the direct path.** Once every live/warm desk is a post-flag desk (or recycled),
   the firewall already blocks non-Cloudflare traffic to `:3000-3008`, so the direct path
   is dead for outsiders. Leave `:3000-3008` published (the Worker proxies assets through
   them) but firewalled. Optionally drop to the hardened end-state (below).

---

## Rollback

- **Fastest:** set `STREAM_VIA_WORKER=0` (or unset) on the worker. `handleDeskStream`
  returns `null`, `applyStreamUrl` is a no-op, clients get the legacy direct URL again.
  New desks stop exposing RFB. No redeploy of droplets needed.
- **Firewall:** delete the `sub8-desk-stream` firewall in the DO console — but only after
  the flag is back off, otherwise you cut the Worker's own path in. With the flag off the
  direct `:3000` path needs to be reachable again, which deleting the firewall restores.
- **Snapshot:** point `DIGITALOCEAN_IMAGE` back at the previous snapshot id.
- Container/client code changes are inert without the flag/env, so they can stay in place.

---

## How to verify each step

**Assets proxy (HTTPS):**
- `curl -i https://<preview>/api/desk/<id>/vnc.html` with a valid `sub8_session` cookie →
  `200 text/html`. Without the cookie → `401`. Another user's id → `403`. Unassigned →
  `409 NEED_DESK`.
- In a browser signed into that session, open the account page; the desk iframe/`Open desk`
  now points at `…/api/desk/<id>/vnc.html?…` (view source), not `http://<ip>:3000`.

**WebSocket relay:**
- The noVNC page connects and paints the live desktop; mouse/keyboard drive it. In devtools
  Network → WS, the socket is `wss://<host>/api/desk/<id>/websockify` and shows binary
  frames both directions.
- Sanity that it's the raw-RFB path: the very first bytes from the server are the RFB
  version banner `RFB 003.008\n` (12 bytes). If noVNC errors about the protocol, confirm we
  are *not* selecting a `base64` WebSocket subprotocol (we select none, modern noVNC then
  uses binary) and that x11vnc bound off-loopback (`RFB_EXPOSE=1`).
- Extra display: load `…/vnc.html?…&path=api/desk/<id>/websockify?display=2`; confirm it
  reaches `5901`.

**Firewall:**
- From a non-Cloudflare host: `nc -vz <droplet-ip> 3000` and `5900` → **refused/timeout**.
- The Worker stream keeps working (Cloudflare egress is allowed).
- `nc -vz <droplet-ip> 80` (desk-agent) unaffected unless you also firewall it.

**No regression:**
- With the flag off, `npm test` is green and `/computers`, `/account`, admin overview
  return the same `streamUrl` as before. A pre-flag desk still streams over `:3000`.

---

## Residual risk & optional hardening

- **Unauthenticated service behind the CF-range firewall.** As with design (a)'s
  websockify, the RFB port has `-nopw` and is reachable by *any* Cloudflare Worker egress,
  not just ours. The firewall reduces exposure from the whole internet to Cloudflare; the
  Worker session gate is the real auth for legitimate clients. Acceptable for beta.
- **Hardening 1 (recommended next):** give x11vnc a per-desk VNC password (`-rfbauth` from
  a file seeded in `desk-init.sh`, e.g. derived from the desk token) and pass it to noVNC
  via the `?password=` param on the Worker-served `vnc.html`. Then even a Cloudflare-range
  scanner cannot open a session without the per-desk secret, which is only delivered over
  the authenticated HTTPS proxy.
- **Hardening 2 (smaller surface):** bundle a pinned noVNC into the Worker `ASSETS` instead
  of proxying assets to websockify; then bind websockify to localhost and stop publishing
  `:3000-3008` entirely, leaving only the (password-protected, firewalled) RFB port on the
  public interface. Defer until the baseline is proven — it trades the single-source-of-truth
  asset proxy for a vendored, version-locked copy.

---

## Shared hosts require the proxy (desk host fleet, Task 13)

Packing several customer desks onto one Docker host (`PACK_SHARED_HOSTS=1`)
puts several websockify fronts on one droplet. Each of them is unauthenticated,
so a shared host must never publish them on the public interface. Two rules
enforce that:

- **Packed desks publish on the host's loopback only.** `packedRunArgs` in
  `cloud/src/hosts.ts` uses `deskRunArgs` with `publish.kind === "loopback"`
  (base `13000`, ten ports per slot). There is no `-p 3000:3000` on a shared
  host; the only way to a packed desk's stream is this Worker relay.
- **Paying desks may not pack until the relay is on.** `createComputer` refuses
  a non-admin, non-pool create with `409 "Shared hosts need the Worker stream
  proxy."` when `PACK_SHARED_HOSTS=1` and `STREAM_VIA_WORKER !== "1"`, before
  any D1 row or droplet exists. Admin and warm-pool (internal) desks may still
  pack, which is what Gate 3's internal soak uses. Dedicated SKUs (`vm.8g`,
  `vm.16g`) and the flag-off path are untouched.

A packed desk streams through this relay **regardless of the flag**: it has no
direct URL to fall back to. Its RFB is x11vnc inside the container (started with
`RFB_EXPOSE=1`) published on the host interface at the desk's slot port
(`packedPort(slot, 5900 + display - 1)`, 20000–23999); `relayVnc` dials
`deskPort(desk, …)` so a droplet desk and a packed desk look alike. noVNC's
static files come from the desk's own agent (`GET /assets/<file>?display=n`,
desk-token authed), which reads the host-loopback websockify — so a shared host
publishes no websockify at all. The firewall script allows 20000–23999 from the
Cloudflare sources only (`test/desk-firewall.mjs` checks the whole slot range).

Rollout order for **droplet** desks is unchanged: prove the relay on a live desk →
set `STREAM_VIA_WORKER=1` on prod → only then `PACK_SHARED_HOSTS=1` for
`vm.1g` / `vm.2g` / `vm.4g` (Gate 4), because paying packed desks are refused
without the flag. The golden snapshot of 2026-08-26 carries a desk image that
predates `RFB_EXPOSE`; a shared host verifies the image at boot and rebuilds it
from the public repo when it cannot honor the flag, before its agent comes up.
See `cloud/docs/shared-hosts.md`.
