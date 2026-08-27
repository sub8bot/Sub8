import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
function dataRoot(): string {
  return process.env.SUB8BOT_DATA || process.env.OCTOBOT_DATA || path.join(process.cwd(), "data");
}
import { enqueueWake } from "@sub8/wakes";

/** `runDeskTurn` from ./desk-client.mjs — the /turn driver, injectable in tests. */
export type DeskTurnDriver = typeof import("./desk-client.mjs").runDeskTurn;

export type SubagentStatus = "running" | "done" | "failed" | "cancelled";

/** `SUBAGENT_TOOL_ALLOWLIST` is looked up by a plain string, hence the index signature. */
export interface ToolAllowlist {
  executor: readonly string[];
  browserUse: readonly string[];
  computerUse: readonly string[];
  watchVideo: readonly string[];
  videoReview: readonly string[];
  [type: string]: readonly string[] | undefined;
}

/** One `message()` note, appended to a running worker. */
export interface SubagentMessage {
  role: string;
  content: string;
  ts: number;
}

/** A worker as this module holds it in memory and mirrors it to tasks.json. */
export interface SubagentRow {
  id: string;
  botId: string;
  type: string;
  prompt: string;
  status: SubagentStatus;
  tools: string[];
  computerId: string | null;
  container: string | null;
  display: string | null;
  cwd: string | null;
  harnessUrl: string | null;
  harnessToken: string | null;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
  messages?: SubagentMessage[];
}

/** What callers and tasks.json see. Never the harness token. */
export interface SubagentView {
  id: string;
  botId: string;
  parentBotId: string;
  type: string;
  status: SubagentStatus;
  tools: string[];
  createdAt: number;
  updatedAt: number;
  prompt?: string;
  result?: unknown;
  error?: string;
  computerId?: string;
  container?: string;
  cwd?: string;
}

/** The parent wake a finished worker pushes. */
export interface SubagentWake {
  type: "subagent-complete";
  parentBotId: string;
  id: string;
  result: unknown;
}

export type SubagentWakeListener = (wake: SubagentWake) => void;

/** Whatever drives one worker's turn. `defaultHarnessTurn` is the built-in. */
export type TurnRunner = (row: SubagentRow) => unknown;

/** The job fields `defaultHarnessTurn` reads off a row. */
export interface HarnessJob {
  id?: string | undefined;
  type: string;
  botId?: string | undefined;
  prompt?: string | undefined;
  harnessUrl?: string | null | undefined;
  harnessToken?: string | null | undefined;
}

export interface SpawnOptions {
  botId?: unknown;
  type?: unknown;
  prompt?: unknown;
  /** The X display this worker will drive, e.g. ":2". Desks run several. */
  display?: string | null | undefined;
  computerId?: string | null | undefined;
  container?: string | null | undefined;
  cwd?: string | null | undefined;
  harnessUrl?: string | null | undefined;
  harnessToken?: string | null | undefined;
}

interface FinishOptions {
  status?: SubagentStatus | undefined;
  result?: unknown;
  error?: string | undefined;
}

/** Task workers. Parent delivers; workers never send_message to the user. */
export const SUBAGENT_TYPES = Object.freeze([
  "executor",
  "browserUse",
  "computerUse",
  "watchVideo",
  "videoReview",
]);

export const SUBAGENT_TOOL_ALLOWLIST: Readonly<ToolAllowlist> = Object.freeze({
  executor: Object.freeze(["shell", "read", "computer", "browser", "web_search", "web_fetch"]),
  browserUse: Object.freeze(["browser", "web_search", "web_fetch"]),
  computerUse: Object.freeze(["computer"]),
  watchVideo: Object.freeze(["read"]),
  videoReview: Object.freeze(["read"]),
});

/** What desk-harness/harness.mts `finish()` emits when its turn is aborted. */
const STOPPED_SENTINEL = "Stopped.";

