import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataDir as defaultDataDir } from "./paths.mjs";
import { enqueueWake } from "@sub8/wakes";

/** One coding session as it sits in code-agents.json. */
export interface CodeAgentMessage {
  role: string;
  content: string;
  at: number;
}

export interface CodeAgentRow {
  id: string;
  botId: string;
  computerId: string;
  cwd: string;
  status: string;
  prompt?: string | undefined;
  repoUrl?: string | undefined;
  branch?: string | undefined;
  prUrl?: string | undefined;
  images?: unknown[] | undefined;
  messages?: CodeAgentMessage[] | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  /** Rows on disk were written by whatever build made them; keep the rest. */
  [key: string]: unknown;
}

/** What every reader outside this module sees. Absent fields stay absent. */
export interface CodeAgentView {
  id: string;
  botId: string;
  computerId: string;
  cwd: string;
  status: string;
  repoUrl?: string;
  branch?: string;
  prompt?: string;
  prUrl?: string;
  messages?: CodeAgentMessage[];
  createdAt?: number;
  updatedAt?: number;
}

export interface CodeAgentWake {
  type: string;
  botId: string;
  id: string;
  prUrl?: string | undefined;
}

/** The desk half of a bot record. Callers pass the whole, much wider, bot. */
export interface CodeAgentBotVm {
  computerId?: string | undefined;
  container?: string | undefined;
  deskUrl?: string | undefined;
  deskToken?: string | undefined;
  [key: string]: unknown;
}

export interface CodeAgentBot {
  id: string;
  vm?: CodeAgentBotVm | undefined;
}

/** A bot `botHasDesk` has vouched for: `vm` is there. */
export type CodeAgentBotWithDesk = CodeAgentBot & { vm: CodeAgentBotVm };

/** The desk driver `launchCodeAgent` is handed. Every method is optional. */
export interface CodeAgentVm {
  mkdirp?: ((cwd: string) => unknown) | undefined;
  exec?: ((command: string) => unknown) | undefined;
  write?: ((file: string, body: string) => unknown) | undefined;
}

const CONFIG_ROOT = "/config";
const here = path.dirname(fileURLToPath(import.meta.url));
const distCodeAgent = path.resolve(here, "../packages/orchestration/dist/code-agent.js");

function fallbackAssertCodeAgentCwd(cwd: unknown): string {
  const raw = String(cwd ?? "").trim();
  if (!raw.startsWith("/")) {
    throw new Error("cwd must be under /config");
  }
  const n = path.posix.normalize(raw);
  if (n !== CONFIG_ROOT && !n.startsWith(`${CONFIG_ROOT}/`)) {
    throw new Error("cwd must be under /config");
  }
  return n;
}

export const assertCodeAgentCwd: (cwd: unknown) => string = existsSync(distCodeAgent)
  ? (await import(pathToFileURL(distCodeAgent).href)).assertCodeAgentCwd
  : fallbackAssertCodeAgentCwd;

export const CODE_AGENT_ACTIONS = Object.freeze(["launch", "list", "get", "reply", "cancel", "delete"]);

let overrideDataDir: string | null = null;
const wakeQueue: CodeAgentWake[] = [];
const wakeListeners = new Set<(wake: CodeAgentWake) => void>();
let writeChain: Promise<void> = Promise.resolve();

function withFile<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function configureCodeAgents({ dataDir }: { dataDir?: string | null | undefined } = {}): void {
  if (dataDir != null) overrideDataDir = dataDir;
}

function storeDir(): string {
  return overrideDataDir || process.env.SUB8BOT_DATA || process.env.OCTOBOT_DATA || defaultDataDir;
}

export function codeAgentsPath(): string {
  return path.join(storeDir(), "code-agents.json");
}

