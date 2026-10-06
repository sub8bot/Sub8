/**
 * Turns that were running when the host stopped.
 *
 * Turn state (busy, the abort controller, the nudge bag, the 30-minute
 * watchdog) lives in memory only, so a quit or a crash mid-turn left the bot
 * idle on restart with the user's last message unanswered and nothing saying
 * so. A small marker per bot is written when a turn starts and cleared where
 * busy is cleared; whatever is still on disk at boot was interrupted.
 *
 * The marker lives in `<dataDir>/inflight.json`, never in the transcript, and
 * is written with the store's lock + atomic rename so a crash mid-write cannot
 * corrupt it. The same file keeps the interrupted entries a notice's Retry
 * button re-runs, keyed by the notice's message id.
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as store from "@sub8/store";

/** What started a turn. Only "user" turns are ever retried automatically. */
export type TurnOrigin = "user" | "routine" | "wake";

export interface InflightMarker {
  botId: string;
  turnId: string;
  /** The user message ids this turn answers (empty for hidden turns). */
  messageIds: string[];
  startedAt: number;
  source: TurnOrigin;
  /** The prompt runUserTurn was given, capped, so Retry can run it again. */
  text: string;
  hidden: boolean;
  replyTo?: string | null | undefined;
  /** runUserTurn's own `source` (user vs a teammate's report). */
  turnSource?: "user" | "report" | undefined;
  routineNames?: string[] | undefined;
  /** The durable wake this turn consumed; Retry puts it back. */
  wake?: unknown;
  /** How many times boot already re-ran this turn by itself. */
  autoRetries: number;
}

/** A background Task the parent was waiting on when the host stopped. */
export interface InterruptedTask {
  kind: "subagent";
  botId: string;
  taskId: string;
  type: string;
  prompt: string;
  startedAt: number;
}

export type InterruptedEntry = (({ kind: "turn" } & InflightMarker) | InterruptedTask) & {
  noticeId: string;
  interruptedAt: number;
};

interface InflightFile {
  turns: Record<string, InflightMarker>;
  interrupted: Record<string, InterruptedEntry>;
}

/** Auto-retry only a user turn that started less than this long ago. */
export const AUTO_RETRY_WINDOW_MS = 10 * 60_000;
/** At most this many automatic re-runs of one interrupted turn. */
export const MAX_AUTO_RETRIES = 1;
/** Retry entries older than this are dropped; the notice stays, the button goes. */
const INTERRUPTED_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_INTERRUPTED = 100;
const TEXT_CAP = 20_000;

export function inflightPath(): string {
  return path.join(store.dataDir, "inflight.json");
}

async function readFileSafe(): Promise<InflightFile> {
  try {
    const raw = JSON.parse(await fs.readFile(inflightPath(), "utf8")) as Partial<InflightFile> | null;
    return {
      turns: raw && typeof raw.turns === "object" && raw.turns ? raw.turns : {},
      interrupted: raw && typeof raw.interrupted === "object" && raw.interrupted ? raw.interrupted : {},
    };
  } catch {
    return { turns: {}, interrupted: {} };
  }
}

let chain: Promise<unknown> = Promise.resolve();

/** One read-modify-write, serialised in-process and locked across processes. */
function mutate<T>(fn: (file: InflightFile) => T): Promise<T> {
  const run = chain.then(() =>
    store.withFileLock(`${inflightPath()}.lock`, async () => {
      const file = await readFileSafe();
      const out = fn(file);
      await store.writeJsonAtomic(inflightPath(), file);
      return out;
    }),
  );
  chain = run.catch(() => {});
  return run;
}

export function capText(text: unknown): string {
  const t = String(text ?? "");
  return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t;
}

/** Record that a turn started. Replaces any older marker for the same bot. */
export function markTurnStart(marker: InflightMarker): Promise<void> {
  const row = { ...marker, text: capText(marker.text) };
  return mutate((f) => {
    f.turns[row.botId] = row;
  });
}