const sessions = new Map<string, SubagentRow>();
// Aborting the host fetch is what actually stops a desk worker: the harness
// kills its grok child on `res.on("close")`. Without it `stop_subagent` only
// relabelled the row while the worker kept driving the display for up to 20
// minutes, and its result was then dropped on the floor by runWorker.
const controllers = new Map<string, AbortController>();
const wakeQueue: SubagentWake[] = [];
const wakeListeners = new Set<SubagentWakeListener>();
let turnRunner: TurnRunner | null = null;
let persistChain: Promise<void> = Promise.resolve();

function tasksPath(): string {
  return path.join(dataRoot(), "tasks.json");
}

export function setTurnRunner(fn: TurnRunner | null | undefined): void {
  turnRunner = typeof fn === "function" ? fn : null;
}

function assertNoSendMessage(tools: readonly string[]): void {
  if (tools.includes("send_message") || tools.includes("SendMessage")) {
    throw new Error("subagent tool allowlist must not include send_message");
  }
}

export function toolsForType(type: string): string[] {
  const tools = SUBAGENT_TOOL_ALLOWLIST[type];
  if (!tools) throw new Error(`unknown subagent type: ${type}`);
  assertNoSendMessage(tools);
  return [...tools];
}

function publicView(row: SubagentRow): SubagentView {
  const out: SubagentView = {
    id: row.id,
    botId: row.botId,
    parentBotId: row.botId,
    type: row.type,
    status: row.status,
    tools: [...row.tools],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.prompt != null) out.prompt = row.prompt;
  if (row.result !== undefined) out.result = row.result;
  if (row.error) out.error = row.error;
  if (row.computerId) out.computerId = row.computerId;
  if (row.container) out.container = row.container;
  if (row.cwd) out.cwd = row.cwd;
  return out;
}

function persistIndex(): Promise<void> {
  persistChain = persistChain
    .then(async () => {
      await fs.mkdir(dataRoot(), { recursive: true });
      const rows = [...sessions.values()].map(publicView);
      await fs.writeFile(tasksPath(), JSON.stringify(rows, null, 2));
    })
    .catch(() => {});
  return persistChain;
}

function emitWake(wake: SubagentWake): SubagentWake {
  wakeQueue.push(wake);
  try {
    enqueueWake({
      type: "subagent-complete",
      botId: wake.parentBotId,
      payload: { parentId: wake.parentBotId, id: wake.id, result: wake.result },
    });
  } catch {
    /* durable ledger is best-effort in tests without data dir */
  }
  for (const fn of wakeListeners) {
    try {
      fn(wake);
    } catch {
      /* listener errors must not break workers */
    }
  }
  return wake;
}

export function subscribeWakes(fn: SubagentWakeListener): () => boolean {
  wakeListeners.add(fn);
  return () => wakeListeners.delete(fn);
}

export function takeWakes(): SubagentWake[] {
  return wakeQueue.splice(0, wakeQueue.length);
}

export function resetForTest(): void {
  sessions.clear();
  wakeQueue.length = 0;
  wakeListeners.clear();
  turnRunner = null;
}

function deskKey(row: SubagentRow): string {
  return row.computerId || row.container || row.botId;
}

/**
 * The desk a worker actually drives -- NOT deskKey's botId fallback, which
 * would make two deskless executors on one bot collide.
 */
function displayKey(row: SubagentRow): string | null {
  const desk = row.computerId || row.container || null;
  if (!desk) return null;
  // Desk AND display. A desk runs up to DISPLAY_SLOTS X displays and teammates
  // sit on different ones -- keying on the desk alone would have blocked two
  // teammates from running executors at the same time, which is the normal
  // case, not the collision. Bots that genuinely share a display still collide.
  return `${desk}::${String(row.display || ":1")}`;
}

/** Any running worker whose allowlist includes `computer` is driving that display. */
function runningOnDisplay(key: string): SubagentRow | null {
  for (const row of sessions.values()) {
    if (row.status !== "running") continue;
    if (!toolsForType(row.type).includes("computer")) continue;
    if (displayKey(row) === key) return row;
  }
  return null;
}