function emitWake(wake: CodeAgentWake): CodeAgentWake {
  wakeQueue.push(wake);
  try {
    enqueueWake({
      type: "code-agent-complete",
      botId: wake.botId,
      payload: { id: wake.id, prUrl: wake.prUrl || "" },
    });
  } catch {
    /* durable ledger is best-effort in tests without data dir */
  }
  for (const fn of wakeListeners) {
    try {
      fn(wake);
    } catch {
      /* listener errors must not break sessions */
    }
  }
  return wake;
}

export function subscribeWakes(fn: (wake: CodeAgentWake) => void): () => boolean {
  wakeListeners.add(fn);
  return () => wakeListeners.delete(fn);
}

export function takeWakes(): CodeAgentWake[] {
  return wakeQueue.splice(0, wakeQueue.length);
}

export function botHasDesk(bot: CodeAgentBot | null | undefined): bot is CodeAgentBotWithDesk {
  const vm = bot?.vm;
  if (!vm) return false;
  if (vm.computerId) return true;
  if (vm.container) return true;
  if (vm.deskUrl && vm.deskToken) return true;
  return false;
}

function computerIdFor(bot: CodeAgentBotWithDesk): string {
  return String(bot.vm.computerId || bot.vm.container || bot.vm.deskUrl || "desk");
}

function publicView(row: CodeAgentRow): CodeAgentView {
  const out: CodeAgentView = {
    id: row.id,
    botId: row.botId,
    computerId: row.computerId,
    cwd: row.cwd,
    status: row.status,
  };
  if (row.repoUrl) out.repoUrl = row.repoUrl;
  if (row.branch) out.branch = row.branch;
  if (row.prompt != null) out.prompt = row.prompt;
  if (row.prUrl) out.prUrl = row.prUrl;
  if (row.messages) out.messages = row.messages;
  if (row.createdAt) out.createdAt = row.createdAt;
  if (row.updatedAt) out.updatedAt = row.updatedAt;
  return out;
}

