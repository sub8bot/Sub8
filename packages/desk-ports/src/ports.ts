import { HARNESS_PORT } from "@sub8/harness-protocol";

import type { PortMap } from "./types.js";

/** How many X displays (and therefore noVNC ports) one desk reserves. */
export const DISPLAY_SLOTS = 8;

/**
 * Packed desks on a shared host: the host has one address, so every standard
 * desk port gets a per-slot host port in a 100-port window. Slot 0 is
 * 20000-20099, slot 1 is 20100-20199, … The Worker dials these; the container
 * only ever sees its standard ports.
 */
export const PACK_PORT_BASE = 20000;
export const PACK_SLOT_STRIDE = 100;
export const PACK_MAX_SLOTS = 40;

function packedOffset(standardPort: number): number | null {
  if (standardPort === 80) return 0; // desk-agent (its only port on a shared host)
  if (standardPort >= 3000 && standardPort <= 3007) return 10 + (standardPort - 3000); // websockify per display
  if (standardPort === 3010) return 20; // executor
  if (standardPort === HARNESS_PORT) return 21; // harness
  if (standardPort >= 5900 && standardPort <= 5907) return 30 + (standardPort - 5900); // x11vnc RFB per display
  return null;
}

/** Host port for a packed desk's standard port. Throws on a port no desk uses. */
export function packedPort(slot: number, standardPort: number): number {
  const s = Number(slot);
  if (!Number.isInteger(s) || s < 0 || s >= PACK_MAX_SLOTS) throw new Error(`packedPort: slot ${slot} out of range`);
  const off = packedOffset(Number(standardPort));
  if (off === null) throw new Error(`packedPort: ${standardPort} is not a desk port`);
  return PACK_PORT_BASE + s * PACK_SLOT_STRIDE + off;
}

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
