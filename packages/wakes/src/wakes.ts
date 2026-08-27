import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Wake, WakeListener, WakePayload, WakeSpec, WakeType } from "./types.js";

function dataRoot(): string {
  return process.env.SUB8BOT_DATA || process.env.OCTOBOT_DATA || path.join(process.cwd(), "data");
}

/** System wakes (peer, channel, completions, routines, shell) are not the user. */
export const WAKE_TYPES: readonly WakeType[] = Object.freeze([
  "peer",
  "channel",
  "subagent-complete",
  "code-agent-complete",
  "routine",
  "shell",
  "box-help-released",
]);

/** Live-pumped by the host. Completions keep their own subscribers + leftover drain. */
export const AUTO_DRAIN_WAKE_TYPES: readonly WakeType[] = Object.freeze(["peer", "channel", "shell", "box-help-released"]);

const wakeListeners = new Set<WakeListener>();

/** user > priority peer > other peer > automations */
const LANE: Record<string, number> = {
  user: 0,
  peer: 2,
  channel: 2,
  "subagent-complete": 3,
  "code-agent-complete": 3,
  routine: 3,
  shell: 3,
  "box-help-released": 3,
};

function wakesPath(): string {
  return path.join(dataRoot(), "wakes.json");
}

let queues = new Map<string, Wake[]>();
let loaded = false;
let writeChain: Promise<void> = Promise.resolve();

/**
 * mcp-sub8 runs as a SEPARATE OS process against the same data dir (host-cli
 * bakes SUB8BOT_DATA into its env), and both it and the server import this
 * module. `queues` is a per-process cache that was never re-read, and persist()
 * rewrote the whole file from it -- so each process silently erased whatever
 * the other had queued, and wakes the server had already delivered came back
 * from the dead when the other process wrote its stale copy.
 *
 * Fix: the FILE is the source of truth. Every mutation records an op; persist()
 * takes a cross-process lock, re-reads the ledger, replays this process's ops
 * onto it, writes, and adopts the result as the new cache. Nothing is merged
 * from a stale cache, so nothing is resurrected.
 *
 * Known limit, not fixed here: the take and enqueue calls mutate `queues`
 * synchronously and persist afterwards, so two processes can still hand out
 * the SAME wake in that window. Closing that needs the whole API to become
 * async under the lock.
 */
type LedgerOp =
  | { kind: "add"; wake: Wake }
  | { kind: "remove"; botId: string; id: string }
  | { kind: "drop"; botId: string }
  | { kind: "clear" };

let pendingOps: LedgerOp[] = [];

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 30_000;

/**
 * A local copy of store.ts's lock: importing it would be a cycle, since
 * store.ts imports dropWakes from here. Same ownership-token discipline --
 * release only what we still hold, or a hold broken as stale gets its
 * successor's lock deleted out from under it.
 */
async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockFile = `${wakesPath()}.lock`;
  await fs.mkdir(dataRoot(), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      const fh = await fs.open(lockFile, "wx");
      const token = `${process.pid}.${randomUUID()}`;
      try {
        await fh.write(token);
        return await fn();
      } finally {
        await fh.close().catch(() => {});
        try {
          if ((await fs.readFile(lockFile, "utf8")) === token) await fs.unlink(lockFile);
        } catch {
          /* broken and gone -- not ours to remove */
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error("wake ledger lock timeout");
      try {
        const st = await fs.stat(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.unlink(lockFile);
      } catch {
        /* gone */
      }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 25));
    }
  }
}