/**
 * Clear a bot's marker. With `turnId`, only that turn's: a turn that ends after
 * a Stop or the watchdog let a newer one start must not erase the newer marker.
 */
export function clearTurn(botId: string, turnId?: string | null): Promise<void> {
  return mutate((f) => {
    const cur = f.turns[botId];
    if (!cur) return;
    if (turnId && cur.turnId !== turnId) return;
    delete f.turns[botId];
  });
}

/** Every marker on disk, removed from the file in the same write. */
export function takeLeftoverTurns(): Promise<InflightMarker[]> {
  return mutate((f) => {
    const rows = Object.values(f.turns).filter((m) => m && typeof m.botId === "string");
    f.turns = {};
    return rows;
  });
}

export async function readInflight(): Promise<InflightFile> {
  return readFileSafe();
}

/** Keep an interrupted entry so the notice's Retry can run it again. */
export function stashInterrupted(entry: InterruptedEntry, now = Date.now()): Promise<void> {
  return mutate((f) => {
    f.interrupted[entry.noticeId] = entry;
    const rows = Object.values(f.interrupted)
      .filter((e) => now - Number(e.interruptedAt || 0) < INTERRUPTED_TTL_MS)
      .sort((a, b) => Number(b.interruptedAt) - Number(a.interruptedAt))
      .slice(0, MAX_INTERRUPTED);
    f.interrupted = Object.fromEntries(rows.map((e) => [e.noticeId, e]));
  });
}

/** Remove and return an interrupted entry (null when it was already retried). */
export function takeInterrupted(noticeId: string, botId?: string): Promise<InterruptedEntry | null> {
  return mutate((f) => {
    const e = f.interrupted[noticeId];
    if (!e || (botId && e.botId !== botId)) return null;
    delete f.interrupted[noticeId];
    return e;
  });
}

/** The slice of a transcript row this module reads. */
export interface TranscriptRow {
  id?: string | undefined;
  role?: string | undefined;
  kind?: string | undefined;
  content?: unknown;
  ts?: number | undefined;
  speakerId?: string | undefined;
  interrupted?: unknown;
  [k: string]: unknown;
}

function isActivity(m: TranscriptRow): boolean {
  return m.kind === "think" || m.kind === "tool" || m.role === "activity";
}

/**
 * Did the interrupted turn finish its answer before the host stopped?
 *
 * The marker is cleared in the turn's `finally`, so one left on disk means
 * `finally` never ran; the reply may still have been saved just before. The
 * last row the bot itself wrote at or after the start decides: a text reply
 * or a card means it answered; a tool step, a thought, the "Chrome is not
 * ready" wait line, or nothing at all means it was cut off mid-work.
 */
export function hasReply(messages: readonly TranscriptRow[] | null | undefined, marker: Pick<InflightMarker, "startedAt" | "botId">): boolean {
  const rows = (messages || []).filter((m) => m && Number(m.ts || 0) >= marker.startedAt && m.role !== "user");
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    if (m.interrupted) continue;
    if (m.speakerId && m.speakerId !== marker.botId) continue;
    if (/wait$/.test(String(m.id || ""))) continue;
    if (isActivity(m)) return false;
    if (m.role !== "assistant") continue;
    if (m.kind === "choices" || m.kind === "secret-request" || m.kind === "vault-approve") return true;
    return Boolean(String(m.content ?? "").trim());
  }
  return false;
}

export type RecoveryAction = "clear" | "retry" | "notice";

/**
 * What boot does with one leftover marker.
 *  - clear: the reply is already in the transcript (or the bot is gone).
 *  - retry: run it again once, automatically. Only a user turn, started less
 *    than AUTO_RETRY_WINDOW_MS ago, not already auto-retried, desk available.
 *  - notice: say it did not finish and offer Retry.
 */
