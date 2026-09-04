import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRoot, dataDir } from "./paths.mjs";
import { pluginsForHarness, createPluginsCache, pluginsPromptBlock, type HarnessExec, type ExecResult } from "@sub8/harness-plugins";
import * as vault from "./vault.mjs";
import * as ctx from "./context.mjs";
import * as memory from "./memory.mjs";
import { rewriteHarnessOutput } from "@sub8/harness-auth";
import * as identities from "./identities.mjs";

import type { ContextBot, ContextSettings } from "./context.mjs";

/**
 * The env a spawned CLI's MCP server is handed. Values are stringified at every
 * use site (`JSON.stringify(String(v))`), which is why an unset key is allowed
 * through: the writers below filter on `v != null && String(v)`.
 */
export type McpEnv = Record<string, string | undefined>;

/** What `mcpServerSpec` hands Claude's --mcp-config and desk-harness's probe. */
export interface McpServerSpec {
  type: "stdio";
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The mutable accumulator the three stream parsers fold into. Callers create it
 * as `{ reply: "" }` (runHostCli) or `{ parts: [], reply: "" }` (desk-harness,
 * tests); every other field is filled in by the parser that needs it.
 */
export interface StreamAcc {
  reply: string;
  parts?: string[] | undefined;
  deltaBuf?: string | undefined;
  cur?: string | undefined;
  final?: boolean | undefined;
}

/** As much of a Claude stream-json event as parseClaudeStream reads. */
interface ClaudeStreamEvent {
  type?: string | undefined;
  message?: { content?: Array<{ type?: string | undefined; text?: unknown }> | undefined } | undefined;
  delta?: { text?: string | undefined } | undefined;
  result?: unknown;
}

/** As much of a Codex --json event as parseCodexStream reads. */
interface CodexStreamItem {
  type?: string | undefined;
  text?: string | undefined;
  message?: string | undefined;
  content?: Array<{ type?: string | undefined; text?: string | undefined }> | undefined;
}

interface CodexStreamEvent {
  item?: CodexStreamItem | undefined;
  msg?: CodexStreamItem | undefined;
  item_type?: string | undefined;
  type?: string | undefined;
  text?: string | undefined;
}

/** The ACP session/update payload grok streams, plus its flat-event aliases. */
interface GrokStreamUpdate {
  sessionUpdate?: string | undefined;
  session_update?: string | undefined;
  content?: { text?: string | undefined; content?: string | undefined } | undefined;
}

interface GrokStreamEvent {
  type?: string | undefined;
  event?: string | undefined;
  result?: unknown;
  data?: unknown;
  text?: unknown;
  message?: unknown;
  method?: string | undefined;
  params?: { update?: GrokStreamUpdate | undefined } | undefined;
  update?: GrokStreamUpdate | undefined;
}

/**
 * As much of a bot record as this file reads. That is exactly context.mts's
 * ContextBot: `id` and `vm.container` — the only two fields read here directly
 * — already live there, and reusing it keeps the record runHostCli is handed
 * acceptable to ctx.agentsExtra and memory.ensureLayout without a cast.
 */
export type HostCliBot = ContextBot & {
  messages?: Array<{ role?: string; content?: unknown; hidden?: boolean; kind?: string }> | undefined;
  identityId?: string | undefined;
  harnessSessionId?: string | undefined;
  grokSessionId?: string | undefined;
  harnessSessionFresh?: boolean | undefined;
};

/** The settings runHostCli reads, plus the two internal fields index.mjs hangs off them. */
export interface HostCliSettings extends ContextSettings {
  __internalToken?: string | undefined;
  __port?: number | string | undefined;
}

export interface RunHostCliOptions {
  provider: string;
  model?: string | undefined;
  userText: string;
  signal?: AbortSignal | undefined;
  bot: HostCliBot;
  settings?: HostCliSettings | undefined;
  hidden?: boolean | undefined;
  emit?: ((event: string, payload?: unknown) => void) | undefined;
  internalToken?: string | undefined;
  port?: number | string | undefined;
}

/** What a harness "reply PONG" probe resolves to. agent.mjs spreads this. */
export interface HostCliPing {
  ok: boolean;
  sample: string;
  log?: string | undefined;
  command?: string | undefined;
  error?: string | null | undefined;
}

/** Mac-fallback prompt: same surface as MCP + catalog (widget/secret-request end the turn). */
export const MCP_DRIVE_TOOLS =
  "browser, computer, shell, memory, vault_list, vault_fill, list_routines, upsert_routine, disable_routine, send_message, nothing_to_add, list_teammates, message_teammate, list_tasks, update_task, set_job, ask_user, create_teammate, rename_bot, update_bot, delete_teammate, web_search, web_fetch, read, create_channel, update_channel, task, check_subagent, message_subagent, stop_subagent, await_shell, cloud_agent, request_box_help, update_state, get_mcp_tools, call_mcp_tool, authenticate_mcp_server, add_mcp_server";

export function extraPath(): string {
  const home = process.env.HOME || os.homedir() || "";
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".docker", "bin"),
    path.join(home, ".sub8", "bin"),
  ];
  return extras.filter((p) => fsSync.existsSync(p)).join(path.delimiter);
}

