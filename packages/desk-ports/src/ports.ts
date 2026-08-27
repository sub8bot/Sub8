import { HARNESS_PORT } from "@sub8/harness-protocol";

import type { PortMap } from "./types.js";

/** How many X displays (and therefore noVNC ports) one desk reserves. */
export const DISPLAY_SLOTS = 8;

export function harnessHostPort(novncPort: unknown): number | null {
  const p = Number(novncPort);
  if (!Number.isFinite(p) || p <= 0) return null;
  return p + DISPLAY_SLOTS;
}

/** Only the docker-mapped 3011. Never invent novnc+8 — that collides with the next desk. */
export function mappedHarnessPort(portMap: PortMap | null | undefined): number | null {
  const p = Number(portMap?.[HARNESS_PORT]);
  return Number.isFinite(p) && p > 0 ? p : null;
}

export function needsHarnessPublish(portMap: PortMap | null | undefined): boolean {
  return !mappedHarnessPort(portMap);
}

/** stdio ↔ tcp 127.0.0.1:3011 inside the desk. No host paths. */
export const HARNESS_STDIO_BRIDGE = `import socket,sys,os,select
s=socket.create_connection(("127.0.0.1",${HARNESS_PORT}))
sin,sout=sys.stdin.buffer,sys.stdout.buffer
s.setblocking(False)
os.set_blocking(0,False); os.set_blocking(1,False)
while True:
    r,_,_=select.select([s,0],[],[],120)
    if not r: break
    if 0 in r:
        b=sin.read(65536)
        if not b: break
        s.sendall(b)
    if s in r:
        b=s.recv(65536)
        if not b: break
        sout.write(b); sout.flush()
`;

/**
 * `docker ps --format {{.Ports}}` → `{ containerPort: hostPort }`.
 *
 * The literal `3011` here is the one place HARNESS_PORT is still spelled out:
 * a regex literal is cheaper to read than a built one. The package test builds
 * its fixture from HARNESS_PORT so the two cannot drift apart silently.
 */
export function parseDisplayPorts(ports: string | null | undefined): PortMap {
  const map: PortMap = {};
  const re = /:(\d+)->(300[0-7]|3011)\/tcp/g;
  const s = String(ports || "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) map[Number(m[2])] = Number(m[1]);
  return map;
}

/** Host noVNC port for display :N. Never fall back to :1's mapping for N>1. */
export function streamPortForDisplay(
  n: unknown,
  portMap: PortMap | null | undefined,
  stored: number | null | undefined,
): number | null {
  const slot = Number(n) >= 1 ? Number(n) : 1;
  const cport = 2999 + slot;
  if (portMap && portMap[cport]) return portMap[cport];
  if (slot <= 1) return (portMap && portMap[3000]) || stored || null;
  if (stored && portMap && stored === portMap[3000]) return null;
  return stored || null;
}

// Docker's current mapping is the source of truth. A port we wrote down can
// still answer HTTP after a remap — it just belongs to a different desk.
export function resolveStreamPort(
  stored: number | null | undefined,
  mapped: number | null | undefined,
): number | null {
  return mapped || stored || null;
}
