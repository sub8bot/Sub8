# @sub8/desk-ports

Desk port arithmetic, carved out of `server/vm.mjs`. Every function here is
pure or takes its I/O as an argument, which is exactly why it could leave
`vm.mjs` — the third most-churned file in the repo — without dragging Docker
along.

## What is here

- `DISPLAY_SLOTS` — one desk reserves eight X displays, so eight noVNC ports.
- `HARNESS_PORT` — re-exported from `@sub8/harness-protocol`.
- `harnessHostPort(novncPort)` — the desk's harness sits at `novnc + DISPLAY_SLOTS`.
- `mappedHarnessPort(portMap)` / `needsHarnessPublish(portMap)` — only a real
  docker mapping counts. **Never invent `novnc + 8`**: that is the next desk's
  noVNC range.
- `parseDisplayPorts(ports)` — `docker ps --format {{.Ports}}` → `{ container: host }`.
- `streamPortForDisplay(n, portMap, stored)` — display `:N`'s host port, and
  never `:1`'s for `N > 1`.
- `resolveStreamPort(stored, mapped)` — docker's current mapping beats a port we
  wrote down; a remembered port can still answer HTTP for a *different* desk.
- `HARNESS_STDIO_BRIDGE` — the Python one-liner `docker exec -i` runs to bridge
  stdio to `127.0.0.1:3011` inside the desk. No host paths appear in it.
- `attachHarnessProxy(server, connectRemote)` — accepts on a `net.Server` and
  pipes each client to whatever `connectRemote()` returns: a `docker exec` child
  (stdin/stdout) or a socket (pipe). The docker spawn stays in `vm.mjs`.

## Three declarations of 3011 became one

`server/vm.mjs` and `server/desk-client.mjs` each declared
`DESK_HARNESS_CONTAINER_PORT = 3011`, and `HARNESS_STDIO_BRIDGE` spelled it out
a third time. All three now come from `@sub8/harness-protocol`'s `HARNESS_PORT`.
`desk-client.mjs` also had its own copy of `harnessHostPort` that hardcoded `+ 8`
instead of `+ DISPLAY_SLOTS`; `test/desk-client.mjs` was quietly asserting the
two copies agreed. There is one copy now.

One literal survives: the regex inside `parseDisplayPorts`, because a regex
literal reads better than one built from a string. The package test builds its
fixture from `HARNESS_PORT`, so the two cannot drift apart silently.

## What is deliberately NOT here

`allocatePort`, `allocateHarnessPort`, `portFree` and `detectMappedPort` stay in
`server/vm.mjs`. They look like port helpers, but each one shells out —
`docker ps`, `docker port`, `lsof`, `netstat` — and moving them would mean
inventing an injected runner seam. That is a redesign, not a move, and it would
change the signature at every call site inside `vm.mjs`. Same for
`cachedMappedPort` / `cachedHarnessPort` / `cachedPortMap`, which read
`vm.mjs`'s live `containerListCache`.