export function whichCmd(name: string, extra: readonly string[] = []): string {
  const home = process.env.HOME || os.homedir() || "";
  const candidates = [
    ...extra,
    path.join(home, ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const p of candidates) {
    if (p && fsSync.existsSync(p)) return p;
  }
  return name;
}

export function claudeBin(): string {
  return whichCmd("claude");
}

/**
 * Desk Claude id. Sonnet 5 verified working in -p mode on this login
 * (2026-09-02: claude-sonnet-5/4-6/4-5 all answer; the earlier
 * model_not_found 404s no longer reproduce). Haiku was a stopgap and is not
 * good enough for team coordination — double-delegations, skipped summaries.
 */
/**
 * Claude Code built-ins a desk turn must never reach: peer messaging (a
 * worker once sent its answer to the developer's terminal), and Claude Code's
 * own scheduling/notification tools — "remind me in 2 minutes" created a
 * claude.ai cloud routine instead of a Sub8 reminder (upsert_routine once_at).
 */
// The CLI's own shell/file tools run in the harness dir on the HOST, not on the
// desk (the prompt says so, and a bot still reached for Bash to "wait" for an
// approval). The desk's shell/memory/computer are the mcp__sub8__* tools.
export const DESK_DISALLOWED_TOOLS = ["SendMessage", "ListAgents", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Monitor", "PushNotification", "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"];

export const CLAUDE_SAFE_SONNET = "claude-sonnet-5";
export const CLAUDE_FALLBACK = "claude-sonnet-4-5";

/** Map UI/API aliases onto a Claude Code CLI id this login can run. */
export function resolveClaudeCliModel(model: unknown): string {
  const m = String(model || "").trim();
  if (!m || m === "default" || m === "auto" || m === "sonnet") return CLAUDE_SAFE_SONNET;
  if (/^claude-sonnet-5($|-|\[)/i.test(m) || m === "sonnet-5") return CLAUDE_SAFE_SONNET;
  if (/^claude-sonnet-4-6/i.test(m) || m === "sonnet-4-6" || m === "sonnet-4.6") return CLAUDE_SAFE_SONNET;
  if (/^claude-sonnet-4-5/i.test(m) || m === "sonnet-4-5" || m === "sonnet-4.5") return CLAUDE_SAFE_SONNET;
  // Any Claude model id passes through so new releases (opus-5, haiku-4-5, …)
  // keep working with no code change. A model that is NOT Claude's — a Grok,
  // Cursor, or other harness's model string left on a bot whose identity was
  // switched to Claude — must never reach the Claude CLI as --model; fall back
  // to the safe default instead of passing a guaranteed-invalid model through.
  if (/^claude-/i.test(m) || /^(opus|haiku)/i.test(m)) return m;
  return CLAUDE_SAFE_SONNET;
}

/** Claude Code flags. Always pin --model so 2.1.197 cannot default to Sonnet 5. */
export function claudeModelArgs(model: unknown): string[] {
  const m = resolveClaudeCliModel(model);
  return ["--model", m, "--fallback-model", m === CLAUDE_FALLBACK ? "haiku" : CLAUDE_FALLBACK];
}

export function codexBin(): string {
  return whichCmd("codex");
}

export function hermesBin(): string {
  const home = process.env.HOME || os.homedir() || "";
  return whichCmd("hermes", [path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes")]);
}

export function grokBin(): string {
  const home = process.env.HOME || os.homedir() || "";
  return whichCmd("grok", [path.join(home, ".grok", "bin", "grok")]);
}

/**
 * Cursor Agent CLI. Must be `cursor-agent`, never `agent` — Grok Build also
 * ships an `agent` binary on PATH (`~/.grok/bin/agent`).
 */
export function cursorBin(): string {
  const home = process.env.HOME || os.homedir() || "";
  return whichCmd("cursor-agent", [path.join(home, ".local", "bin", "cursor-agent")]);
}

export function isCliHostProvider(provider: unknown): boolean {
  const id = String(provider || "");
  return id === "grok-build" || id === "hermes" || id === "claude" || id === "codex" || id === "cursor";
}

export function cursorModelArgs(model: unknown): string[] {
  const m = String(model || "").trim();
  if (m === "auto") return [];
  if (!m || m === "default") return ["--model", "cursor-grok-4.6-low"];
  return ["--model", m];
}

/** `cursor-agent models` lines look like `cursor-grok-4.6-low - Cursor Grok 4.6 Low`. */
export function parseCursorModels(out: unknown): string[] {
  const ids: string[] = [];
  for (const line of String(out || "").split("\n")) {
    const m = line.trim().match(/^([a-z0-9][a-z0-9._-]*)\s+-\s+/i);
    if (m?.[1] && m[1] !== "Available") ids.push(m[1]);
  }
  return [...new Set(ids)];
}

export function hermesConfigPath(): string {
  return path.join(os.homedir(), ".hermes", "config.yaml");
}

const HERMES_MIN_CTX = 131072;
/** Isolated Sub8 ACP home: Hermes Agent requires >= 64k. Do not use 128k. */
export const HERMES_SUB8_CTX = 65536;

export function withHermesContextLength(cfg: unknown, n: number = HERMES_MIN_CTX): string {
  let out = String(cfg || "");
  if (!/(?:^|\n)model:\s*\n/.test(out)) {
    out = `model:\n  context_length: ${n}\n  provider: lmstudio\n  base_url: http://127.0.0.1:1234/v1\n` + out;
  } else if (/(?:^|\n)model:\s*\n(?:  .+\n)*?  context_length:\s*/.test(out)) {
    out = out.replace(/((?:^|\n)model:\s*\n(?:  .+\n)*?  context_length:\s*)\d+/, `$1${n}`);
  } else {
    out = out.replace(/((?:^|\n)model:\s*\n)/, `$1  context_length: ${n}\n`);
  }
  // Oneshoot / isolated HERMES_HOME re-probes LM Studio and sees ~4k.
  // The CLI has a cache; this is the override Hermes documents.
  if (/(?:^|\n)auxiliary:\s*\n[\s\S]*?\n  compression:\s*\n[\s\S]*?\n    context_length:\s*\d+/.test(out)) {
    out = out.replace(/((?:^|\n)  compression:\s*\n(?:    .+\n)*?    context_length:\s*)\d+/, `$1${n}`);
  } else if (/(?:^|\n)  compression:\s*\n/.test(out) && /(?:^|\n)auxiliary:\s*\n/.test(out)) {
    out = out.replace(/((?:^|\n)  compression:\s*\n)/, `$1    context_length: ${n}\n`);
  } else if (/(?:^|\n)auxiliary:\s*\n/.test(out)) {
    out = out.replace(
      /((?:^|\n)auxiliary:\s*\n)/,
      `$1  compression:\n    context_length: ${n}\n    provider: auto\n    model: ''\n`,
    );
  } else {
    out += `\nauxiliary:\n  compression:\n    context_length: ${n}\n    provider: auto\n    model: ''\n`;
  }
  return out;
}

export function withHermesReasoningEffort(cfg: unknown, effort: string = "low"): string {
  let out = String(cfg || "");
  if (/(?:^|\n)agent:\s*\n(?:  .+\n)*?  reasoning_effort:\s*/.test(out)) {
    return out.replace(/((?:^|\n)agent:\s*\n(?:  .+\n)*?  reasoning_effort:\s*)[^\n#]+/, `$1${effort}`);
  }
  if (/(?:^|\n)agent:\s*\n/.test(out)) {
    return out.replace(/((?:^|\n)agent:\s*\n)/, `$1  reasoning_effort: ${effort}\n`);
  }
  return `${out.trimEnd()}\nagent:\n  reasoning_effort: ${effort}\n`;
}

/** Strip Hermes host browser/terminal/web so it cannot open Chrome on the Mac. */
export function withHermesHostLockdown(cfg: unknown): string {
  let out = String(cfg || "");
  out = out.replace(/(?:^|\n)toolsets:\n(?:- [^\n]+\n)*/g, "\ntoolsets: []\n");
  if (/(?:^|\n)  disabled_toolsets:\n/.test(out)) {
    out = out.replace(
      /(?:^|\n)  disabled_toolsets:\n(?:  - [^\n]+\n)*/,
      "\n  disabled_toolsets:\n  - browser\n  - terminal\n  - web\n",
    );
  } else if (/(?:^|\n)agent:\s*\n/.test(out)) {
    out = out.replace(/((?:^|\n)agent:\s*\n)/, `$1  disabled_toolsets:\n  - browser\n  - terminal\n  - web\n`);
  }
  out = out.replace(/((?:^|\n)platform_toolsets:\n)  cli:\n(?:  - [^\n]+\n)+/, `$1  cli: []\n`);
  out = out.replace(/((?:^|\n)browser:\n(?:  .+\n)*?  cloud_provider:\s*)[^\n]+/, `$1none`);
  return out;
}

export function readHermesModel(): string {
  try {
    const cfg = fsSync.readFileSync(hermesConfigPath(), "utf8");
    const m = cfg.match(/(?:^|\n)model:\s*\n(?:  .+\n)*?  default:\s*["']?([^\n#]+)/);
    // m[1]! : the pattern's single capture group is not optional, so a match
    // always has it. The assertion erases; the emitted expression is unchanged.
    return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

export async function setHermesModel(model: unknown): Promise<{ ok: boolean; model: string; contextLength: number }> {
  const name = String(model || "").trim();
  if (!name) throw new Error("model required");
  const file = hermesConfigPath();
  let cfg = "";
  try {
    cfg = await fs.readFile(file, "utf8");
  } catch {
    cfg = "model:\n  provider: lmstudio\n  base_url: http://127.0.0.1:1234/v1\n  default: qwen3.8-27b\n";
  }
  if (/(?:^|\n)model:\s*\n(?:  .+\n)*?  default:\s*/.test(cfg)) {
    cfg = cfg.replace(/((?:^|\n)model:\s*\n(?:  .+\n)*?  default:\s*)([^\n#]+)/, `$1${name}`);
  } else if (/(?:^|\n)model:\s*\n/.test(cfg)) {
    cfg = cfg.replace(/((?:^|\n)model:\s*\n)/, `$1  default: ${name}\n`);
  } else {
    cfg = `model:\n  provider: lmstudio\n  base_url: http://127.0.0.1:1234/v1\n  default: ${name}\n` + cfg;
  }
  cfg = withHermesContextLength(cfg);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, cfg);
  return { ok: true, model: name, contextLength: HERMES_MIN_CTX };
}

export function nodeBin(): string {
  const exe = path.basename(process.execPath || "").toLowerCase();
  const electronish = /electron|^sub8$/.test(exe) || process.env.ELECTRON_RUN_AS_NODE;
  if (!electronish && process.execPath && fsSync.existsSync(process.execPath)) return process.execPath;
  return whichCmd("node", ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]);
}

export function mcpServerSpec(mcpEnv: McpEnv = {}): McpServerSpec {
  // Only what the MCP server needs — spreading process.env wrote every host
  // secret (API keys, session tokens) into world-readable temp-dir JSON.
  const base = hostEnv();
  const env: NodeJS.ProcessEnv = { PATH: base.PATH, HOME: base.HOME, ...mcpEnv };
  if (base.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = "1";
  return {
    type: "stdio",
    command: nodeBin(),
    args: [mcpScript()],
    env,
  };
}

const IMPORT_RE = /(?:import|from)\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']/g;

// Every file the MCP server pulls in, as paths relative to appRoot.
function mcpGraph(entry: string, root: string, seen: Set<string> = new Set()): Set<string> {
  if (seen.has(entry) || !fsSync.existsSync(entry)) return seen;
  seen.add(entry);
  let src = "";
  try {
    src = fsSync.readFileSync(entry, "utf8");
  } catch {
    return seen;
  }
  for (const m of src.matchAll(IMPORT_RE)) {
    // m[2]! : IMPORT_RE is two alternatives, each with exactly one capture, so
    // when m[1] is undefined m[2] is the one that matched. Erases to `m[1] || m[2]`.
    mcpGraph(path.resolve(path.dirname(entry), m[1] || m[2]!), root, seen);
  }
  return seen;
}

// Captures the package name only, so a subpath import (`@sub8/store/trace`)
// still names the directory that has to be copied.
const PKG_RE =
  /(?:import|from)\s+["'](@sub8\/[A-Za-z0-9._-]+)(?:\/[^"']*)?["']|import\(\s*["'](@sub8\/[A-Za-z0-9._-]+)(?:\/[^"']*)?["']/g;

// The workspace packages the graph imports by name. Node resolves those through
// node_modules, not through a relative path, so mcpGraph never sees them.
function mcpPackages(files: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    let src = "";
    try {
      src = fsSync.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // m[2]! : as in mcpGraph — PKG_RE's two alternatives each capture the name,
    // so the fallback arm is defined whenever the first one is not.
    for (const m of src.matchAll(PKG_RE)) names.add(m[1] || m[2]!);
  }
  return names;
}

function copyFresh(file: string, dest: string): void {
  const src = fsSync.statSync(file);
  const stale = !fsSync.existsSync(dest) || fsSync.statSync(dest).mtimeMs !== src.mtimeMs;
  if (!stale) return;
  fsSync.mkdirSync(path.dirname(dest), { recursive: true });
  fsSync.copyFileSync(file, dest);
  fsSync.utimesSync(dest, src.atime, src.mtime);
}

function copyTree(dir: string, dest: string): void {
  for (const name of fsSync.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fsSync.statSync(file).isDirectory()) copyTree(file, path.join(dest, name));
    else copyFresh(file, path.join(dest, name));
  }
}

function listFiles(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = fsSync.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (fsSync.statSync(file).isDirectory()) listFiles(file, out);
    else out.push(file);
  }
  return out;
}

// A package may import another package (@sub8/store imports @sub8/constants),
// and that second hop lives inside a dist/ the relative file graph never walks.
// Copying only the first hop leaves a healed server that dies on import.
function mcpPackageClosure(files: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...mcpPackages(files)];
  while (queue.length) {
    // shift()! : the loop condition is queue.length, so the queue is non-empty.
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dist = path.join(appRoot, "packages", name.slice("@sub8/".length), "dist");
    for (const next of mcpPackages(listFiles(dist))) queue.push(next);
  }
  return seen;
}

// Claude runs this server with real node, which cannot read inside app.asar.
// A bundle that unpacks the entry point but not its imports dies with
// ERR_MODULE_NOT_FOUND, and Claude just reports "sub8 MCP not connected".
// Copy the whole graph somewhere real node can read it, and keep it fresh.
function healMcp(packed: string): string {
  try {
    const out = path.join(dataDir, "mcp");
    const files = mcpGraph(packed, appRoot);
    let entry = "";
    for (const file of files) {
      const rel = path.relative(appRoot, file);
      if (rel.startsWith("..")) continue;
      const dest = path.join(out, rel);
      copyFresh(file, dest);
      if (file === packed) entry = dest;
    }
    // packages/<name>/dist lands as node_modules/@sub8/<name> so `import
    // "@sub8/<name>"` resolves from the healed copy the same way it does here.
    for (const name of mcpPackageClosure(files)) {
      const from = path.join(appRoot, "packages", name.slice("@sub8/".length));
      const to = path.join(out, "node_modules", name);
      copyFresh(path.join(from, "package.json"), path.join(to, "package.json"));
      copyTree(path.join(from, "dist"), path.join(to, "dist"));
    }
    return entry;
  } catch {
    return "";
  }
}

function mcpScript(): string {
  const packed = path.join(appRoot, "server", "mcp-sub8.mjs");
  const unpacked = packed.replace(/\.asar([/\\])/, ".asar.unpacked$1");
  const entry = fsSync.existsSync(unpacked) ? unpacked : packed;
  const root = path.dirname(path.dirname(entry));
  const files = mcpGraph(packed, appRoot);
  const complete =
    [...files].every((file) => fsSync.existsSync(path.join(root, path.relative(appRoot, file)))) &&
    [...mcpPackageClosure(files)].every((name) => fsSync.existsSync(path.join(root, "node_modules", name)));
  if (complete) return entry;
  return healMcp(packed) || entry;
}

export function hostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: process.env.HOME || os.homedir() };
  const prefix = extraPath();
  if (prefix) env.PATH = `${prefix}${path.delimiter}${env.PATH || "/usr/bin:/bin"}`;
  if (path.basename(process.execPath).toLowerCase().includes("electron")) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export function parseClaudeStream(line: string, acc: StreamAcc): void {
  let evt: ClaudeStreamEvent;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  acc.parts = acc.parts || [];
  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const part of evt.message.content) {
      if (part.type === "text" && part.text) acc.parts.push(String(part.text).trim());
    }
  }
  if (evt.type === "content_block_delta" && evt.delta?.text) {
    acc.deltaBuf = (acc.deltaBuf || "") + evt.delta.text;
  }
  if (evt.type === "content_block_stop" && acc.deltaBuf) {
    acc.parts.push(String(acc.deltaBuf).trim());
    acc.deltaBuf = "";
  }
  if (evt.type === "result" && typeof evt.result === "string" && !acc.parts.length) {
    acc.parts.push(evt.result.trim());
  }
  acc.reply = foldClaudeVisibleText(acc.parts);
}

/** Cursor `--output-format stream-json` (assistant/result events, plus text deltas). */
export function parseCursorStream(line: string, acc: StreamAcc): void {
  let evt: ClaudeStreamEvent & { result?: unknown; text?: unknown; subtype?: string | undefined };
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  acc.parts = acc.parts || [];
  const typ = String(evt.type || "");
  if (typ === "assistant" && Array.isArray(evt.message?.content)) {
    for (const part of evt.message.content) {
      if (part.type === "text" && part.text) acc.parts.push(String(part.text).trim());
    }
  }
  if (typ === "assistant" && typeof evt.text === "string" && evt.text.trim()) {
    acc.parts.push(evt.text.trim());
  }
  if ((typ === "text_delta" || typ === "content_block_delta") && evt.delta?.text) {
    acc.deltaBuf = (acc.deltaBuf || "") + evt.delta.text;
  }
  if (typ === "content_block_stop" && acc.deltaBuf) {
    acc.parts.push(String(acc.deltaBuf).trim());
    acc.deltaBuf = "";
  }
  if (typ === "result" && typeof evt.result === "string" && evt.result.trim()) {
    acc.parts.push(evt.result.trim());
  }
  acc.reply = foldClaudeVisibleText(acc.parts);
}

function parseCodexStream(line: string, acc: StreamAcc): void {
  let evt: CodexStreamEvent;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  const item: CodexStreamItem = evt.item || evt.msg || {};
  const typ = String(item.type || evt.item_type || evt.type || "");
  if (/agent_message|assistant_message|agent.message/i.test(typ)) {
    const text = item.text || item.message || evt.text || "";
    if (text && typeof text === "string") acc.reply += (acc.reply ? "\n" : "") + text;
  }
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part?.text && part.type !== "reasoning") acc.reply += part.text;
    }
  }
}

export function grokShouldKeepText(text: unknown): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^Error: max turns reached$/i.test(t)) return false;
  if (t.length > 280) return true;
  return !/^(I('ll| will) |Let me |Trying |The (first |desktop |MCP |hash |trip|origin|destination|route|search) |Origin is |SFO is set|One way is |Google Flights is open)/i.test(
    t,
  );
}

export function foldGrokVisibleText(parts: readonly unknown[] | null | undefined): string {
  const list = (parts || []).map((p) => String(p || "").trim()).filter(Boolean);
  const kept = list.filter(grokShouldKeepText);
  return (kept.length ? kept : list.slice(-1)).join("\n");
}

export function foldClaudeVisibleText(parts: readonly unknown[] | null | undefined): string {
  const list = (parts || []).map((p) => String(p || "").trim()).filter(Boolean);
  if (list.length <= 1) return foldGrokVisibleText(list);
  const kept = list.filter(grokShouldKeepText);
  // Both `!`s are guarded by the length checks immediately above them: `kept`
  // is non-empty here, and `list` has at least two entries (one or fewer
  // returned already). Both assertions erase.
  if (kept.length) return kept[kept.length - 1]!;
  return list[list.length - 1]!;
}

function grokFlushDelta(acc: StreamAcc): void {
  const cur = String(acc.cur || "").trim();
  if (cur) {
    acc.parts = acc.parts || [];
    acc.parts.push(cur);
  }
  acc.cur = "";
}

export function parseGrokStream(line: string, acc: StreamAcc): void {
  let evt: GrokStreamEvent;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  const typ = String(evt.type || evt.event || "");
  if (/think|reasoning|tool_call|tool_result|status|error/i.test(typ) && typ !== "result") {
    // A tool call ends the current spoken message.
    if (/tool_call/i.test(typ)) grokFlushDelta(acc);
    return;
  }
  if (typ === "result" && typeof evt.result === "string" && evt.result.trim()) {
    acc.final = true;
    acc.cur = "";
    acc.parts = [evt.result.trim()];
    acc.reply = foldGrokVisibleText(acc.parts);
    return;
  }
  if (acc.final) return;
  const text =
    (typ === "text" && typeof evt.data === "string" && evt.data) ||
    (typeof evt.text === "string" && evt.text) ||
    (typeof evt.message === "string" && evt.message) ||
    "";
  const update: GrokStreamUpdate = evt.params?.update || evt.update || {};
  const kind = update.sessionUpdate || update.session_update || evt.method || "";
  const chunk = update.content?.text || update.content?.content || "";
  const piece = text || (/agent_message/i.test(kind) ? chunk : "");
  if (!piece || !String(piece)) return;
  const isDelta = /delta|chunk/i.test(kind) || typ === "text";
  if (isDelta) {
    // Token deltas concatenate verbatim — trimming and newline-joining them
    // split words across lines ("P\nONG").
    acc.cur = (acc.cur || "") + String(piece);
  } else {
    grokFlushDelta(acc);
    if (String(piece).trim()) {
      acc.parts = acc.parts || [];
      acc.parts.push(String(piece).trim());
    }
  }
  acc.reply = foldGrokVisibleText([...(acc.parts || []), String(acc.cur || "").trim()].filter(Boolean));
}

export function hostCodexAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export function hostHermesAuthPath(): string {
  return path.join(os.homedir(), ".hermes", "auth.json");
}

/**
 * The hermes CLI home this app writes and then harvests back from.
 *
 * Unlike codex, whose home lives inside the per-turn temp dir, this one is
 * PERSISTENT. That difference is why the two drifted: the spawn site wrote to
 * dataDir/hermes-host while finish() harvested from work/hermes-home, a path
 * nothing ever creates, so hermes refresh tokens were never copied back and the
 * harvest silently did nothing. One definition, used by both, so they cannot
 * drift again.
 */
export function hermesHomeDir(): string {
  return path.join(dataDir, "hermes-host");
}

/** Share login tokens with an isolated CLI home. Copying auth.json burns one-time refresh tokens. */
export async function shareAuthFile(src: string, dest: string): Promise<"missing" | "symlink" | "copy"> {
  if (!src || !fsSync.existsSync(src)) return "missing";
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.lstat(dest);
    await fs.unlink(dest);
  } catch {
    /* dest missing */
  }
  try {
    await fs.symlink(src, dest);
    return "symlink";
  } catch {
    await fs.copyFile(src, dest);
    return "copy";
  }
}

/** If Codex rewrote a copied auth.json, copy the new tokens back to the host login. */
export async function harvestAuthFile(src: string, dest: string): Promise<"symlink" | "copied-back" | "stale" | "missing"> {
  try {
    const st = await fs.lstat(dest);
    if (st.isSymbolicLink()) return "symlink";
    const srcExists = fsSync.existsSync(src);
    const srcM = srcExists ? (await fs.stat(src)).mtimeMs : 0;
    if (!srcExists || st.mtimeMs >= srcM - 1000) {
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.copyFile(dest, src);
      return "copied-back";
    }
    return "stale";
  } catch {
    return "missing";
  }
}

export async function writeCodexHome(work: string, mcpEnv: McpEnv): Promise<string> {
  const home = path.join(work, "codex-home");
  await fs.mkdir(home, { recursive: true });
  await shareAuthFile(hostCodexAuthPath(), path.join(home, "auth.json"));
  const envLines = Object.entries({ PATH: hostEnv().PATH, ...mcpEnv })
    .filter(([, v]) => v != null && String(v))
    .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`)
    .join("\n");
  const cwd = path.resolve(work);
  const toml = `approval_policy = "never"
sandbox_mode = "danger-full-access"

[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"

[plugins."browser-use@openai-bundled"]
enabled = false

[mcp_servers.sub8]
command = ${JSON.stringify(nodeBin())}
args = [${JSON.stringify(mcpScript())}]
startup_timeout_sec = 30
enabled = true

[mcp_servers.sub8.env]
${envLines}
`;
  // 0600 to match data/internal-token: this toml interpolates the same
  // SUB8_INTERNAL_TOKEN (and SUB8_DESK_TOKEN on the desk) into mcpEnv.
  await fs.writeFile(path.join(home, "config.toml"), toml, { mode: 0o600 });
  return home;
}

export async function writeHermesHome(
  home: string,
  mcpEnv: McpEnv,
  { contextLength = HERMES_SUB8_CTX, reasoning = "low" }: { contextLength?: number | undefined; reasoning?: string | undefined } = {},
): Promise<string> {
  const src = path.join(os.homedir(), ".hermes");
  await fs.mkdir(home, { recursive: true });
  for (const name of ["config.yaml", ".env"]) {
    const from = path.join(src, name);
    if (fsSync.existsSync(from)) await fs.copyFile(from, path.join(home, name));
  }
  await shareAuthFile(path.join(src, "auth.json"), path.join(home, "auth.json"));
  // CLI caches LM Studio context here. Without it, oneshot re-probes /v1/models
  // and Hermes rejects Qwen at the advertised ~4k window.
  for (const name of ["models_dev_cache.json", "ollama_cloud_models_cache.json"]) {
    const from = path.join(src, name);
    const to = path.join(home, name);
    if (!fsSync.existsSync(from)) continue;
    try {
      await fs.lstat(to);
    } catch {
      try {
        await fs.symlink(from, to);
      } catch {
        await fs.copyFile(from, to).catch(() => {});
      }
    }
  }
  const mcp = {
    command: nodeBin(),
    args: [mcpScript()],
    env: Object.fromEntries(Object.entries(mcpEnv).filter(([, v]) => v != null && String(v))),
  };
  const block = [
    "",
    "mcp_servers:",
    "  sub8:",
    `    command: ${JSON.stringify(mcp.command)}`,
    "    args:",
    ...mcp.args.map((a) => `      - ${JSON.stringify(a)}`),
    "    env:",
    ...Object.entries(mcp.env).map(([k, v]) => `      ${k}: ${JSON.stringify(String(v))}`),
    "",
  ].join("\n");
  const cfgPath = path.join(home, "config.yaml");
  let cfg = "";
  try {
    cfg = await fs.readFile(cfgPath, "utf8");
  } catch {
    cfg = "model:\n  provider: auto\n";
  }
  cfg = cfg.replace(/\nmcp_servers:\n[\s\S]*?(?=\n[a-z_][a-z0-9_]*:|\s*$)/i, "\n");
  cfg = withHermesContextLength(cfg, contextLength);
  cfg = withHermesReasoningEffort(cfg, reasoning);
  cfg = withHermesHostLockdown(cfg);
  await fs.writeFile(cfgPath, `${cfg.trimEnd()}\n${block}`);
  return home;
}

export async function writeGrokHome(botId: unknown, mcpEnv: McpEnv, homeOverride?: string, { copyHostAuth = true } = {}): Promise<string> {
  const home = homeOverride || path.join(dataDir, "grok-host", String(botId || "bot"));
  await fs.mkdir(home, { recursive: true });
  const srcAuth = path.join(os.homedir(), ".grok", "auth.json");
  if (copyHostAuth && fsSync.existsSync(srcAuth)) {
    await fs.copyFile(srcAuth, path.join(home, "auth.json"));
  }
  const envLines = Object.entries(mcpEnv)
    .filter(([, v]) => v != null && String(v))
    .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`)
    .join("\n");
  const toml = `[ui]
permission_mode = "always-approve"

[models]
default_reasoning_effort = "low"

[mcp_servers.sub8]
command = ${JSON.stringify(nodeBin())}
args = [${JSON.stringify(mcpScript())}]
enabled = true
startup_timeout_sec = 20

[mcp_servers.sub8.env]
${envLines}
`;
  // 0600 to match data/internal-token: this toml interpolates the same
  // SUB8_INTERNAL_TOKEN (and SUB8_DESK_TOKEN on the desk) into mcpEnv.
  await fs.writeFile(path.join(home, "config.toml"), toml, { mode: 0o600 });
  return home;
}

/** Changing Claude ↔ Grok (etc.) must not resume the other harness's CLI session. */
export function shouldRotateHarnessSession(prev: unknown, next: unknown): boolean {
  const norm = (value: unknown) => {
    const p = String(value || "").trim();
    return !p || p === "default" ? "default" : p;
  };
  const b = String(next || "").trim();
  if (!b) return false;
  return norm(prev) !== norm(next);
}

export function recapConversation(
  messages: ReadonlyArray<{ role?: string; content?: unknown; hidden?: boolean; kind?: string }> | null | undefined,
  { limit = 60, each = 500 }: { limit?: number; each?: number } = {},
): string {
  return (messages || [])
    .filter((m) => !m.hidden && (m.role === "user" || m.role === "assistant") && m.kind !== "think" && m.kind !== "tool")
    .slice(-limit)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, each)}`)
    .join("\n");
}

export function continuePrompt(userText: string, recap: string): string {
  if (!recap) return userText;
  // Context, not a briefing: labelled so the model does not "acknowledge" it
  // ("Got it, I understand my team is…") instead of acting on the new message.
  return (
    `Recent conversation, for context only — do not acknowledge, summarize, or restate it; act on what comes after it. If an earlier turn refused something these rules allow, or did something they do not, follow the rules, not the earlier turn:\n${recap}\n\n` +
    `Now:\n${userText}`
  );
}

export function cliSessionId(
  bot: { harnessSessionId?: string | undefined; grokSessionId?: string | undefined; id?: string | undefined } | null | undefined,
): string {
  return String(bot?.harnessSessionId || bot?.grokSessionId || bot?.id || "").trim();
}

function grokSessionExists(home: string, id: string): boolean {
  const root = path.join(home, "sessions");
  if (!id || !fsSync.existsSync(root)) return false;
  try {
    const names = fsSync.readdirSync(root);
    return names.some((n) => n.includes(id));
  } catch {
    return false;
  }
}

/**
 * Did a finished CLI turn fail? Only a failed turn gets rewriteHarnessOutput,
 * which replaces the entire output with "…is signed out" on auth-ish wording
 * and benches the harness for 30 minutes via noteAuthFailure.
 *
 * A turn that produced a reply AND exited 0 authenticated by definition — it
 * answered. A genuinely signed-out CLI exits non-zero or produces no reply at
 * all, so this keeps detection for the case that matters while no longer
 * destroying a legitimate answer that merely discusses 401s or refresh tokens.
 */
export function hostCliTurnFailed(code: number | null | undefined, reply: unknown): boolean {
  return code !== 0 || !String(reply || "").trim();
}

async function writeCursorWorkspace(work: string, mcpEnv: McpEnv): Promise<void> {
  const spec = mcpServerSpec(mcpEnv);
  const dir = path.join(work, ".cursor");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          sub8: {
            command: spec.command,
            args: spec.args,
            env: spec.env,
          },
        },
      },
      null,
      2,
    ),
  );
}

/**
 * Run a command and capture its output without blocking the event loop — the
 * plugin listing takes 10–20s and this process serves the UI.
 */
export function spawnCapture(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv | undefined; cwd?: string | undefined; uid?: number | undefined; gid?: number | undefined }, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const child = spawn(bin, args, opts);
    const timer = setTimeout(() => {
      stderr += `\n[timed out after ${timeoutMs}ms]`;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(124);
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => { stderr += String((e as Error)?.message || e); finish(127); });
    child.on("close", (code) => finish(code ?? 0));
  });
}

/**
 * Plugins of this Mac's harness login, cached: a turn reads the cache
 * (`withHostPluginsBlock`, never waits) and only Settings → Refresh waits for
 * a fresh listing.
 */
const hostPluginsCache = createPluginsCache({ ttlMs: 10 * 60_000 });

export const hostPluginsExec: HarnessExec = {
  run(file, args, opts) {
    const bin = file === "claude" ? claudeBin() : file;
    return spawnCapture(bin, args, { env: { ...hostEnv(), NO_COLOR: "1" } }, opts?.timeoutMs ?? 45_000);
  },
};

/** Same JSON shape the desk harness's GET /plugins answers. */
export async function hostPlugins(provider: string, { force = false }: { force?: boolean } = {}): Promise<Record<string, unknown>> {
  const src = pluginsForHarness(provider);
  if (!src) return { ok: true, provider, supported: false, plugins: [] };
  const e = await hostPluginsCache.get(provider, hostPluginsExec, { force });
  return e.error && !e.plugins.length
    ? { ok: false, provider, supported: true, label: src.label, plugins: [], error: e.error }
    : { ok: true, provider, supported: true, label: src.label, manageUrl: src.manageUrl, plugins: e.plugins, checkedAt: e.checkedAt, ...(e.error ? { stale: true, error: e.error } : {}) };
}

export function warmHostPlugins(): void {
  void hostPluginsCache.get("claude", hostPluginsExec);
}

/** The turn's rules plus which plugins are connected right now (from cache). */
export function withHostPluginsBlock(system: string): string {
  const block = pluginsPromptBlock(hostPluginsCache.peek("claude", hostPluginsExec) || [], { settingsPath: "Settings → This Mac → Plugins" });
  return block ? `${system}\n\n${block}` : system;
}

export async function runHostCli({ provider, model, userText, signal, bot, settings, hidden = false, emit, internalToken, port }: RunHostCliOptions): Promise<string> {
  const box = bot?.vm?.container;
  if (!box) return "This harness only runs after the Bot computer is up.";
  const attach = await identities.attachForBot(bot as import("@sub8/identities").AttachBot).catch(() => null);
  const isolatedHome = attach
    ? identities.identityRuntimeDir({ id: attach.identityId, runtimeRef: attach.runtimeRef, provider: attach.provider || provider })
    : "";
  if (isolatedHome) await fs.mkdir(isolatedHome, { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `sub8-${provider}-`));
  const extra = await ctx.agentsExtra({ bot, settings, hidden });
  await memory.ensureLayout(bot).catch(() => {});
  const hermesFast = provider === "hermes";
  const grokFast = provider === "grok-build";
  const rules = hermesFast
    ? `${extra}

You are Sub8 on this Bot's Linux desktop. Call it "my computer".
Drive it only through MCP tools: ${MCP_DRIVE_TOOLS}.
A question is send_message type=widget (ends the turn). Secrets: type=secret-request, never chat paste. Task subagents for GUI; cloud_agent for coding on this computer.
Web pages: browser snapshot / click ref / fill / navigate. computer is pixels, dialogs, drag.
You MAY edit standing routines: list_routines, then upsert_routine with that id. Overlapping jobs (same group or similar interval) must update the existing id, not create a second one.
Always call a tool before you reply. Do not only describe the next step.
computer action=open text=https://… already returns a screenshot. Do not screenshot again unless the page is wrong. Do not curl a page you opened. Do not use xdotool or host Bash.`
    : grokFast
      ? `${extra}

You are Sub8 on this Bot's Linux desktop. Call it "my computer".
MCP server "sub8" is already connected. Its tools are: ${MCP_DRIVE_TOOLS}.
A question is send_message type=widget (ends the turn). Secrets: type=secret-request, never chat paste. Task subagents for GUI; cloud_agent for coding on this computer.
Prefer browser for websites (snapshot, click ref, fill, navigate).
You MAY edit standing routines (list_routines, then upsert_routine with that id). Do not create a second job that overlaps.
Call computer immediately. Never search for tools, never invent APIs, never curl localhost, never say tools are missing unless a computer call returned an error.
Do not print a user-visible sentence between every click. One short ack, then tools until the job is done, then one result with the answer.
computer action=open text=https://… already returns a screenshot.`
    : `${await fs.readFile(path.join(appRoot, "prompts", "capabilities.txt"), "utf8")}
${extra}

You are Sub8 on this Bot's Linux desktop (display :1, home /config). Call it "my computer". Never say box, container, Docker, VM, or Mac in user-facing replies.
Drive the desktop through MCP tools: ${MCP_DRIVE_TOOLS}. Do not create overlapping jobs — update the existing id. Repeating jobs must continue from /config/agent-data history, not start over.
A question is send_message type=widget (ends the turn). Secrets: type=secret-request, never chat paste. You are the parent dispatcher: Task for GUI, cloud_agent for coding on this computer.
Web pages: browser action=navigate / snapshot / click (ref from snapshot) / fill.
Pixels and native UI: computer screenshot and left_click.
To type text or a URL: computer action=type (pastes exactly, including ://). computer action=key is Return / ctrl+l / Escape — never put a URL in key.
Signing in to the user's OWN accounts — bank, email, anything — is normal work here, never something to refuse: you never see or type the password. vault_list to find a grant for the site, then click the field and vault_fill. No grant: open the site's sign-in page and ask them to press Take control and log in themselves (or add the login to the vault). Never print a password.
Teammates are Sub8 bots on this computer — not sessions, agents, subagents, or peers of your own harness, and no harness-native session/agent/peer messaging reaches them. Reach one only with the sub8 tool message_teammate (a name or the id from list_teammates). Each Bot has its own Chrome tab on its display. Worker: your final message is your answer to the lead — it is delivered for you; make it the answer, not a status. Lead: handing work to a teammate (message_teammate) is itself what the user sees; send_message only when you add something, and ending without one is normal. Jobs: set_job only for multi-step work the user will track; update_task only a step that actually changed. Do not invent extra files. Do not print a user-visible sentence between every click — tools until done. Google URLs: &hl=en&gl=us&curr=USD. If you need a yes/no, a pick, or confirmation from the user, call send_message type=widget (ask_user is an alias) and stop — do not guess.
Do not drive Chrome with xdotool, wmctrl, octo-click, CDP, or host Bash. Call the sub8 tools. If the desktop is sick, shell desk-doctor. Do not announce tools are missing unless a tool call returned an error.
`;
  const sessionId = cliSessionId(bot) || bot.id;
  const fresh = Boolean(bot.harnessSessionFresh);
  if (fresh) bot.harnessSessionFresh = false;
  const grokHomeHint = isolatedHome || path.join(dataDir, "grok-host", String(bot.id || "bot"));
  // Claude: `-p --session-id X` STARTS a conversation with that id every turn
  // (resuming is `--resume`), so the CLI carries nothing between turns and a
  // follow-up like "now say it in Spanish" met "I don't have prior context".
  // The Sub8 transcript is the source of truth — hand the recent conversation
  // over every turn. Bounded so the prompt stays small.
  const recap =
    fresh || provider === "claude" || (provider === "grok-build" && !grokSessionExists(grokHomeHint, sessionId))
      ? recapConversation(bot.messages, provider === "claude" && !fresh ? { limit: 30, each: 400 } : {})
      : "";
  const continued = continuePrompt(userText, recap);
  const prompt = `${continued}

You have an MCP server named "sub8". Use computer action=open to go to a URL. Do not only send a plan.`;
  const mcpEnv = {
    SUB8BOT_BOT_ID: bot.id,
    SUB8BOT_DATA: dataDir,
    SUB8_INTERNAL_TOKEN: internalToken || "",
    SUB8_INTERNAL_URL: port ? `http://127.0.0.1:${port}` : "",
  };
  const mcpFile = path.join(work, "mcp.json");
  if (provider !== "grok-build") {
    // Never for grok: it discovers cwd .mcp.json (untrusted → rejected) whose
    // "sub8" name then shadows and kills the valid GROK_HOME config entry —
    // grok's sub8 lives in config.toml via writeGrokHome instead.
    const mcpJson = JSON.stringify({ mcpServers: { sub8: mcpServerSpec(mcpEnv) } }, null, 2);
    await fs.writeFile(mcpFile, mcpJson);
    await fs.writeFile(path.join(work, ".mcp.json"), mcpJson);
  }

  let bin: string;
  let args: string[];
  const spawnEnv = hostEnv();
  if (provider === "claude") {
    if (isolatedHome) spawnEnv.CLAUDE_CONFIG_DIR = isolatedHome;
    bin = claudeBin();
    args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
      // Not strict: the harness login's own connectors (Gmail, Calendar, …)
      // must reach the desk, and re-declaring them in --mcp-config does not
      // carry their OAuth (measured: zero tools). sub8's server rides along
      // via --mcp-config next to them.
      "--mcp-config",
      mcpFile,
      // Claude Code's built-in peer-messaging is a separate matter from MCP.
      // A worker told "your reply reaches the lead" would find another Claude
      // session on this Mac and SendMessage its answer there — the answer
      // vanished from the team channel and landed in the developer's terminal
      // as a held peer message. No peers here.
      "--disallowedTools",
      ...DESK_DISALLOWED_TOOLS,
      "--append-system-prompt",
      withHostPluginsBlock(rules),
      "--session-id",
      sessionId,
      ...claudeModelArgs(model),
    ];
  } else if (provider === "grok-build") {
    const home = await writeGrokHome(bot.id, mcpEnv, isolatedHome || undefined, { copyHostAuth: !isolatedHome });
    spawnEnv.GROK_HOME = home;
    spawnEnv.GROK_CONFIG = JSON.stringify({ models: { default_reasoning_effort: "low" } });
    bin = grokBin();
    args = [
      "-p",
      prompt,
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
      "--always-approve",
      "--no-alt-screen",
      "--effort",
      "low",
      "--rules",
      rules,
      "--cwd",
      work,
    ];
    if (model) args.push("-m", model);
    if (!fresh && grokSessionExists(home, sessionId)) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
  } else if (provider === "hermes") {
    const { hermesAcpPrompt } = await import("./hermes-acp.mjs");
    const home = await writeHermesHome(hermesHomeDir(), mcpEnv);
    spawnEnv.HERMES_HOME = home;
    try {
      const text = await hermesAcpPrompt({
        bot,
        text: `${rules}\n\n${prompt}`,
        mcpEnv,
        command: nodeBin(),
        args: [mcpScript()],
        signal,
        bin: hermesBin(),
        env: spawnEnv,
        home,
      });
      return text || "(no output from hermes)";
    } catch (err) {
      const msg = String((err as Error).message || err);
      console.error("hermes acp", msg);
      if (/silent|timed out|still working/i.test(msg)) return msg;
      /* fall back to a one-shot only if ACP never came up */
    }
    spawnEnv.HERMES_ACCEPT_HOOKS = "1";
    bin = hermesBin();
    args = [
      "-z",
      `${rules}\n\n${prompt}`,
      "--yolo",
      "--accept-hooks",
    ];
    const hermesModel = model || readHermesModel();
    if (hermesModel) args.push("-m", hermesModel);
  } else if (provider === "cursor") {
    await writeCursorWorkspace(work, mcpEnv);
    bin = cursorBin();
    args = [
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--approve-mcps",
      "--trust",
      "--sandbox",
      "disabled",
      "--workspace",
      work,
      ...cursorModelArgs(model),
      `${rules}\n\n${prompt}`,
    ];
  } else {
    const home = await writeCodexHome(work, mcpEnv);
    spawnEnv.CODEX_HOME = home;
    bin = codexBin();
    args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      work,
    ];
    if (model && !/grok/i.test(model)) args.push("-m", model);
    args.push(prompt);
  }

  return new Promise<string>((resolve) => {
    const child = spawn(bin, args, {
      env: spawnEnv,
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const acc: StreamAcc = { reply: "" };
    let buf = "";
    let done = false;
    const IDLE_MS = 180_000;
    const HARD_MS = 20 * 60_000;
    let idleTimer: NodeJS.Timeout | null = null;
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(`${provider} went silent for 3 minutes. Send another message to continue.`),
        IDLE_MS,
      );
    };
    const hardTimer = setTimeout(
      () => finish(`${provider} hit the 20 minute limit. Send another message to continue.`),
      HARD_MS,
    );
    // `failed` gates the auth rewrite below. It defaults to true because every
    // other caller of finish() IS a failure (idle timeout, hard timeout, abort,
    // spawn error); only the close handler can report success.
    const finish = async (text: unknown, { failed = true }: { failed?: boolean | undefined } = {}): Promise<void> => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        if (!child.killed) child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      let out = String(text || "").trim() || `(no output from ${provider})`;
      out = out
        .replace(/Reading additional input from stdin\.\.\./gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // Only rewrite a FAILED turn. rewriteHarnessOutput replaces the whole
      // output with "…is signed out" whenever it sees auth-ish wording, and it
      // also calls noteAuthFailure, which benches the harness for 30 minutes.
      // Running it over a SUCCESSFUL turn meant a legitimate answer that merely
      // discussed 401s, refresh tokens or "please log in" was destroyed and the
      // harness marked expired. agent.mjs and index.mjs already guard their
      // calls this way; this call site did not.
      if (failed) out = rewriteHarnessOutput(provider, out);
      try {
        out = vault.redactSecrets(out, await vault.listSecrets());
      } catch {
        /* ignore */
      }
      try {
        if (provider === "codex") await harvestAuthFile(hostCodexAuthPath(), path.join(work, "codex-home", "auth.json"));
        if (provider === "hermes") await harvestAuthFile(hostHermesAuthPath(), path.join(hermesHomeDir(), "auth.json"));
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const onChunk = (chunk: Buffer): void => {
      bumpIdle();
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (provider === "claude") parseClaudeStream(line, acc);
        else if (provider === "cursor") parseCursorStream(line, acc);
        else if (provider === "codex") parseCodexStream(line, acc);
        else if (provider === "grok-build") parseGrokStream(line, acc);
        else acc.reply += (acc.reply ? "\n" : "") + line;
      }
    };
    bumpIdle();
    signal?.addEventListener("abort", () => finish("Stopped."));
    child.stdout.on("data", onChunk);
    child.stderr.on("data", (d: Buffer) => {
      bumpIdle();
      const s = d.toString();
      if (/error|fail|not found|ENOENT/i.test(s)) acc.reply += (acc.reply ? "\n" : "") + s.trim();
    });
    child.on("error", (e) => finish(`${provider} failed: ${e.message}. Is it installed and signed in on this machine?`));
    child.on("close", (code) => {
      if (buf.trim()) {
        if (provider === "claude") parseClaudeStream(buf, acc);
        else if (provider === "cursor") parseCursorStream(buf, acc);
        else if (provider === "codex") parseCodexStream(buf, acc);
        else if (provider === "grok-build") parseGrokStream(buf, acc);
        else if (buf.trim()) acc.reply += (acc.reply ? "\n" : "") + buf.trim();
      }
      finish(acc.reply, { failed: hostCliTurnFailed(code, acc.reply) });
    });
  });
}

