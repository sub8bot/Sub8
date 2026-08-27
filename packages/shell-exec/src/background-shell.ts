import { randomUUID } from "node:crypto";

import type {
  ShellBot,
  ShellResult,
  ShellView,
  ShellWakeFn,
  StartShellArgs,
  StartedShell,
} from "./types.js";

/** The in-memory row: the public view plus the bits only this module needs. */
interface ShellJob extends ShellView {
  wakeOnComplete?: boolean;
  promise?: Promise<ShellView>;
}

const jobs = new Map<string, ShellJob>();
let onCompleteWake: ShellWakeFn | null = null;

export function setOnCompleteWake(fn: ShellWakeFn | null | undefined): void {
  onCompleteWake = typeof fn === "function" ? fn : null;
}

function publicView(row: ShellJob): ShellView {
  return {
    id: row.id,
    botId: row.botId,
    command: row.command,
    status: row.status,
    output: row.output || "",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt || null,
  };
}

export function resetForTest(): void {
  jobs.clear();
}

export function listShells(botId?: string): ShellView[] {
  return [...jobs.values()].filter((j) => !botId || j.botId === botId).map(publicView);
}

export function getShell(id: string): ShellView | null {
  const row = jobs.get(id);
  return row ? publicView(row) : null;
}

/**
 * Run a shell. `blockUntilMs === 0` returns immediately with status=running.
 * `run` is injected (vm.shell) so tests stay off Docker.
 */
export async function startShell({ botId, command, blockUntilMs = 30_000, run }: StartShellArgs = {}): Promise<StartedShell> {
  const idBot = String(botId || "").trim();
  const cmd = String(command || "").trim();
  if (!idBot) throw new Error("botId required");
  if (!cmd) throw new Error("command required");
  const now = Date.now();
  const row: ShellJob = {
    id: randomUUID(),
    botId: idBot,
    command: cmd,
    status: "running",
    output: "",
    startedAt: now,
    finishedAt: null,
  };
  jobs.set(row.id, row);
  const wait = Number(blockUntilMs);
  row.wakeOnComplete = !Number.isFinite(wait) || wait <= 0;
  const work = Promise.resolve()
    .then((): ShellResult | Promise<ShellResult> => (typeof run === "function" ? run(cmd) : { ok: true, output: "" }))
    .then((r) => {
      row.status = r?.ok === false ? "failed" : "done";
      row.output = String(r?.output ?? r?.text ?? "");
      row.finishedAt = Date.now();
      fireWake(row);
      return publicView(row);
    })
    .catch((err: unknown) => {
      row.status = "failed";
      row.output = String((err as Error)?.message || err);
      row.finishedAt = Date.now();
      fireWake(row);
      return publicView(row);
    });
  row.promise = work;
  if (!Number.isFinite(wait) || wait <= 0) {
    return { ...publicView(row), background: true };
  }
  // The timer has to be cleared, not just lost to the race: an uncleared one
  // holds the event loop for the whole block window, so a host process that ran
  // one 5ms shell sat there for another 30 seconds before it could exit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, wait);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (row.status === "running") row.wakeOnComplete = true;
  return publicView(row);
}

function fireWake(row: ShellJob | null | undefined): void {
  if (!row?.wakeOnComplete || typeof onCompleteWake !== "function") return;
  try {
    onCompleteWake({
      type: "shell",
      botId: row.botId,
      payload: { id: row.id, status: row.status, command: row.command },
    });
  } catch {
    /* ignore */
  }
}

/**
 * `botId` scopes the wait, and it is not optional in practice.
 *
 * `jobs` is a module-level Map shared by every bot in the process -- one server
 * runs them all -- and this used to pick the newest RUNNING job across the whole
 * map when no id was given. The tool schema makes `id` optional and the
 * description invites the bare call, so bot A calling await_shell with no id
 * blocked on teammate B's command and was then handed B's botId, command and
 * full output, which attachToBot went on to persist onto A's row.
 *
 * listShells(botId) has always filtered; startShell requires and stores a
 * botId. This was the odd one out. Passing an `id` that belongs to another bot
 * is refused for the same reason.
 */
export async function awaitShell(id?: string, botId?: string): Promise<ShellView | null> {
  const mine = (j: { botId?: string | undefined }) => !botId || j.botId === botId;
  if (id) {
    const row = jobs.get(id);
    if (!row || !mine(row)) return null;
    if (row.promise) await row.promise;
    return publicView(row);
  }
  const ours = [...jobs.values()].filter(mine);
  const last = ours.filter((j) => j.status === "running").at(-1) || ours.at(-1);
  if (!last) return null;
  if (last.promise) await last.promise;
  return publicView(last);
}

/**
 * Newest MAX_ATTACHED only. Each entry carries the command's whole output, and
 * this list is persisted on the bot row, so an unbounded one grows forever: a
 * routine running `shell` every five minutes adds ~288 entries a day, and every
 * store write pays for all of them. The cap is generous next to what
 * await_shell is for -- picking up a job from the turn that started it.
 */
const MAX_ATTACHED = 20;

export function attachToBot(bot: ShellBot | null | undefined, job: ShellView): ShellView {
  if (!bot) return job;
  const view = publicView(job);
  const kept = [...(bot.backgroundShells || []).filter((j) => j.id !== view.id), view];
  bot.backgroundShells = kept.slice(-MAX_ATTACHED);
  return view;
}
