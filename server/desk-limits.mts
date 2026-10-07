/**
 * Pure sizing logic for local desks: memory strings, the CPU that goes with a
 * memory cap, fitting every desk's cap inside the Docker VM, and when to reset
 * a Chrome tab that has grown too large. No docker calls here, so all of it is
 * unit-tested directly (test/desk-limits.mjs); server/vm.mts applies it.
 */
import { limitsFromRamMb } from "@sub8/desk-runtime";

/** Memory the Docker VM needs for its own kernel and dockerd, never handed to desks. */
export const VM_RESERVE_MB = 640;
/** No desk cap goes below this. */
export const DESK_FLOOR_MB = 1024;
/** A cap never goes below the desk's current usage plus this. */
export const USAGE_MARGIN_MB = 256;
/** Room an idle desk keeps above its usage when memory is tight. */
export const IDLE_HEADROOM_MB = 768;
/** Caps are rounded up to this step. */
export const CAP_STEP_MB = 128;

/** "2g", "4096m", "1.5g", "3221225472" (bytes) -> MiB. 0 when unreadable. */
export function parseMemMb(value: unknown): number {
  const s = String(value ?? "").trim().toLowerCase();
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?)(?:i?b)?$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  switch (m[2]) {
    case "t": return Math.round(n * 1024 * 1024);
    case "g": return Math.round(n * 1024);
    case "m": return Math.round(n);
    case "k": return Math.round(n / 1024);
    default: return Math.round(n / 1048576);
  }
}

/** MiB -> a docker memory string ("4g" when whole GiB, else "4352m"). */
export function memString(mb: number): string {
  const n = Math.max(1, Math.round(mb));
  return n % 1024 === 0 ? `${n / 1024}g` : `${n}m`;
}

/** The `--cpus` that goes with a memory cap: the rung at or below it. */
export function cpusForMemory(memory: unknown): string {
  const mb = typeof memory === "number" ? memory : parseMemMb(memory);
  return limitsFromRamMb(mb || 1024).cpus;
}

/** `docker update` args for a live memory change; CPU always follows memory. */
export function memoryUpdateArgs(container: string, memMb: number, extra: readonly string[] = []): string[] {
  const mem = memString(memMb);
  return ["update", "--memory", mem, "--memory-swap", mem, "--cpus", cpusForMemory(memMb), ...extra, container];
}

const stepUp = (mb: number) => Math.ceil(mb / CAP_STEP_MB) * CAP_STEP_MB;

export interface DeskSizing {
  name: string;
  /** memory.current in MiB; null when unreadable (a paused desk). */
  usedMb: number | null;
  /** Current cap in MiB (0 = none). */
  capMb: number;
  /** What this desk would like: its member-count size or a manual raise. */
  wantMb: number;
  /** A desk being created or explicitly raised: allocate to it first. */
  priority?: boolean;
}

export interface DeskCapPlan {
  caps: Map<string, number>;
  budgetMb: number;
  totalMb: number;
  /** True when even the minimum caps (floor, usage + margin) exceed the budget. */
  overBudget: boolean;
}

/** The lowest cap a desk may get: the floor, usage plus margin, and never under an unreadable desk's current cap. */
export function minCapMb(d: DeskSizing): number {
  if (d.usedMb == null) return Math.max(DESK_FLOOR_MB, d.capMb || DESK_FLOOR_MB);
  return Math.max(DESK_FLOOR_MB, stepUp(d.usedMb + USAGE_MARGIN_MB));
}

/**
 * Assign caps whose sum stays within `budgetMb`.
 *
 *  1. Every desk gets its minimum (floor, usage + margin).
 *  2. In order (priority desks, then busiest by usage): the first desk gets up to
 *     what it wants (or usage + headroom, if that is more); the others up to
 *     usage + headroom.
 *  3. Whatever is left goes, in the same order, toward each desk's want.
 *
 * When the minimums alone do not fit, every desk drops to its minimum (but no
 * desk is raised above its current cap) and overBudget is set: lowering a cap
 * below usage would only trade a slow desk for an OOM kill, so the fix there
 * is shedding memory (a tab reset), not a cap.
 */