export async function pingHostCli(provider: string): Promise<HostCliPing> {
  const env = hostEnv();
  if (provider === "grok-build") {
    const bin = grokBin();
    return await new Promise<HostCliPing>((resolve) => {
      const child = spawn(
        bin,
        [
          "-p",
          "Reply with only the word PONG.",
          "--permission-mode",
          "bypassPermissions",
          "--always-approve",
          "--no-alt-screen",
          "--output-format",
          "plain",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 90_000);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message, sample: "", log: e.message, command: bin });
      });
      child.on("close", () => {
        clearTimeout(t);
        resolve({
          ok: /pong/i.test(out),
          sample: out.trim().slice(0, 240),
          log: out.trim().slice(-400),
          command: bin,
          error: /pong/i.test(out) ? null : "Grok CLI did not reply PONG. Sign in with grok login --oauth.",
        });
      });
    });
  }
  if (provider === "hermes") {
    const bin = hermesBin();
    return await new Promise<HostCliPing>((resolve) => {
      const hermesModel = readHermesModel();
      const args = ["-z", "Reply with only the word PONG.", "--yolo"];
      if (hermesModel) args.push("-m", hermesModel);
      const child = spawn(bin, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 90_000);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message, sample: "", log: e.message, command: bin });
      });
      child.on("close", () => {
        clearTimeout(t);
        resolve({
          ok: /\bPONG\b/i.test(out),
          sample: out.trim().slice(-400),
          log: out.trim().slice(-2000),
          command: bin,
        });
      });
    });
  }
  if (provider === "claude") {
    const bin = claudeBin();
    return await new Promise<HostCliPing>((resolve) => {
      const child = spawn(
        bin,
        [
          "-p",
          "Reply with only the word PONG.",
          "--output-format",
          "text",
          "--permission-mode",
          "dontAsk",
          "--no-session-persistence",
          ...claudeModelArgs(""),
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 60_000);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message, sample: "" });
      });
      child.on("close", () => {
        clearTimeout(t);
        resolve({ ok: /\bPONG\b/i.test(out), sample: out.trim().slice(-240), log: out.trim().slice(-2000), command: bin });
      });
    });
  }
  if (provider === "cursor") {
    const bin = cursorBin();
    return await new Promise<HostCliPing>((resolve) => {
      const child = spawn(
        bin,
        [
          "-p",
          "--output-format",
          "text",
          "--force",
          "--trust",
          "--sandbox",
          "disabled",
          "--model",
          "cursor-grok-4.6-low",
          "Reply with only the word PONG. Do not use tools.",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 90_000);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message, sample: "", log: e.message, command: bin });
      });
      child.on("close", () => {
        clearTimeout(t);
        resolve({
          ok: /\bPONG\b/i.test(out),
          sample: out.trim().slice(-240),
          log: out.trim().slice(-2000),
          command: bin,
          error: /\bPONG\b/i.test(out) ? null : "Cursor CLI did not reply PONG. Run cursor-agent login.",
        });
      });
    });
  }
  const bin = codexBin();
  return await new Promise<HostCliPing>((resolve) => {
    const child = spawn(
      bin,
      ["exec", "--skip-git-repo-check", "--ephemeral", "--color", "never", "Reply with only the word PONG. Do not use tools."],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 90_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, error: e.message, sample: "" });
    });
    child.on("close", () => {
      clearTimeout(t);
      resolve({ ok: /\bPONG\b/i.test(out), sample: out.trim().slice(-240), log: out.trim().slice(-2000), command: bin });
    });
  });
}