export function planRecovery(
  marker: InflightMarker,
  { messages, botExists = true, deskReady, now = Date.now() }: { messages: readonly TranscriptRow[] | null | undefined; botExists?: boolean; deskReady: boolean; now?: number },
): RecoveryAction {
  if (!botExists) return "clear";
  if (hasReply(messages, marker)) return "clear";
  if (
    marker.source === "user" &&
    Number(marker.autoRetries || 0) < MAX_AUTO_RETRIES &&
    now - Number(marker.startedAt || 0) < AUTO_RETRY_WINDOW_MS &&
    now >= Number(marker.startedAt || 0) &&
    deskReady
  ) {
    return "retry";
  }
  return "notice";
}

/** The notice text. No em dashes. */
export function noticeText(marker: Pick<InflightMarker, "source" | "routineNames" | "replyTo">, action: "retry" | "notice"): string {
  if (action === "retry") return "Sub8 restarted while this was running. It did not finish, so I'm trying it once more now.";
  if (marker.source === "routine") {
    const names = (marker.routineNames || []).filter(Boolean);
    const what = names.length ? `the routine ${names.map((n) => `"${n}"`).join(", ")}` : "a routine";
    return `Sub8 restarted while ${what} was running. It did not finish. The next scheduled run will pick it up, or press Retry to run it now.`;
  }
  if (marker.source === "wake") {
    return "Sub8 restarted while I was picking up a finished background task or a teammate's message. It did not finish. Press Retry to pick it up again.";
  }
  return "Sub8 restarted while this was running. It did not finish. Press Retry to run it again.";
}

export function taskNoticeText(task: Pick<InterruptedTask, "type" | "prompt">): string {
  const brief = String(task.prompt || "").replace(/\s+/g, " ").trim();
  const short = brief.length > 120 ? `${brief.slice(0, 117)}...` : brief;
  return `Sub8 restarted while a background task was running (${task.type}${short ? `: ${short}` : ""}). It did not finish, so its result will not arrive. Press Retry to start it again.`;
}

/**
 * The prompt a user-turn Retry runs: the original text plus anything the user
 * typed into the turn while it ran (those were nudges, held only in memory).
 */
export function retryText(marker: Pick<InflightMarker, "text" | "startedAt" | "messageIds" | "source">, messages: readonly TranscriptRow[] | null | undefined): string {
  if (marker.source !== "user") return marker.text;
  const seen = new Set(marker.messageIds || []);
  const later = (messages || [])
    .filter((m) => m && m.role === "user" && (!m.speakerId || m.speakerId === "user") && Number(m.ts || 0) > marker.startedAt && !seen.has(String(m.id || "")))
    .map((m) => String(m.content ?? "").trim())
    .filter(Boolean);
  return later.length ? [marker.text, ...later].join("\n") : marker.text;
}

export interface NoticeRow {
  id: string;
  role: "assistant";
  kind: "notice";
  content: string;
  ts: number;
  interrupted: { source: TurnOrigin | "task"; retry: boolean };
}

export function noticeRow(content: string, source: TurnOrigin | "task", retry: boolean, now = Date.now()): NoticeRow {
  return {
    id: `int${now}${Math.random().toString(36).slice(2, 6)}`,
    role: "assistant",
    kind: "notice",
    content,
    ts: now,
    interrupted: { source, retry },
  };
}

/** What recoverInterrupted needs from the server. Injected so tests can drive it. */
export interface RecoveryDeps {
  getBot(botId: string): Promise<{ id: string; name?: string; messages?: TranscriptRow[] } | null>;
  deskReady(botId: string): Promise<boolean>;
  appendNotice(botId: string, row: NoticeRow): Promise<void>;
  /** Re-run a user turn; the new turn writes its own marker with autoRetries + 1. */
  rerun(marker: InflightMarker): void;
  now?: () => number;
}

export interface RecoveryResult {
  botId: string;
  action: RecoveryAction;
  noticeId?: string;
}