/** Parse the ledger off disk. Never invents an empty one for a real failure. */
async function readLedger(): Promise<Map<string, Wake[]> | null> {
  try {
    const raw: { queues?: unknown } | null = JSON.parse(await fs.readFile(wakesPath(), "utf8"));
    const rows: unknown = raw?.queues && typeof raw.queues === "object" ? raw.queues : raw;
    const out = new Map<string, Wake[]>();
    if (rows && typeof rows === "object") {
      for (const [botId, list] of Object.entries(rows as Record<string, unknown>)) {
        if (Array.isArray(list)) out.set(botId, list as Wake[]);
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
    return null;
  }
}

function applyOp(map: Map<string, Wake[]>, op: LedgerOp): void {
  if (op.kind === "clear") {
    map.clear();
    return;
  }
  if (op.kind === "drop") {
    map.delete(op.botId);
    return;
  }
  if (op.kind === "add") {
    const list = map.get(op.wake.botId) || [];
    if (!list.some((w) => w.id === op.wake.id)) list.push(op.wake);
    map.set(op.wake.botId, list);
    return;
  }
  const list = (map.get(op.botId) || []).filter((w) => w.id !== op.id);
  if (list.length) map.set(op.botId, list);
  else map.delete(op.botId);
}

function withFile(fn: () => Promise<void>): Promise<void> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function normBotId(botId: unknown): string {
  const id = String(botId ?? "").trim();
  if (!id) throw new Error("botId required");
  return id;
}

function copyWake(wake: Wake): Wake {
  return { ...wake, payload: { ...(wake.payload || {}) } };
}

function laneOf(wake: Wake | undefined): number {
  if (wake?.user) return 0;
  if (wake?.type === "peer" && wake?.priority) return 1;
  const n = LANE[wake?.type as string];
  return Number.isFinite(n) ? (n as number) : 3;
}

function snapshot(): Record<string, Wake[]> {
  const out: Record<string, Wake[]> = {};
  for (const [botId, q] of queues) out[botId] = q.map(copyWake);
  return out;
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw: { queues?: unknown } | null = JSON.parse(await fs.readFile(wakesPath(), "utf8"));
    const rows: unknown = raw?.queues && typeof raw.queues === "object" ? raw.queues : raw;
    queues = new Map();
    if (rows && typeof rows === "object") {
      for (const [botId, list] of Object.entries(rows as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        queues.set(botId, list.map((w: Wake) => ({ ...w, payload: { ...(w.payload || {}) } })));
      }
    }
  } catch (err) {
    queues = new Map();
    // ENOENT is the normal first run. Anything else means a file existed and
    // we could not use it, and starting empty silently drops every queued
    // wake -- so keep the evidence and say so, rather than losing it twice.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("[wakes] ledger unreadable, starting empty:", (err as Error)?.message || err);
      await fs
        .rename(wakesPath(), `${wakesPath()}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
  }
}

function persist(): Promise<void> {
  return withFile(async () => {
    await fs.mkdir(dataRoot(), { recursive: true });
    // Take this process's ops and replay them onto a FRESH read, under a
    // cross-process lock. Writing `snapshot()` straight out is what erased the
    // other process's queue; see the note on LedgerOp.
    const ops = pendingOps;
    pendingOps = [];
    try {
      await withLedgerLock(async () => {
        const disk = await readLedger();
        if (!disk) throw new Error("wake ledger unreadable");
        for (const op of ops) applyOp(disk, op);
        const body = JSON.stringify(
          { queues: Object.fromEntries([...disk.entries()].filter(([, list]) => list.length)) },
          null,
          2,
        );
        const tmp = `${wakesPath()}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(tmp, body, { mode: 0o600 });
        await fs.rename(tmp, wakesPath());
        // Adopt the merged truth so this process now sees the other's wakes.
        queues = disk;
      });
    } catch (err) {
      // Put them back so the next persist retries rather than dropping them.
      pendingOps = [...ops, ...pendingOps];
      console.error("[wakes] persist failed:", (err as Error)?.message || err);
    }
    return;
  });
}

await load();

/**
 * Push a wake onto `botId`'s FIFO. Peer/channel/routine/completion wakes
 * are not the user (`user: false`).
 */
export function enqueueWake({ type, botId, payload, priority = false, user = false }: WakeSpec = {}): Wake {
  const kind = String(type || "").trim();
  if (!(WAKE_TYPES as readonly string[]).includes(kind)) throw new Error(`unknown wake type: ${kind || "(empty)"}`);
  const idBot = normBotId(botId);
  const wake: Wake = {
    id: randomUUID(),
    type: kind as WakeType,
    botId: idBot,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {},
    user: Boolean(user),
    priority: Boolean(priority),
    createdAt: Date.now(),
  };
  let q = queues.get(idBot);
  if (!q) {
    q = [];
    queues.set(idBot, q);
  }
  q.push(wake);
  pendingOps.push({ kind: "add", wake });
  persist().catch(() => {});
  const out = copyWake(wake);
  for (const fn of wakeListeners) {
    try {
      fn(out);
    } catch {
      /* listener errors must not drop the ledger */
    }
  }
  return out;
}

export function subscribeWakes(fn: WakeListener): () => void {
  if (typeof fn !== "function") return () => {};
  wakeListeners.add(fn);
  return () => wakeListeners.delete(fn);
}

export function listQueuedBotIds(): string[] {
  return [...queues.keys()];
}

/** Prompt the parent sees when a durable wake becomes a turn. */
export function turnPromptForWake(wake: { type?: string; payload?: WakePayload } | null | undefined): string {
  const p = wake?.payload || {};
  const content = String(p.content || "").trim();
  switch (wake?.type) {
    case "peer":
      return `${p.fromId || "A teammate"} sent a note:\n${content}`.trim();
    case "channel":
      return `Room ${p.channelId || ""} from ${p.fromId || "a member"}:\n${content}`.trim();
    case "subagent-complete": {
      const result = p.result != null ? JSON.stringify(p.result).slice(0, 1500) : "";
      return `Task ${p.id || ""} finished. ${result}`.trim();
    }
    case "code-agent-complete": {
      const extra = p.prUrl ? ` PR: ${p.prUrl}` : "";
      return `In-box code agent ${p.id || ""} finished.${extra}`;
    }
    case "shell":
      return `Background shell finished (${p.status || "done"}). id=${p.id || ""}. Use await_shell if you need the output.`;
    case "box-help-released":
      return "The user released Take control. Screenshot and continue what you were doing. If you were idle, just confirm you have the desktop again.";
    default:
      return content || `${wake?.type || "wake"} fired`;
  }
}