async function readAll(): Promise<CodeAgentRow[]> {
  try {
    const rows = JSON.parse(await fs.readFile(codeAgentsPath(), "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: CodeAgentRow[]): Promise<CodeAgentRow[]> {
  const dir = storeDir();
  await fs.mkdir(dir, { recursive: true });
  const file = codeAgentsPath();
  const tmp = path.join(dir, `.code-agents.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2));
  await fs.rename(tmp, file);
  return rows;
}

function updateSession(id: string, fn: (cur: CodeAgentRow) => CodeAgentRow): Promise<CodeAgentRow>;
function updateSession(id: string, fn: (cur: CodeAgentRow) => null): Promise<null>;
async function updateSession(id: string, fn: (cur: CodeAgentRow) => CodeAgentRow | null): Promise<CodeAgentRow | null> {
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((row) => row.id === id);
    if (i < 0) throw new Error(`code agent session not found: ${id}`);
    // `!` on rows[i]: the line above returned unless findIndex found a row, so
    // the slot is filled. A runtime guard would add a branch this never had.
    const next = fn(rows[i]!);
    if (next == null) {
      rows.splice(i, 1);
      await writeAll(rows);
      return null;
    }
    rows[i] = next;
    await writeAll(rows);
    return rows[i]!;
  });
}

export async function resetForTest(): Promise<void> {
  wakeQueue.length = 0;
  wakeListeners.clear();
  await withFile(() => writeAll([]));
}

async function ensureSessionOnVm(vm: CodeAgentVm | null | undefined, session: CodeAgentRow): Promise<void> {
  if (!vm) return;
  if (typeof vm.mkdirp === "function") await vm.mkdirp(session.cwd);
  if (typeof vm.exec === "function") {
    await vm.exec(`mkdir -p ${JSON.stringify(session.cwd)}`);
  }
  if (typeof vm.write === "function") {
    await vm.write(
      `${session.cwd}/.code-agent/${session.id}.json`,
      JSON.stringify({ id: session.id, prompt: session.prompt, branch: session.branch || null }),
    );
  }
}

export interface LaunchCodeAgentInput {
  repoUrl?: string | undefined;
  prompt?: string | undefined;
  branch?: string | undefined;
  images?: unknown[] | undefined;
  cwd?: string | undefined;
}

export interface LaunchCodeAgentOpts {
  vm?: CodeAgentVm | null | undefined;
}

/** Start a coding session on this bot's existing desk. Same VM, same `/config`. */
export async function launchCodeAgent(
  bot: CodeAgentBot | null | undefined,
  { repoUrl, prompt, branch, images, cwd }: LaunchCodeAgentInput = {},
  opts: LaunchCodeAgentOpts = {},
): Promise<{ id: string; status: string }> {
  if (!botHasDesk(bot)) {
    throw new Error("code agent requires a desk (bot has no computer)");
  }
  const normalizedCwd = assertCodeAgentCwd(cwd || "/config/workspace");
  const brief = String(prompt ?? "").trim();
  if (!brief) throw new Error("launch requires a prompt");
  const now = Date.now();
  const row: CodeAgentRow = {
    id: randomUUID(),
    botId: bot.id,
    computerId: computerIdFor(bot),
    cwd: normalizedCwd,
    status: "running",
    prompt: brief,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  if (repoUrl) row.repoUrl = String(repoUrl);
  if (branch) row.branch = String(branch);
  if (images?.length) row.images = images;
  await withFile(async () => {
    const rows = await readAll();
    rows.push(row);
    await writeAll(rows);
  });
  await ensureSessionOnVm(opts.vm, row);
  return { id: row.id, status: "running" };
}

export async function listCodeAgents(bot?: CodeAgentBot | null | undefined): Promise<CodeAgentView[]> {
  const rows = await readAll();
  if (!bot) return rows.map(publicView);
  return rows.filter((row) => row.botId === bot.id).map(publicView);
}

export async function getCodeAgent(bot: CodeAgentBot | null | undefined, id: string): Promise<CodeAgentView | null> {
  const rows = await readAll();
  const row = rows.find((item) => item.id === id);
  if (!row) return null;
  if (bot && row.botId !== bot.id) return null;
  return publicView(row);
}

export async function replyCodeAgent(bot: CodeAgentBot | null | undefined, id: string, message: unknown): Promise<CodeAgentView> {
  const text = String(message ?? "").trim();
  if (!text) throw new Error("reply requires a message");
  const row = await updateSession(id, (cur) => {
    if (bot && cur.botId !== bot.id) throw new Error("code agent session not found");
    if (cur.status !== "running") throw new Error("code agent session is not running");
    const messages = [...(cur.messages || []), { role: "user", content: text, at: Date.now() }];
    return { ...cur, messages, updatedAt: Date.now() };
  });
  return publicView(row);
}

/** Stop the session. Leaves `bot.vm` and the desk untouched. */
export async function cancelCodeAgent(bot: CodeAgentBot | null | undefined, id: string): Promise<CodeAgentView> {
  const row = await updateSession(id, (cur) => {
    if (bot && cur.botId !== bot.id) throw new Error("code agent session not found");
    if (cur.status !== "running") return cur;
    return { ...cur, status: "cancelled", updatedAt: Date.now() };
  });
  return publicView(row);
}

/** Drop the session record only. Does not touch the VM or git checkout. */
export async function deleteCodeAgent(bot: CodeAgentBot | null | undefined, id: string): Promise<{ id: string; deleted: boolean }> {
  await updateSession(id, (cur) => {
    if (bot && cur.botId !== bot.id) throw new Error("code agent session not found");
    return null;
  });
  return { id, deleted: true };
}

export async function completeForTest(id: string, { prUrl }: { prUrl?: string | undefined } = {}): Promise<CodeAgentWake> {
  const row = await updateSession(id, (cur) => {
    const next: CodeAgentRow = { ...cur, status: "done", updatedAt: Date.now() };
    if (prUrl) next.prUrl = String(prUrl);
    return next;
  });
  const wake: CodeAgentWake = { type: "code-agent-complete", botId: row.botId, id: row.id };
  if (row.prUrl) wake.prUrl = row.prUrl;
  return emitWake(wake);
}