export function allocateDeskCaps(desks: readonly DeskSizing[], budgetMb: number): DeskCapPlan {
  const caps = new Map<string, number>();
  const order = [...desks].sort((a, b) => {
    if (Boolean(a.priority) !== Boolean(b.priority)) return a.priority ? -1 : 1;
    return (b.usedMb ?? 0) - (a.usedMb ?? 0);
  });
  let total = 0;
  for (const d of order) {
    const min = minCapMb(d);
    caps.set(d.name, min);
    total += min;
  }
  if (total > budgetMb) {
    // Over budget: shrink what can shrink, raise nothing that already has a
    // cap (a higher cap in an overcommitted VM only moves the OOM kill from
    // the desk to the VM).
    total = 0;
    for (const d of order) {
      const min = caps.get(d.name)!;
      const cap = d.capMb > 0 ? Math.min(min, d.capMb) : min;
      caps.set(d.name, cap);
      total += cap;
    }
    return { caps, budgetMb, totalMb: total, overBudget: true };
  }
  const fullWant = (d: DeskSizing) =>
    Math.max(minCapMb(d), stepUp(d.wantMb || 0), d.usedMb == null ? 0 : stepUp(d.usedMb + IDLE_HEADROOM_MB));
  const give = (d: DeskSizing, target: number) => {
    const cur = caps.get(d.name)!;
    const room = Math.floor((budgetMb - total) / CAP_STEP_MB) * CAP_STEP_MB;
    const add = Math.max(0, Math.min(target - cur, room));
    if (!add) return;
    caps.set(d.name, cur + add);
    total += add;
  };
  order.forEach((d, i) => {
    const headroom = d.usedMb == null ? minCapMb(d) : stepUp(d.usedMb + IDLE_HEADROOM_MB);
    // A fresh desk (no usage yet) is sized by its want, not by an empty reading.
    const fresh = d.usedMb != null && d.usedMb < 64;
    give(d, i === 0 || d.priority || fresh ? fullWant(d) : Math.max(minCapMb(d), headroom));
  });
  for (const d of order) give(d, fullWant(d));
  return { caps, budgetMb, totalMb: total, overBudget: false };
}

/** Docker VM memory (bytes, from `docker info`) minus the VM's own reserve, in MiB. */
export function budgetFromMemTotal(memTotalBytes: unknown): number {
  const mb = Math.floor(Number(memTotalBytes) / 1048576);
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.max(DESK_FLOOR_MB, mb - VM_RESERVE_MB);
}

/** Name of the engine behind the docker CLI, for user-facing text. */
export function dockerRuntimeName({ dockerHost, context }: { dockerHost?: string | null; context?: string | null } = {}): string {
  if (/colima/i.test(String(dockerHost || "")) || /colima/i.test(String(context || ""))) return "Colima";
  return "Docker Desktop";
}

// ---------------------------------------------------------------- Chrome tabs

export interface ChromeRenderer {
  pid: number;
  rssMb: number;
  /** DevTools port of the Chrome this renderer belongs to (0 when unknown). */
  port: number;
}

/**
 * Parse `ps -eo pid=,ppid=,rss=,args=` from inside a desk. Renderers are the
 * `--type=renderer` processes; each is mapped to its browser process (the
 * ancestor carrying `--remote-debugging-port`), which says which display's
 * Chrome it is.
 */