export function listWakes(botId: unknown): Wake[] {
  const idBot = normBotId(botId);
  return (queues.get(idBot) || []).map(copyWake);
}

/**
 * Drop every wake queued for `botId`. Returns how many went.
 *
 * For deleting a bot. Nothing did this, so a closed teammate's queue stayed in
 * wakes.json forever: every drain path iterates live bots
 * (`store.loadBots()`), so no take* is ever called for an id that no longer
 * exists, and a room the bot still belonged to kept enqueueing more on every
 * send. Monotonic growth of a file nothing can ever consume.
 */
/**
 * Put a wake back on the queue WITHOUT notifying subscribers.
 *
 * enqueueWake calls its listeners synchronously, and the durable-wake
 * subscriber takes the wake and starts a turn there and then. That makes it the
 * wrong tool for putting a wake back after a turn was discarded: the discard
 * happens because the epoch moved (a Stop, or a turn that ended on a card), and
 * re-firing immediately runs the very turn the epoch guard just refused — so
 * pressing Stop would not stop it.
 *
 * Silent re-queue instead. drainLeftoverWakes runs every 5s and will pick it
 * up once the bot is genuinely idle and not under human control, which is what
 * "put it back for the next drain" was supposed to mean.
 */
export function requeueWake(wake: Wake | null | undefined): Wake | null {
  if (!wake?.botId || !(WAKE_TYPES as readonly string[]).includes(String(wake.type))) return null;
  const idBot = normBotId(wake.botId);
  const row: Wake = { ...copyWake(wake), id: randomUUID(), botId: idBot, createdAt: Date.now() };
  let q = queues.get(idBot);
  if (!q) {
    q = [];
    queues.set(idBot, q);
  }
  q.push(row);
  pendingOps.push({ kind: "add", wake: row });
  persist().catch(() => {});
  return copyWake(row);
}

export function dropWakes(botId: unknown): number {
  const idBot = normBotId(botId);
  const q = queues.get(idBot);
  const n = q?.length || 0;
  if (!n) return 0;
  queues.delete(idBot);
  pendingOps.push({ kind: "drop", botId: idBot });
  persist().catch(() => {});
  return n;
}

/** Pop the highest-lane oldest wake for `botId`, or null. */
export function takeWake(botId: unknown): Wake | null {
  const idBot = normBotId(botId);
  const q = queues.get(idBot);
  if (!q || !q.length) return null;
  let bestI = 0;
  let bestLane = laneOf(q[0]);
  for (let i = 1; i < q.length; i++) {
    const lane = laneOf(q[i]);
    if (lane < bestLane) {
      bestLane = lane;
      bestI = i;
    }
  }
  const wake = q.splice(bestI, 1)[0] as Wake;
  if (!q.length) queues.delete(idBot);
  pendingOps.push({ kind: "remove", botId: idBot, id: wake.id });
  persist().catch(() => {});
  return wake;
}

/** Pop the oldest wake of `type` without stealing a higher-priority peer/user wake. */
export function takeWakeOfType(botId: unknown, type: unknown): Wake | null {
  const idBot = normBotId(botId);
  const kind = String(type || "").trim();
  const q = queues.get(idBot);
  if (!q || !q.length) return null;
  const i = q.findIndex((w) => w.type === kind);
  if (i < 0) return null;
  const wake = q.splice(i, 1)[0] as Wake;
  if (!q.length) queues.delete(idBot);
  pendingOps.push({ kind: "remove", botId: idBot, id: wake.id });
  persist().catch(() => {});
  return wake;
}

export function takeWakeById(botId: unknown, wakeId: unknown): Wake | null {
  const idBot = normBotId(botId);
  const id = String(wakeId || "").trim();
  const q = queues.get(idBot);
  if (!q || !q.length || !id) return null;
  const i = q.findIndex((w) => w.id === id);
  if (i < 0) return null;
  const wake = q.splice(i, 1)[0] as Wake;
  if (!q.length) queues.delete(idBot);
  pendingOps.push({ kind: "remove", botId: idBot, id: wake.id });
  persist().catch(() => {});
  return wake;
}

export function takeMatchingWake(botId: unknown, pred: (wake: Wake) => boolean): Wake | null {
  const idBot = normBotId(botId);
  const q = queues.get(idBot);
  if (!q || !q.length || typeof pred !== "function") return null;
  const i = q.findIndex(pred);
  if (i < 0) return null;
  const wake = q.splice(i, 1)[0] as Wake;
  if (!q.length) queues.delete(idBot);
  pendingOps.push({ kind: "remove", botId: idBot, id: wake.id });
  persist().catch(() => {});
  return wake;
}

export function resetForTest(): void {
  queues.clear();
  pendingOps = [{ kind: "clear" }];
  wakeListeners.clear();
  loaded = true;
  persist().catch(() => {});
}

export function flushWakes(): Promise<void> {
  return writeChain;
}