function runningComputerUse(key: string | null, { botId }: { botId?: string | undefined } = {}): SubagentRow | null {
  for (const row of sessions.values()) {
    if (row.type !== "computerUse" || row.status !== "running") continue;
    if (botId && row.botId === botId) return row;
    if (key && deskKey(row) === key) return row;
  }
  return null;
}

/** Restricted harness /turn: never send_message. Used when spawn has harnessUrl. */
export async function defaultHarnessTurn(
  job: HarnessJob,
  { runTurn }: { runTurn?: DeskTurnDriver | undefined } = {},
): Promise<{ content: string; tools: string[] }> {
  const url = job?.harnessUrl;
  if (!url) throw new Error("task harness url required");
  const tools = toolsForType(job.type);
  assertNoSendMessage(tools);
  const drive = runTurn || (await import("./desk-client.mjs")).runDeskTurn;
  let err = "";
  const out = await drive({
    url,
    token: job.harnessToken || "",
    body: {
      botId: job.botId,
      content: job.prompt,
      system: `You are a Task worker (${job.type}). Allowed tools: ${tools.join(", ")}. Never send_message. Never talk to the user. Parent delivers.`,
      tools,
      subagent: true,
    },
    onEvent: (ev) => {
      if (ev?.type === "error") err = String(ev.message || "task error");
    },
    ...(job.id && controllers.has(job.id) ? { signal: controllers.get(job.id)!.signal } : {}),
  });
  if (err) throw new Error(err);
  const content = String(out?.content || "").trim();
  // A stopped turn is not a finished one. The harness answers an abort with
  // `{type:"done", content:"Stopped."}` and emits no error event, so without
  // this the parent was woken with `status:"done"` and the result "Stopped."
  // as though the task had succeeded. Desk-wide `/stop` aborts every turn on
  // the port, so a parent ending its own turn on a card trips this too.
  // (A worker whose real reply is exactly "Stopped." is mislabelled failed --
  // the cheaper error of the two.)
  if (content === STOPPED_SENTINEL) throw new Error("task stopped");
  return { content, tools };
}

async function runWorker(row: SubagentRow): Promise<void> {
  const runner: TurnRunner | null = turnRunner || (row.harnessUrl ? defaultHarnessTurn : null);
  if (!runner) return;
  const ac = new AbortController();
  controllers.set(row.id, ac);
  try {
    const result = await runner(row);
    if (row.status !== "running") return;
    finish(row.id, { status: "done", result });
  } catch (err) {
    if (row.status !== "running") return;
    finish(row.id, { status: "failed", error: String((err as Error | undefined)?.message || err) });
  } finally {
    controllers.delete(row.id);
  }
}

function finish(id: string, { status, result, error }: FinishOptions = {}): SubagentWake | SubagentView | null {
  const row = sessions.get(id);
  if (!row || row.status !== "running") return null;
  row.status = status || "done";
  if (result !== undefined) row.result = result;
  if (error) row.error = error;
  row.updatedAt = Date.now();
  persistIndex();
  if (row.status === "done") {
    return emitWake({
      type: "subagent-complete",
      parentBotId: row.botId,
      id: row.id,
      result: row.result,
    });
  }
  return publicView(row);
}

/**
 * Start a Task worker. Returns immediately `{ id, status: "running" }`.
 * `computerUse`: at most one running worker per desk (or per bot when no desk id).
 */