/** Boot: settle every marker left from the last run. */
export async function recoverInterrupted(deps: RecoveryDeps): Promise<RecoveryResult[]> {
  const out: RecoveryResult[] = [];
  const leftovers = await takeLeftoverTurns();
  for (const marker of leftovers) {
    const now = deps.now ? deps.now() : Date.now();
    const bot = await deps.getBot(marker.botId).catch(() => null);
    const ready = bot ? await deps.deskReady(marker.botId).catch(() => false) : false;
    const action = planRecovery(marker, { messages: bot?.messages, botExists: Boolean(bot), deskReady: ready, now });
    if (action === "clear") {
      out.push({ botId: marker.botId, action });
      continue;
    }
    const text = retryText(marker, bot?.messages);
    if (action === "retry") {
      const row = noticeRow(noticeText(marker, "retry"), marker.source, false, now);
      await deps.appendNotice(marker.botId, row);
      deps.rerun({ ...marker, text, autoRetries: Number(marker.autoRetries || 0) + 1 });
      out.push({ botId: marker.botId, action, noticeId: row.id });
      continue;
    }
    const row = noticeRow(noticeText(marker, "notice"), marker.source, true, now);
    await stashInterrupted({ kind: "turn", ...marker, text, noticeId: row.id, interruptedAt: now }, now);
    await deps.appendNotice(marker.botId, row);
    out.push({ botId: marker.botId, action, noticeId: row.id });
    // A teammate's turn for its lead: the lead handed off and is waiting for a
    // report that will not come. Tell it too; the Retry lives on the worker.
    if (marker.replyTo && marker.replyTo !== marker.botId) {
      const lead = await deps.getBot(marker.replyTo).catch(() => null);
      if (lead) {
        const who = bot?.name || "A teammate";
        await deps.appendNotice(lead.id, noticeRow(`Sub8 restarted while ${who} was working on your request. It did not finish. Retry it from ${who}'s chat.`, "wake", false, now));
      }
    }
  }
  return out;
}

/**
 * Background Tasks (subagents) run inside this process, so a restart ends them
 * without a result -- and the parent, which ended its turn to wait for the
 * `subagent-complete` wake, waits forever. tasks.json still lists them as
 * "running"; mark them failed so a second restart does not report them again.
 */
export async function takeInterruptedTasks(tasksFile: string): Promise<InterruptedTask[]> {
  let rows: Record<string, unknown>[];
  try {
    const raw = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    if (!Array.isArray(raw)) return [];
    rows = raw;
  } catch {
    return [];
  }
  const out: InterruptedTask[] = [];
  const now = Date.now();
  for (const r of rows) {
    if (!r || r.status !== "running" || !r.botId) continue;
    out.push({
      kind: "subagent",
      botId: String(r.botId),
      taskId: String(r.id || ""),
      type: String(r.type || "executor"),
      prompt: capText(r.prompt),
      startedAt: Number(r.createdAt) || now,
    });
    r.status = "failed";
    r.error = "interrupted: Sub8 restarted";
    r.updatedAt = now;
  }
  if (out.length) await store.writeJsonAtomic(tasksFile, rows);
  return out;
}

/** Boot: one notice (with Retry) per parent for each Task the restart ended. */
export async function recoverInterruptedTasks(
  tasksFile: string,
  deps: Pick<RecoveryDeps, "getBot" | "appendNotice" | "now">,
): Promise<RecoveryResult[]> {
  const out: RecoveryResult[] = [];
  for (const task of await takeInterruptedTasks(tasksFile)) {
    const bot = await deps.getBot(task.botId).catch(() => null);
    if (!bot) continue;
    const now = deps.now ? deps.now() : Date.now();
    const row = noticeRow(taskNoticeText(task), "task", true, now);
    await stashInterrupted({ ...task, noticeId: row.id, interruptedAt: now }, now);
    await deps.appendNotice(task.botId, row);
    out.push({ botId: task.botId, action: "notice", noticeId: row.id });
  }
  return out;
}