export function parseChromeRenderers(psOut: string): ChromeRenderer[] {
  const procs = new Map<number, { ppid: number; rssKb: number; args: string }>();
  for (const line of String(psOut || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.set(Number(m[1]), { ppid: Number(m[2]), rssKb: Number(m[3]), args: m[4]! });
  }
  const portOf = (pid: number): number => {
    let cur = procs.get(pid);
    for (let hops = 0; cur && hops < 8; hops++) {
      const p = /--remote-debugging-port=(\d+)/.exec(cur.args);
      if (p) return Number(p[1]);
      cur = procs.get(cur.ppid);
    }
    return 0;
  };
  const out: ChromeRenderer[] = [];
  for (const [pid, p] of procs) {
    if (!/--type=renderer\b/.test(p.args)) continue;
    // Extension renderers are not tabs.
    if (/--extension-process\b/.test(p.args)) continue;
    out.push({ pid, rssMb: Math.round(p.rssKb / 1024), port: portOf(pid) });
  }
  return out.sort((a, b) => b.rssMb - a.rssMb);
}

export const TAB_RESET_RENDERER_FRACTION = 0.45;
export const TAB_RESET_DESK_FRACTION = 0.85;
/** Mid-turn backstop: only this close to an OOM kill. */
export const TAB_RESET_BACKSTOP_FRACTION = 0.92;
export const TAB_RESET_MIN_RSS_MB = 300;
export const TAB_RESET_INTERVAL_MS = 10 * 60 * 1000;

export interface TabResetInput {
  renderers: readonly ChromeRenderer[];
  memUsedMb: number;
  memMaxMb: number;
  /** "turn-end": the bot just finished a turn. "backstop": the bot may be mid-turn. */
  mode: "turn-end" | "backstop";
  now: number;
  lastResetAt?: number | undefined;
  /** DevTools ports of Chromes that must not be touched (Take control). */
  skipPorts?: ReadonlySet<number> | readonly number[] | undefined;
}

export type TabResetDecision =
  | { reset: false; reason: string }
  | { reset: true; reason: string; port: number; pid: number; rssMb: number };

export function decideTabReset(input: TabResetInput): TabResetDecision {
  const { renderers, memUsedMb, memMaxMb, mode, now } = input;
  if (!memMaxMb) return { reset: false, reason: "no memory cap" };
  if (input.lastResetAt && now - input.lastResetAt < TAB_RESET_INTERVAL_MS) return { reset: false, reason: "reset recently" };
  const skip = new Set(input.skipPorts || []);
  const eligible = renderers.filter((r) => r.port > 0 && !skip.has(r.port) && r.rssMb >= TAB_RESET_MIN_RSS_MB);
  const heavy = [...eligible].sort((a, b) => b.rssMb - a.rssMb)[0];
  if (!heavy) return { reset: false, reason: "no large tab" };
  const deskFrac = memUsedMb / memMaxMb;
  if (mode === "backstop") {
    if (deskFrac >= TAB_RESET_BACKSTOP_FRACTION) {
      return { reset: true, reason: `desk at ${Math.round(deskFrac * 100)}% of its cap`, port: heavy.port, pid: heavy.pid, rssMb: heavy.rssMb };
    }
    return { reset: false, reason: "below backstop threshold" };
  }
  if (heavy.rssMb >= memMaxMb * TAB_RESET_RENDERER_FRACTION) {
    return { reset: true, reason: `tab at ${Math.round((heavy.rssMb / memMaxMb) * 100)}% of the desk cap`, port: heavy.port, pid: heavy.pid, rssMb: heavy.rssMb };
  }
  if (deskFrac >= TAB_RESET_DESK_FRACTION) {
    return { reset: true, reason: `desk at ${Math.round(deskFrac * 100)}% of its cap`, port: heavy.port, pid: heavy.pid, rssMb: heavy.rssMb };
  }
  return { reset: false, reason: "within limits" };
}

export interface DevtoolsTarget {
  id: string;
  type?: string;
  url?: string;
}

/** Page targets worth reopening: real pages, not DevTools or blank tabs. */
export function resettablePages(targets: readonly DevtoolsTarget[]): DevtoolsTarget[] {
  return (targets || []).filter((t) => t && t.type === "page" && t.id && t.url && !/^(about:blank|devtools:|chrome:\/\/newtab)/.test(t.url));
}