export async function spawn({ botId, type = "executor", prompt, display, computerId, container, cwd, harnessUrl, harnessToken }: SpawnOptions = {}): Promise<SubagentView> {
  const idBot = String(botId || "").trim();
  if (!idBot) throw new Error("spawn requires botId");
  const kind = String(type || "executor");
  if (!SUBAGENT_TYPES.includes(kind)) throw new Error(`unknown subagent type: ${kind}`);
  const brief = String(prompt ?? "").trim();
  if (!brief) throw new Error("spawn requires a self-contained prompt");
  const tools = toolsForType(kind);
  const now = Date.now();
  const row: SubagentRow = {
    id: randomUUID(),
    botId: idBot,
    type: kind,
    prompt: brief,
    status: "running",
    tools,
    computerId: computerId || null,
    container: container || null,
    cwd: cwd || null,
    display: display ? String(display) : null,
    harnessUrl: harnessUrl || null,
    harnessToken: harnessToken || null,
    createdAt: now,
    updatedAt: now,
  };
  if (kind === "computerUse") {
    if (runningComputerUse(null, { botId: idBot })) {
      throw new Error("computerUse: at most one running per bot");
    }
    const key = deskKey(row);
    if (key && runningComputerUse(key)) {
      throw new Error("display busy");
    }
  }
  // `computerUse` is not the only type that drives a desktop -- `executor`
  // carries `computer` too, so three executors could point three grok children
  // at one X display, which is the exact state the guard above exists to
  // prevent. Scoped to a real desk so two deskless executors stay allowed.
  const slot = displayKey(row);
  if (slot && toolsForType(kind).includes("computer") && runningOnDisplay(slot)) {
    throw new Error("display busy");
  }
  sessions.set(row.id, row);
  persistIndex();
  queueMicrotask(() => {
    runWorker(row);
  });
  return publicView(row);
}

export async function list(botId?: string): Promise<SubagentView[]> {
  const rows = [...sessions.values()];
  const filtered = botId ? rows.filter((row) => row.botId === botId) : rows;
  return filtered.map(publicView);
}

/**
 * `botId` scopes the lookup to the caller's own workers. Optional so the
 * existing internal callers keep working; every model-facing dispatch passes
 * it, because an id alone let one bot read, steer and cancel another's task.
 */
function owned(id: string, botId?: string | undefined): SubagentRow | null {
  const row = sessions.get(id);
  if (!row) return null;
  if (botId && row.botId !== botId) return null;
  return row;
}

export async function get(id: string, botId?: string | undefined): Promise<SubagentView | null> {
  const row = owned(id, botId);
  return row ? publicView(row) : null;
}

export async function message(
  id: string,
  text: unknown,
  botId?: string | undefined,
): Promise<SubagentView & { delivered: false; note: string }> {
  const row = owned(id, botId);
  if (!row) throw new Error(`subagent not found: ${id}`);
  if (row.status !== "running") throw new Error(`subagent is not running: ${id}`);
  row.messages = row.messages || [];
  row.messages.push({ role: "user", content: String(text || ""), ts: Date.now() });
  row.updatedAt = Date.now();
  persistIndex();
  // Say so plainly. The worker's /turn was posted once at spawn and nothing
  // re-reads this list, so a caller told "steer a running Task" reasonably
  // believed the note had arrived and moved on. It has not: to change course,
  // stop the task and spawn a new one with the revised prompt.
  return {
    ...publicView(row),
    delivered: false as const,
    note: "Recorded, but NOT delivered to the running worker: stop the task and respawn it to change course.",
  };
}

export async function stop(id: string, botId?: string | undefined): Promise<SubagentView> {
  const row = owned(id, botId);
  if (!row) throw new Error(`subagent not found: ${id}`);
  if (row.status === "running") {
    row.status = "cancelled";
    row.updatedAt = Date.now();
    persistIndex();
    // Hanging up the host fetch is what reaches the desk; see `controllers`.
    try {
      controllers.get(id)?.abort();
    } catch {
      /* already settled */
    }
  }
  return publicView(row);
}

/** Tests (and later the real worker) mark a job done and push a parent wake. */
export function completeForTest(id: string, result: unknown): SubagentWake | SubagentView | null {
  const row = sessions.get(id);
  if (!row) throw new Error(`subagent not found: ${id}`);
  if (row.status !== "running") throw new Error(`subagent is not running: ${id}`);
  return finish(id, { status: "done", result });
}
