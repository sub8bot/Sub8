/**
 * Sub8 desk-harness — Phase 1 prototype (hosts the REAL grok-build harness).
 *
 * Runs ON a desk droplet, next to the desktop. Where the pi-executor
 * (../../.. sub8-cloud/src/desk-executor-source.mjs) REIMPLEMENTS the agent
 * loop, this hosts the actual `grok` CLI (xai-org/grok-build, Apache-2.0) so
 * cloud parity with local is exact — no reimplementation drift.
 *
 * grok-build is natively headless. We run it UNFORKED: config + injected auth
 * only. This module drives `grok -p --output-format streaming-json` (the format
 * parseGrokStream already understands from host-cli.mjs) and auto-attaches
 * mcp-sub8 pointed at the droplet's OWN desk (via writeGrokHome's config.toml,
 * reused unchanged). `grok acp` (ACP JSON-RPC over stdio, same shape as
 * server/hermes-acp.mjs) is the streaming upgrade — noted in the README.
 *
 * The single HTTP surface (server.mjs) exposes POST /turn returning NDJSON
 * events {type:"tool"|"delta"|"done"|"error"} that MATCH the existing executor
 * /turn contract, so the DeskTurn DO drives grok-build with the same relay code
 * (sub8-cloud/src/executor-client.mjs + brain.mjs).
 *
 * NOTHING here is wired to prod. It is gated behind DESK_HARNESS=1 (a sibling of
 * the DESK_EXECUTOR seam) and never runs unless a droplet operator starts it.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../paths.mjs";
import { getBot, patchBot } from "@sub8/store";
import { pluginsForHarness, type HarnessExec } from "@sub8/harness-plugins";
import {
  writeGrokHome,
  parseGrokStream,
  parseClaudeStream,
  claudeBin,
  claudeModelArgs,
  CLAUDE_SAFE_SONNET,
  DESK_DISALLOWED_TOOLS,
  resolveClaudeCliModel,
  mcpServerSpec,
  foldGrokVisibleText,
  grokBin,
  hostEnv,
} from "../host-cli.mjs";
import type { StreamAcc } from "../host-cli.mjs";
import type {
  ClaudeCredentials,
  HistoryMessage,
  ModelSpec,
  ToolEvent,
  TurnCallback,
  TurnEvent,
  TurnUsage,
} from "@sub8/harness-protocol";

/** The NDJSON sink server.mjs hands runTurn: one TurnEvent per line. */
export type EmitTurnEvent = (event: TurnEvent) => void;

/**
 * What runTurn drives on the child it spawned. Structural rather than
 * ChildProcess because opts.spawnGrok is an injection point: the selftest hands
 * back a fake that streams canned lines with no grok and no droplet.
 */
export interface HarnessChild {
  killed?: boolean | undefined;
  /** ChildProcess.kill answers a boolean; nothing here reads it. */
  kill(signal?: NodeJS.Signals | number): void;
  stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null | undefined;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null | undefined;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
}

const DESK_LOCAL_BOT = "desk-local";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** grok 1.0+ requires --session-id to be a UUID. Cloud bot ids are not. */
export function grokSessionId(botId: unknown): string {
  const id = String(botId || "").trim();
  if (UUID_RE.test(id)) return id;
  const b = createHash("sha1").update(`sub8-harness:${id || "desk"}`).digest().subarray(0, 16);
  // sha1 digests 20 bytes and subarray(0, 16) keeps 16 of them, so bytes 6 and
  // 8 are always there; both assertions erase.
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** mcp-sub8 looks up SUB8BOT_BOT_ID in bots.json. Cloud sends the app bot id; the droplet only has desk-local. */
export async function resolveMcpBotId(botId: unknown): Promise<string> {
  const wanted = String(botId || "").trim();
  try {
    if (wanted && (await getBot(wanted))) return wanted;
    if (await getBot(DESK_LOCAL_BOT)) return DESK_LOCAL_BOT;
  } catch {
    /* store unavailable — keep the requested id */
  }
  return wanted;
}

/**
 * Clear the send_message latch at the top of a turn.
 *
 * `awaitingUserSelection` stops a bot talking twice before the user picks. On
 * the local path it is set by mcp-sub8 and cleared by server/index.mts when the
 * user answers. The droplet only gets half of that: the snapshot bundle ships
 * mcp-sub8.mjs (which SETS the flag on a persisted row) but NOT index.mjs,
 * which holds the only two clears in the tree. So one card used to wedge the
 * desk permanently — and because resolveMcpBotId falls back to the shared
 * `desk-local` row, it wedged the desk for every bot, not just the one that
 * asked. Every later send_message answered AWAITING_BLOCKED.
 *
 * A turn arriving IS the user answering, which is the same trigger index.mts
 * clears on, so clearing here restores the local semantics. Best-effort: a
 * missing row or an unavailable store must not fail the turn.
 */
async function clearAwaitingSelection(botId: string): Promise<void> {
  if (!botId) return;
  try {
    await patchBot(botId, (b) => {
      (b as { awaitingUserSelection?: boolean }).awaitingUserSelection = false;
    });
  } catch {
    /* store unavailable — a stale latch is better than a dropped turn */
  }
}

/** Phase-1 flag. A sibling of the DESK_EXECUTOR seam — never on in prod. */
export function harnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env?.DESK_HARNESS || "") === "1";
}

/** Compact drive rules. The full prompt (prompts/grok-build-vm.txt) can be swapped in on a live droplet. */
const RULES = `You are Sub8 on this Bot's Linux desktop. Call it "my computer".
MCP server "sub8" is already connected: computer, browser, shell, memory, vault_list, vault_fill, web_search, and team/routine tools.
Prefer browser for websites (snapshot, click ref, fill, navigate). computer is pixels/dialogs/drag.
If they asked for N bots, list_teammates first, then create_teammate once per bot (name + job) and message_teammate each with the id= the tool returned. Never invent UUIDs.
Call a tool immediately; never claim tools are missing unless a call returned an error.
One short ack, then tools until the job is done, then one result with the concrete answer.`;

/**
 * The POST /turn body as it arrives. harness-protocol names the two shapes this
 * accepts (TurnRequest | SimpleTurnRequest); they are flattened into one
 * all-optional record here because normalizeTurn reads fields off the SAME
 * object without ever discriminating between the two.
 */
export interface TurnBody {
  botId?: string | undefined;
  /** The executor contract's field. The simple shape sends `text` instead. */
  content?: string | undefined;
  text?: string | undefined;
  history?: HistoryMessage[] | undefined;
  system?: string | undefined;
  display?: number | string | undefined;
  provider?: string | undefined;
  /**
   * A grok auth.json (harness-protocol GrokAuthFile) on an OAuth turn, or a bare
   * API key on the simple shape. Nothing here inspects it beyond that: it is
   * written to disk verbatim, or used as the key.
   */
  auth?: Record<string, unknown> | string | undefined;
  claudeAuth?: ClaudeCredentials | undefined;
  /** The canonical shape sends a ModelSpec; the simple shape sends a bare id. */
  model?: Partial<ModelSpec> | string | undefined;
  baseUrl?: string | undefined;
  callback?: Partial<TurnCallback> | undefined;
}

/** One turn, with both request shapes collapsed into the fields runTurn drives. */
export interface NormalizedTurn {
  claudeAuth: ClaudeCredentials | null;
  botId: string;
  text: string;
  history: HistoryMessage[];
  system: string;
  display: number;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Written to GROK_HOME/auth.json as-is, or as JSON when it is an object. */
  authFile: Record<string, unknown> | string | null;
  isOAuth: boolean;
  callback: TurnCallback | null;
}

/**
 * Normalize the request body. Accepts BOTH shapes:
 *  - executor / harness-client: { content, history, system, display,
 *      model:{provider,id,apiKey,baseUrl}, callback:{url,computerId,botId}, auth? }
 *  - task's simple shape: { botId, text, model, provider, auth }
 */
export function normalizeTurn(body: TurnBody = {}): NormalizedTurn {
  const model: Partial<ModelSpec> = body.model && typeof body.model === "object" ? body.model : {};
  const modelId = (typeof body.model === "string" ? body.model : model.id) || "grok-4.6";
  const provider = String(body.provider || model.provider || "").toLowerCase();
  const isOAuth = /oauth/.test(provider);
  // auth.json (OAuth) is injected as a file; an API key goes to XAI_API_KEY.
  const authFile =
    isOAuth && body.auth
      ? body.auth
      : body.auth && typeof body.auth === "object"
        ? body.auth
        : null;
  // Never inherit the droplet's XAI key for Claude: a subscription turn has no
  // key by design, and this fallback would set ANTHROPIC_API_KEY to an xAI key,
  // shadowing the ~/.claude login and failing auth against Anthropic.
  const claudeProvider = /^claude/.test(provider);
  const apiKey = isOAuth
    ? ""
    : model.apiKey ||
      (typeof body.auth === "string" ? body.auth : "") ||
      (claudeProvider ? "" : process.env.XAI_API_KEY || "") ||
      "";
  return {
    // Account-level Claude credential (see claudeImportCredentials).
    claudeAuth: body.claudeAuth && typeof body.claudeAuth === "object" ? body.claudeAuth : null,
    botId: String(body.botId || body.callback?.botId || "").trim(),
    text: String(body.content ?? body.text ?? "").trim(),
    history: Array.isArray(body.history) ? body.history : [],
    system: String(body.system || "").trim(),
    display: Number(body.display || 1) || 1,
    provider: provider || (apiKey ? "xai" : ""),
    model: modelId,
    baseUrl: String(model.baseUrl || body.baseUrl || "").replace(/\/+$/, ""),
    apiKey,
    authFile,
    isOAuth,
    callback:
      body.callback && typeof body.callback === "object"
        ? {
            url: String(body.callback.url || "").trim(),
            computerId: String(body.callback.computerId || "").trim(),
            botId: String(body.callback.botId || body.botId || "").trim(),
          }
        : null,
  };
}

/** Which desk, and which internal API, the spawned mcp-sub8 should talk to. */
export interface HarnessMcpEnvOptions {
  botId?: string | undefined;
  internalToken?: string | undefined;
  port?: number | undefined;
}

/**
 * The env writeGrokHome bakes into [mcp_servers.sub8.env]. Shared with the probe
 * so both spawn the SAME mcp-sub8.
 */
export function harnessMcpEnv({ botId, internalToken, port }: HarnessMcpEnvOptions = {}): Record<string, string> {
  return {
    SUB8BOT_BOT_ID: botId || "",
    SUB8BOT_DATA: dataDir,
    SUB8_INTERNAL_TOKEN: internalToken || "",
    SUB8_INTERNAL_URL: port ? `http://127.0.0.1:${port}` : "",
  };
}

/** What one handshake proves: the tool count, or why there was not one. */
export interface McpProbeResult {
  ok: boolean;
  tools: number;
  error?: string;
}

/**
 * How to launch mcp-sub8. mcpServerSpec's McpServerSpec satisfies this; a test
 * hands in a planted script instead, which is why `env` is optional (undefined
 * means "inherit", exactly as it does for spawn).
 */
export interface McpProbeSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ProbeMcpToolsOptions extends HarnessMcpEnvOptions {
  timeoutMs?: number | undefined;
  spec?: McpProbeSpec | undefined;
  spawnFn?: typeof spawn | undefined;
}

/** As much of a JSON-RPC reply as the handshake reads. */
interface McpProbeMessage {
  id?: number | undefined;
  result?: { tools?: unknown } | undefined;
}

/**
 * Is mcp-sub8 alive? — the check /health never had.
 *
 * Spawns the MCP server through mcpServerSpec, i.e. the SAME command, args and
 * env writeGrokHome bakes into config.toml, and drives one real handshake
 * (initialize → tools/list) over stdio. That is the cheapest probe that can
 * actually fail the way production failed: a missing import or an EACCES on the
 * data dir kills the child before it answers, and both of the outages that hid
 * behind `{ok:true,harness:true,grok:true}` were exactly that.
 *
 * Costs one short-lived node process (~100ms locally, 37 tools). NEVER call it
 * per request — server.mjs caches it and refreshes off the request path.
 */
export async function probeMcpTools({ botId, internalToken, port, timeoutMs = 10_000, spec, spawnFn = spawn }: ProbeMcpToolsOptions = {}): Promise<McpProbeResult> {
  const server: McpProbeSpec = spec || mcpServerSpec(harnessMcpEnv({ botId: botId || DESK_LOCAL_BOT, internalToken, port }));
  return new Promise<McpProbeResult>((resolve) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawnFn(server.command, server.args, { env: server.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, tools: 0, error: String((err as Error)?.message || err) });
      return;
    }
    let settled = false;
    let out = "";
    let errText = "";
    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const fail = (error: unknown) => finish({ ok: false, tools: 0, error: String(error || "mcp-sub8 unreachable") });
    const timer = setTimeout(() => fail(`mcp-sub8 handshake timed out after ${timeoutMs}ms`), timeoutMs);
    const say = (msg: object) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch (err) {
        fail((err as Error)?.message || err);
      }
    };
    child.on("error", (err) => fail(err?.message || err));
    child.stdin?.on("error", () => {
      /* the child died mid-write; 'close'/'error' reports it */
    });
    // Keep the HEAD of stderr: "Error: Cannot find module …" is the first thing
    // a dying mcp-sub8 prints, and the tail is just the "Node.js v25" footer.
    child.stderr?.on("data", (c: Buffer) => {
      if (errText.length < 2000) errText = `${errText}${c}`.slice(0, 2000);
    });
    // A dead mcp-sub8 exits instead of answering — that is the whole signal.
    child.on("close", (code) => {
      const lines = errText.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      // "Error: Cannot find module ..." / "EACCES: permission denied ..." is the
      // line worth logging, not the "Node.js v25" footer it ends on.
      const why = lines.find((l) => /error|EACCES|EPERM|ENOENT/i.test(l)) || lines[0] || "";
      fail(`mcp-sub8 exited ${code}${why ? `: ${why}` : ""}`);
    });
    child.stdout?.on("data", (c: Buffer) => {
      out += c;
      const lines = out.split(/\r?\n/);
      out = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: McpProbeMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === 1) say({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        if (msg?.id === 2) {
          const tools = Array.isArray(msg?.result?.tools) ? msg.result.tools.length : 0;
          finish(tools > 0 ? { ok: true, tools } : { ok: false, tools: 0, error: "mcp-sub8 listed no tools" });
        }
      }
    });
    say({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "desk-harness-health", version: "1" } },
    });
  });
}

/** Everything GROK_HOME needs baked into it for one turn. */
export interface WriteHarnessHomeOptions {
  botId?: string | undefined;
  /** The id mcp-sub8 looks up in bots.json, when it differs from the turn's. */
  mcpBotId?: string | undefined;
  /** grok's auth.json, written verbatim (string) or as JSON (object). */
  authFile?: Record<string, unknown> | string | null | undefined;
  port?: number | undefined;
  internalToken?: string | undefined;
  callback?: Partial<TurnCallback> | null | undefined;
  deskToken?: string | undefined;
  display?: number | string | undefined;
}

/**
 * GROK_HOME for a turn. Reuses writeGrokHome UNCHANGED (config.toml with
 * [mcp_servers.sub8] → node mcp-sub8.mjs, pointed at THIS droplet's desk via
 * the mcpEnv botId). OAuth then overwrites auth.json (oidc record from
 * harness-client, same file pushHostGrokAuth copies locally). API-key turns
 * unlink it so a host ~/.grok/auth.json cannot shadow XAI_API_KEY.
 */
export async function writeHarnessHome({ botId, mcpBotId, authFile, port, internalToken, callback, deskToken, display }: WriteHarnessHomeOptions): Promise<string> {
  const mcpEnv = harnessMcpEnv({ botId: mcpBotId || botId, internalToken, port });
  if (callback?.url) {
    mcpEnv.SUB8_CLOUD_CALLBACK_URL = callback.url;
    mcpEnv.SUB8_CLOUD_COMPUTER_ID = callback.computerId || "";
    mcpEnv.SUB8_CLOUD_BOT_ID = callback.botId || botId || "";
  }
  if (deskToken) mcpEnv.SUB8_DESK_TOKEN = deskToken;
  if (display) mcpEnv.SUB8_DISPLAY = String(display);
  const home = await writeGrokHome(botId, mcpEnv);
  const authPath = path.join(home, "auth.json");
  if (authFile) {
    const raw = typeof authFile === "string" ? authFile : JSON.stringify(authFile);
    await fs.writeFile(authPath, raw, { mode: 0o600 });
  } else {
    await fs.unlink(authPath).catch(() => {});
  }
  return home;
}

/**
 * Claude Code refuses to run with bypassed permissions as root ("--dangerously-
 * skip-permissions cannot be used with root/sudo privileges"), and the desk
 * harness runs as root. So Claude turns are dropped to an unprivileged account.
 * Its home is also where `claude auth login` parks subscription credentials, so
 * the same user must be used for login and for turns or the turn won't see them.
 */
export const CLAUDE_USER = process.env.SUB8_CLAUDE_USER || "sub8";

/** The unprivileged account Claude turns drop to. */
export interface ClaudeRunAs {
  uid: number;
  gid: number;
  home: string;
  user: string;
}

/** uid/gid/home for CLAUDE_USER, or null when we are already unprivileged. */
export function claudeRunAs(user: string = CLAUDE_USER): ClaudeRunAs | null {
  if (typeof process.getuid === "function" && process.getuid() !== 0) return null;
  try {
    const line = spawnSync("getent", ["passwd", String(user)], { encoding: "utf8" });
    const parts = String(line.stdout || "").trim().split(":");
    if (parts.length < 6) return null;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    const home = parts[5] || `/home/${user}`;
    if (!Number.isFinite(uid) || !Number.isFinite(gid)) return null;
    return { uid, gid, home, user: String(user) };
  } catch {
    return null;
  }
}

/**
 * The `claude auth login` child parked between /claude/login/start and
 * /claude/login/code, plus everything it has printed so far.
 */
interface PendingLogin {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  url: string;
  out: () => string;
}

/** What spawning the claude CLI as CLAUDE_USER takes. */
interface ClaudeSpawnOpts {
  env: NodeJS.ProcessEnv;
  cwd: string;
  uid?: number | undefined;
  gid?: number | undefined;
}

/* ------------------------------------------------------------------ claude auth --
 * Subscription login for the desk. `claude auth login --claudeai` prints an
 * authorize URL and then BLOCKS on stdin waiting for the code the user pastes
 * back, so the child has to outlive the request that started it — it is parked
 * here between /claude/login/start and /claude/login/code.
 *
 * Credentials land in CLAUDE_USER's $HOME/.claude, which is the same home turns
 * run with, so a successful login makes every later turn work with no per-turn
 * key injection.
 * ------------------------------------------------------------------------- */

let pendingLogin: PendingLogin | null = null;

function claudeSpawnOpts(): ClaudeSpawnOpts {
  const runAs = claudeRunAs();
  const env = { ...hostEnv() };
  delete env.XAI_API_KEY;
  delete env.ANTHROPIC_API_KEY; // an API key would shadow the subscription login
  if (runAs) env.HOME = runAs.home;
  return {
    env,
    cwd: runAs?.home || process.cwd(),
    ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
  };
}

/** What `claude auth status` prints as JSON. */
interface ClaudeAuthJson {
  loggedIn?: boolean | undefined;
  authMethod?: string | undefined;
}

/** The desk's answer for /claude/auth. */
export interface ClaudeAuthState {
  ok: boolean;
  loggedIn: boolean;
  authMethod: string;
  raw?: unknown;
  error?: string;
}

/**
 * The plugins this desk's harness exposes and whether each is connected, read
 * from the harness's own CLI as the desk's claude user. Same JSON shape the
 * local app's GET /api/harness/:provider/plugins answers, so every client
 * renders one thing.
 */
export async function harnessPlugins(provider = "claude"): Promise<Record<string, unknown>> {
  const src = pluginsForHarness(provider);
  if (!src) return { ok: true, provider, supported: false, plugins: [] };
  const opts = claudeSpawnOpts();
  const exec: HarnessExec = {
    async run(file, args, o) {
      const bin = file === "claude" ? claudeBin() : file;
      const r = spawnSync(bin, args, { ...opts, env: { ...opts.env, NO_COLOR: "1" }, encoding: "utf8", timeout: o?.timeoutMs ?? 45_000 });
      return { stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), code: r.status ?? 0 };
    },
  };
  try {
    const plugins = await src.listPlugins(exec);
    return { ok: true, provider, supported: true, label: src.label, plugins, checkedAt: Date.now() };
  } catch (e) {
    return { ok: false, provider, supported: true, plugins: [], error: String((e as Error)?.message || e) };
  }
}

/** `claude auth status` as the desk's claude user. Machine-readable JSON. */
export async function claudeAuthStatus(): Promise<ClaudeAuthState> {
  const opts = claudeSpawnOpts();
  const r = spawnSync(claudeBin(), ["auth", "status"], { ...opts, encoding: "utf8", timeout: 20_000 });
  const raw = String(r.stdout || "").trim();
  try {
    const j: ClaudeAuthJson = JSON.parse(raw);
    return { ok: true, loggedIn: Boolean(j.loggedIn), authMethod: j.authMethod || "none", raw: j };
  } catch {
    return { ok: false, loggedIn: false, authMethod: "none", error: raw || String(r.stderr || "").trim() };
  }
}

export async function claudeLogout(): Promise<ClaudeAuthState> {
  const opts = claudeSpawnOpts();
  spawnSync(claudeBin(), ["auth", "logout"], { ...opts, encoding: "utf8", timeout: 20_000 });
  if (pendingLogin?.child) {
    try {
      pendingLogin.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    pendingLogin = null;
  }
  return claudeAuthStatus();
}

/** Where Claude Code parks the subscription OAuth blob for CLAUDE_USER. */
function claudeCredentialsPath(): string {
  const runAs = claudeRunAs();
  const home = runAs?.home || process.env.HOME || "/root";
  return path.join(home, ".claude", ".credentials.json");
}

/** What the two credential endpoints answer with. */
export interface ClaudeCredentialsResult {
  ok: boolean;
  credentials?: ClaudeCredentials;
  error?: string;
}

/**
 * The signed-in credential, so the Worker can store it on the ACCOUNT and hand
 * it to the user's other desks. Without this a login covers exactly one desk.
 */
export async function claudeExportCredentials(): Promise<ClaudeCredentialsResult> {
  try {
    const raw = await fs.readFile(claudeCredentialsPath(), "utf8");
    const parsed: ClaudeCredentials | null = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "no credentials" };
    return { ok: true, credentials: parsed };
  } catch {
    return { ok: false, error: "not signed in on this desk" };
  }
}

/** Adopt an account-level credential on THIS desk. Mirrors grok's auth.json injection. */
export async function claudeImportCredentials(credentials: ClaudeCredentials | null | undefined): Promise<ClaudeCredentialsResult> {
  if (!credentials || typeof credentials !== "object") return { ok: false, error: "no credentials" };
  const runAs = claudeRunAs();
  const file = claudeCredentialsPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
    if (runAs) {
      // Written by root; Claude reads it as the unprivileged user.
      spawnSync("chown", ["-R", `${runAs.uid}:${runAs.gid}`, path.dirname(file)], { timeout: 20_000 });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

const AUTH_URL_RE = /(https:\/\/claude\.com\/[^\s]*oauth\/authorize[^\s]*)/;

/** The authorize URL to show the user, or why there is not one. */
export interface ClaudeLoginStartResult {
  ok: boolean;
  url?: string;
  /** A login was already parked with a URL; the same one is handed back. */
  reused?: boolean;
  error?: string;
}

/**
 * Begin subscription login. Resolves once the authorize URL has been printed;
 * the child stays alive waiting for the code.
 */
export function claudeLoginStart({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<ClaudeLoginStartResult> {
  if (pendingLogin?.child && !pendingLogin.child.killed && pendingLogin.url) {
    return Promise.resolve({ ok: true, url: pendingLogin.url, reused: true });
  }
  return new Promise<ClaudeLoginStartResult>((resolve) => {
    let out = "";
    let settled = false;
    const child = spawn(claudeBin(), ["auth", "login", "--claudeai"], {
      ...claudeSpawnOpts(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state = { child, url: "", out: () => out };
    pendingLogin = state;
    const done = (val: ClaudeLoginStartResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const onData = (c: Buffer) => {
      out += c.toString();
      const m = out.match(AUTH_URL_RE);
      if (m && !state.url) {
        // AUTH_URL_RE has one required capture group, so a match always has [1].
        state.url = m[1]!;
        done({ ok: true, url: m[1]! });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      pendingLogin = null;
      done({ ok: false, error: `claude login failed to start: ${e.message}` });
    });
    child.on("close", () => {
      if (pendingLogin === state) pendingLogin = null;
      done({ ok: false, error: out.trim() || "claude login exited before printing a URL" });
    });
    const timer = setTimeout(() => {
      done({ ok: false, error: out.trim() || "timed out waiting for the authorize URL" });
    }, timeoutMs);
  });
}

/** Whether the pasted code completed the login. */
export interface ClaudeLoginCodeResult {
  ok: boolean;
  loggedIn?: boolean;
  authMethod?: string;
  error?: string;
}

/** Finish login by pasting the code the user got from the authorize page. */
export async function claudeLoginCode(
  code: unknown,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<ClaudeLoginCodeResult> {
  const text = String(code || "").trim();
  if (!text) return { ok: false, error: "No code." };
  const state = pendingLogin;
  if (!state?.child || state.child.killed) {
    return { ok: false, error: "No login in progress. Start again." };
  }
  const exited = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    state.child.on("close", finish);
    const timer = setTimeout(finish, timeoutMs);
  });
  try {
    state.child.stdin.write(`${text}\n`);
  } catch (e) {
    return { ok: false, error: `could not send the code: ${(e as Error).message}` };
  }
  await exited;
  if (pendingLogin === state) pendingLogin = null;
  const status = await claudeAuthStatus();
  if (!status.loggedIn) {
    const tail = String(state.out() || "").trim().split("\n").slice(-3).join(" ").slice(-300);
    return { ok: false, loggedIn: false, error: tail || "login did not complete" };
  }
  return { ok: true, loggedIn: true, authMethod: status.authMethod };
}

/** True when this turn should run Claude Code instead of grok. */
export function isClaudeProvider(provider: unknown): boolean {
  return /^claude/.test(String(provider || "").toLowerCase());
}

/** One headless Claude turn, as the CLI wants it spelled. */
export interface ClaudeArgsOptions {
  prompt: string;
  model?: string | undefined;
  sessionId: string;
  /** The --mcp-config file the caller wrote for this turn. */
  mcpFile: string;
  system?: string | undefined;
}

/**
 * Claude Code args for a headless streaming-json turn — mirrors runHostCli's
 * claude branch. Unlike grok (which reads MCP from config.toml in GROK_HOME),
 * Claude takes an explicit --mcp-config file, so the caller writes one.
 */
export function claudeArgs({ prompt, model, sessionId, mcpFile, system }: ClaudeArgsOptions): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--disallowedTools",
    ...DESK_DISALLOWED_TOOLS,
    "--mcp-config",
    mcpFile,
    ...(system ? ["--append-system-prompt", system] : []),
    "--session-id",
    sessionId,
    ...claudeModelArgs(model),
  ];
}

/** As much of a Claude stream-json event as feedClaudeLine reads. */
interface ClaudeTurnEvent {
  type?: string | undefined;
  subtype?: string | undefined;
  /**
   * An assistant event carries the message object. An error event puts a string
   * here instead, and the only thing that reads it there is String().
   */
  message?:
    | {
        content?:
          | Array<{ type?: string | undefined; name?: unknown; input?: Record<string, unknown> | undefined }>
          | undefined;
      }
    | undefined;
  error?: unknown;
  result?: unknown;
}

/**
 * Claude's stream-json into the same {tool,delta,done} events the Worker reads
 * from the grok path, so harness-client and the DeskTurn DO need no changes.
 */
export function feedClaudeLine(line: unknown, acc: StreamAcc, emit: EmitTurnEvent): void {
  const raw = String(line || "").trim();
  if (!raw) return;
  if (raw[0] !== "{") {
    // Claude reports startup failures as plain text on stderr (e.g. the root
    // refusal). Swallowing them left the turn reporting "(no output)" with no
    // clue why, which is exactly how the root problem stayed hidden.
    if (/error|cannot be used|not found|invalid|unauthorized|forbidden/i.test(raw)) {
      acc.reply = acc.reply || raw;
      emit({ type: "delta", text: raw });
    }
    return;
  }
  let evt: ClaudeTurnEvent;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  // Surface tool use so the chat shows activity rows, same as grok.
  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const part of evt.message.content) {
      if (part?.type === "tool_use") {
        emit({ type: "tool", name: String(part.name || "tool"), args: part.input || {} });
      }
    }
  }
  if (evt.type === "error" || evt.subtype === "error_during_execution") {
    const message = String(evt.message || evt.error || evt.result || "claude error").trim();
    acc.reply = acc.reply || message;
    emit({ type: "delta", text: message });
    return;
  }
  const before = acc.reply || "";
  parseClaudeStream(raw, acc);
  const after = acc.reply || "";
  if (after && after !== before) {
    const piece = after.startsWith(before) ? after.slice(before.length) : after;
    if (piece.trim()) emit({ type: "delta", text: piece });
  }
}

/** One headless grok turn, as the CLI wants it spelled. */
export interface GrokArgsOptions {
  prompt: string;
  model?: string | undefined;
  /** Omitted on the test path; runTurn always sends a fresh UUID. */
  sessionId?: string | undefined;
  /** --cwd: the scratch dir the turn runs in. */
  work: string;
}

/** grok CLI args for a headless streaming-json turn — mirrors runHostCli's grok-build path. */
export function grokArgs({ prompt, model, sessionId, work }: GrokArgsOptions): string[] {
  const args = [
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
    RULES,
    "--cwd",
    work,
  ];
  if (model) args.push("-m", model);
  // grok 1.0+ rejects --session-id if that UUID already exists (stderr:
  // "Session ID … is already in use") and exits before session_create. Cloud
  // turns already send history in the prompt, so each turn gets a fresh UUID.
  args.push("--session-id", sessionId || randomUUID());
  return args;
}

/** A tool call, folded into the two fields a Worker tool row renders. */
export interface GrokToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** A tool's input as grok sends it: an object, or JSON in a string. */
type GrokToolInput = Record<string, unknown> | string;

/**
 * As much of one grok streaming-json line as this file reads. The ACP payload
 * (params.update), its flat-event aliases, and the merge of the two all pass
 * through here, which is why every field is optional and why `update` is this
 * same shape.
 */
export interface GrokLineEvent {
  type?: string | undefined;
  event?: string | undefined;
  method?: string | undefined;
  params?: { update?: GrokLineEvent | undefined } | undefined;
  update?: GrokLineEvent | undefined;
  sessionUpdate?: string | undefined;
  session_update?: string | undefined;
  content?: { text?: string | undefined; content?: string | undefined } | undefined;
  tool?: { name?: string | undefined; input?: GrokToolInput | undefined } | undefined;
  toolName?: string | undefined;
  tool_name?: string | undefined;
  name?: string | undefined;
  title?: string | undefined;
  rawInput?: GrokToolInput | undefined;
  rawOutput?: { command?: unknown } | undefined;
  input?: GrokToolInput | undefined;
  arguments?: GrokToolInput | undefined;
  message?: unknown;
  data?: unknown;
  text?: unknown;
  result?: unknown;
}

/**
 * grok-build 1.0+ streaming-json tool events are ACP session/update payloads:
 *   params.update.sessionUpdate = "tool_call" | "tool_call_update"
 *   title/toolName = "use_tool" | "search_tool"
 *   rawInput.tool_name = "sub8__computer"  rawInput.tool_input = { action, x, y }
 * Older canned lines use top-level { type:"tool_call", toolName, rawInput }.
 * Worker tool rows want { type:"tool", name:"computer", args:{ action:"mouse_move" } }.
 * Returns {name,args} to emit, "skip" for duplicates/noise, or null if not a tool line.
 */
export function grokToolFromEvent(evt: GrokLineEvent | null | undefined): GrokToolCall | "skip" | null {
  const update: GrokLineEvent = evt?.params?.update || evt?.update || {};
  const sessionUpdate = String(update.sessionUpdate || update.session_update || "");
  const typ = String(evt?.type || evt?.event || sessionUpdate || "");
  const src: GrokLineEvent = sessionUpdate ? { ...evt, ...update } : evt || {};
  const isTool = /tool_call/i.test(typ) || Boolean(src.tool || src.toolName || src.tool_name);
  if (!isTool) return null;
  // tool_call_update is the same call's status/content — emitting it triples rows as name "tool".
  if (/tool_call_update/i.test(typ) || /tool_call_update/i.test(sessionUpdate)) return "skip";

  let input: GrokToolInput = src.rawInput || src.input || src.arguments || src.tool?.input || {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = { raw: input };
    }
  }
  let name: string = src.toolName || src.tool_name || src.tool?.name || src.name || src.title || "tool";
  let args: Record<string, unknown> = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const wrapped = args.tool_name || args.toolName;
  const wrappedInput = args.tool_input || args.toolInput;
  if (/^(use_tool|mcp)$/i.test(String(name)) && wrapped) {
    name = String(wrapped).replace(/^sub8__/, "");
    args =
      wrappedInput && typeof wrappedInput === "object" && !Array.isArray(wrappedInput)
        ? { ...wrappedInput }
        : {};
  }
  if (/^search_tool$/i.test(String(name))) return "skip";
  // `input` is whatever the line carried: an object, or a JSON string parsed
  // into one above. Reading .command off a non-object hands back undefined here
  // exactly as it did before — the assertions only tell tsc the union is fine.
  if (!args.command && (src.rawOutput?.command || (input as Record<string, unknown>).command)) {
    args.command = src.rawOutput?.command || (input as Record<string, unknown>).command;
  }
  return { name, args };
}

/**
 * Translate one grok streaming-json line into executor-contract NDJSON events.
 * - tool_call → {type:"tool", name, args}  (args carries action/command/query so
 *   brain.mjs's toolSummary + tool-row rendering work unchanged)
 * - text delta → {type:"delta", text}
 * parseGrokStream(line, acc) is ALSO run so acc.reply holds the folded final
 * reply used for the {type:"done"} content.
 */
export function feedGrokLine(line: unknown, acc: StreamAcc, emit: EmitTurnEvent): void {
  const raw = String(line || "").trim();
  if (!raw) return;
  if (raw[0] !== "{") {
    if (/^Error:/i.test(raw)) {
      const message = raw.replace(/^Error:\s*/i, "").trim();
      acc.reply = acc.reply || message;
      emit({ type: "delta", text: message });
    }
    return;
  }
  let evt: GrokLineEvent;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  const typ = String(evt.type || evt.event || "");
  if (typ === "error") {
    const message = String(evt.message || evt.data || evt.text || "grok error").trim();
    acc.reply = acc.reply || message;
    emit({ type: "delta", text: message });
    return;
  }
  const tool = grokToolFromEvent(evt);
  if (tool === "skip") {
    parseGrokStream(raw, acc);
    return;
  }
  if (tool) {
    emit({ type: "tool", name: tool.name, args: tool.args });
  } else {
    // Extract the same incremental text piece parseGrokStream would fold, and
    // stream it live as a delta (do NOT stream on tool/result lines).
    const update: GrokLineEvent = evt.params?.update || evt.update || {};
    const kind = update.sessionUpdate || update.session_update || evt.method || "";
    const chunk = update.content?.text || update.content?.content || "";
    const piece =
      (typ === "text" && typeof evt.data === "string" && evt.data) ||
      (typeof evt.text === "string" && evt.text) ||
      (/agent_message/i.test(kind) ? chunk : "");
    if (piece && typ !== "result") emit({ type: "delta", text: String(piece) });
  }
  // Maintain the folded final reply (handles result/override too).
  parseGrokStream(raw, acc);
}

const IDLE_MS = 180_000;
const HARD_MS = 20 * 60_000;

/** What a turn spawns, and as whom. Handed to opts.spawnGrok verbatim. */
export interface GrokSpawnSpec {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  provider: string;
  model: string;
  /** Set only on the Claude path, where the turn drops to CLAUDE_USER. */
  uid?: number | undefined;
  gid?: number | undefined;
}

/** The desk's own wiring for a turn: who to call back, and how to stop. */
export interface RunTurnOptions {
  internalPort?: number | undefined;
  internalToken?: string | undefined;
  deskToken?: string | undefined;
  signal?: AbortSignal | undefined;
  spawnGrok?: ((spec: GrokSpawnSpec) => HarnessChild) | undefined;
}

/**
 * StreamAcc plus the usage the done event reads off it. Nothing writes `usage`
 * today, so the event carries the zeroed fallback; it stays here because that
 * is the field the executor contract reserves for it.
 */
interface TurnAcc extends StreamAcc {
  usage?: TurnUsage | undefined;
}

/**
 * Run one turn end-to-end. Emits NDJSON events to `emit`, resolves with the
 * final text. `opts.spawnGrok(spec)` is injectable so the selftest can drive
 * the whole parse→emit pipeline with a canned stream and no grok/droplet.
 */
export async function runTurn(body: TurnBody, emit: EmitTurnEvent, opts: RunTurnOptions = {}): Promise<string> {
  const t = normalizeTurn(body);
  if (!t.botId) t.botId = "desk-local";
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-harness-"));
  const mcpBotId = await resolveMcpBotId(t.botId);
  await clearAwaitingSelection(mcpBotId);
  const home = await writeHarnessHome({
    botId: t.botId,
    mcpBotId,
    authFile: t.authFile,
    port: opts.internalPort,
    internalToken: opts.internalToken,
    callback: t.callback,
    deskToken: opts.deskToken,
    display: t.display,
  });
  const claude = isClaudeProvider(t.provider);
  // Account-level Claude credential, handed over per turn exactly like grok's
  // auth.json. This is what makes one sign-in cover every desk: a desk that was
  // never signed in adopts the account's credential and just works.
  if (claude && t.claudeAuth) {
    // Not "is there a file" — "does the CLI consider itself logged in". A desk
    // holding a hollow or expired file never re-adopted a fresh credential.
    const status = await claudeAuthStatus().catch(() => ({ loggedIn: false }));
    if (!status.loggedIn) await claudeImportCredentials(t.claudeAuth);
  }
  const prompt = claude
    ? `${t.text}\n\nUse the sub8 tools. Do not only send a plan.`
    : `${t.system ? `${t.system}\n\n` : ""}${t.text}\n\nUse the sub8 tools. Do not only send a plan.`;

  const env: NodeJS.ProcessEnv = { ...hostEnv(), GROK_HOME: home };
  let args: string[];
  let mcpFilePath: string | null = null;
  if (claude) {
    // Claude takes MCP as an explicit file; grok reads config.toml from GROK_HOME.
    const mcpFile = path.join(work, "mcp.json");
    const mcpJson = JSON.stringify(
      {
        mcpServers: {
          sub8: mcpServerSpec({
            SUB8BOT_BOT_ID: mcpBotId || t.botId,
            SUB8BOT_DATA: dataDir,
            SUB8_INTERNAL_TOKEN: opts.internalToken || "",
            SUB8_INTERNAL_URL: opts.internalPort ? `http://127.0.0.1:${opts.internalPort}` : "",
            ...(t.callback?.url
              ? {
                  SUB8_CLOUD_CALLBACK_URL: t.callback.url,
                  SUB8_CLOUD_COMPUTER_ID: t.callback.computerId || "",
                  SUB8_CLOUD_BOT_ID: t.callback.botId || t.botId || "",
                }
              : {}),
            ...(opts.deskToken ? { SUB8_DESK_TOKEN: opts.deskToken } : {}),
            ...(t.display ? { SUB8_DISPLAY: String(t.display) } : {}),
          }),
        },
      },
      null,
      2,
    );
    // 0600, not the 0644 an unmasked create gives: this file carries
    // SUB8_INTERNAL_TOKEN and SUB8_DESK_TOKEN, and it lives in a dir that is
    // chmod'd 0777 below, on a droplet whose /tmp is shared. The Claude CLI
    // still has to READ it as the unprivileged run-as user, so the runAs block
    // below hands it ownership -- 0600 alone would make it unreadable there.
    mcpFilePath = mcpFile;
    await fs.writeFile(mcpFile, mcpJson, { mode: 0o600 });
    args = claudeArgs({ prompt, model: t.model, sessionId: randomUUID(), mcpFile, system: t.system });
    // Claude authenticates by ANTHROPIC_API_KEY, or by an OAuth login already on
    // the desk (~/.claude). A stray XAI key must not leak into its env.
    delete env.XAI_API_KEY;
    delete env.XAI_BASE_URL;
    const claudeModel = resolveClaudeCliModel(t.model);
    env.ANTHROPIC_MODEL = claudeModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = CLAUDE_SAFE_SONNET;
    if (t.apiKey) env.ANTHROPIC_API_KEY = t.apiKey;
    if (t.baseUrl && /anthropic/i.test(t.baseUrl)) env.ANTHROPIC_BASE_URL = t.baseUrl;
  } else {
    args = grokArgs({ prompt, model: t.model, work, sessionId: randomUUID() });
    // hostEnv copies process.env. OAuth is auth.json; a droplet XAI_API_KEY must not shadow it.
    if (t.isOAuth) delete env.XAI_API_KEY;
    else if (t.apiKey) env.XAI_API_KEY = t.apiKey;
    if (t.baseUrl) env.XAI_BASE_URL = t.baseUrl;
  }

  const spawnGrok = opts.spawnGrok || defaultSpawnGrok;
  const runAs = claude ? claudeRunAs() : null;
  if (runAs) {
    // Claude reads credentials from $HOME/.claude — the same home "claude auth
    // login" writes to. Point at it, and make the scratch dir writable by that
    // user or the CLI cannot create its session files.
    env.HOME = runAs.home;
    env.USER = runAs.user;
    env.LOGNAME = runAs.user;
    env.SHELL = "/bin/bash";
    // systemd injects these into the harness; Claude's API client has treated
    // them as part of a broken auth/model path (404 model_not_found).
    delete env.MEMORY_PRESSURE_WATCH;
    delete env.MEMORY_PRESSURE_WRITE;
    delete env.JOURNAL_STREAM;
    delete env.INVOCATION_ID;
    delete env.SYSTEMD_EXEC_PID;
    delete env.SUDO_USER;
    delete env.SUDO_UID;
    delete env.SUDO_GID;
    delete env.SUDO_COMMAND;
    delete env.SUDO_HOME;
    try {
      await fs.chmod(work, 0o777);
    } catch {
      /* best effort */
    }
    // Give the run-as user the mcp.json written above. NOT best-effort: if the
    // chown fails the file stays root-owned 0600 and the CLI cannot read its
    // MCP config at all, so fall back to group-readable rather than ship a
    // turn whose tools silently never load.
    if (mcpFilePath) {
      try {
        await fs.chown(mcpFilePath, runAs.uid, runAs.gid);
      } catch {
        try {
          await fs.chmod(mcpFilePath, 0o640);
          await fs.chown(mcpFilePath, 0, runAs.gid);
        } catch {
          /* leave it 0600: a readable-token file is worse than a failed turn */
        }
      }
    }
    // mcp-sub8 runs as the same unprivileged user and writes locks, settings and
    // bot state under SUB8BOT_DATA, which the root-owned bake leaves at 0755
    // root:root. Without this the tools load but every call fails EACCES —
    // observed as "permission denied ... lock files ... /opt/sub8-harness/data".
    // root keeps write access to a directory it no longer owns, so grok is fine.
    try {
      spawnSync("chown", ["-R", `${runAs.uid}:${runAs.gid}`, dataDir], { timeout: 20_000 });
    } catch {
      /* best effort */
    }
  }
  const spec: GrokSpawnSpec = {
    bin: claude ? claudeBin() : grokBin(),
    args,
    env,
    cwd: work,
    home,
    provider: t.provider,
    model: t.model,
    ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
  };

  return await new Promise<string>((resolve) => {
    const acc: TurnAcc = { reply: "", parts: [] };
    let buf = "";
    let done = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let child: HarnessChild | undefined;
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(acc.reply.trim() || `${claude ? "Claude" : "Grok Build"} went silent for 3 minutes. Send another message to continue.`),
        IDLE_MS,
      );
    };
    const hardTimer = setTimeout(() => finish(acc.reply.trim() || `${claude ? "Claude" : "Grok Build"} hit the 20 minute limit.`), HARD_MS);
    const finish = (text: string) => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        if (child && !child.killed) child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const content = String(text || "").trim() || "(no output from grok)";
      emit({ type: "done", content, usage: acc.usage || { llmCalls: 0, promptTokens: 0, completionTokens: 0 } });
      resolve(content);
    };
    const feedLine = claude ? feedClaudeLine : feedGrokLine;
    const onChunk = (chunk: Buffer) => {
      bumpIdle();
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) feedLine(line, acc, emit);
    };
    try {
      child = spawnGrok(spec);
    } catch (err) {
      emit({ type: "error", message: `grok spawn failed: ${(err as Error).message}` });
      return finish("");
    }
    opts.signal?.addEventListener?.("abort", () => finish("Stopped."));
    bumpIdle();
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (e) => {
      emit({ type: "error", message: `grok failed: ${e.message}. Is grok installed and authed on this droplet?` });
      finish("");
    });
    child.on("close", () => {
      if (buf.trim()) feedLine(buf, acc, emit);
      finish(
        claude
          ? acc.reply || foldGrokVisibleText([...(acc.parts || [])].filter(Boolean))
          : foldGrokVisibleText([...(acc.parts || []), acc.cur].filter(Boolean)) || acc.reply,
      );
    });
  });
}

function defaultSpawnGrok(spec: GrokSpawnSpec): HarnessChild {
  // Node spawn({uid,gid}) 404s Claude's first API call as model_not_found.
  // sudo -u sets SUDO_* and Claude then refuses --dangerously-skip-permissions.
  // setpriv matches the working desk probe: drop to sub8 without sudo env.
  const claudeAsUser = Number.isFinite(spec.uid) && /claude/i.test(String(spec.bin));
  const child = claudeAsUser
    ? spawn(
        "setpriv",
        [
          `--reuid=${spec.uid}`,
          `--regid=${spec.gid}`,
          "--init-groups",
          "--inh-caps=-all",
          "--",
          spec.bin,
          ...spec.args,
        ],
        { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] },
      )
    : spawn(spec.bin, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        ...(Number.isFinite(spec.uid) ? { uid: spec.uid, gid: spec.gid } : {}),
      });
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  return child;
}

// ------------------------------------------------------------------ selftest --

/** Canned grok streaming-json lines — exercise tool + delta + result → done. */
const CANNED_STREAM: string[] = [
  JSON.stringify({ type: "tool_call", toolCallId: "t1", toolName: "computer", rawInput: { action: "open", text: "https://maps.google.com" } }),
  JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Opening" } } } }),
  JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: " Maps." } } } }),
  JSON.stringify({ type: "tool_call", toolCallId: "t2", toolName: "shell", rawInput: { command: "ls /config" } }),
  JSON.stringify({ type: "result", result: "Cheapest is $240 Frontier SFO-DCA." }),
];

/** What the selftest keeps from the spawn it faked. */
interface CapturedSpawn {
  spec?: GrokSpawnSpec | undefined;
}

/**
 * A listener as the fake ACCEPTS it. The parameter is `never` because on() takes
 * both an error listener and a close listener, which are handed different
 * arguments; the two lists below re-state what each is really called with.
 */
type FakeListener = (arg: never) => void;

/** A fake child that streams CANNED_STREAM then closes — no grok, no droplet. */
function fakeSpawnGrok(spec: GrokSpawnSpec, captured: CapturedSpawn): HarnessChild {
  captured.spec = spec;
  const listeners: {
    close: Array<(code: number) => void>;
    error: Array<(err: Error) => void>;
    [event: string]: FakeListener[];
  } = { close: [], error: [] };
  const outCbs: Array<(chunk: Buffer) => void> = [];
  const child: HarnessChild = {
    killed: false,
    kill() {
      this.killed = true;
    },
    stdout: { on: (ev: string, cb: (chunk: Buffer) => void) => ev === "data" && outCbs.push(cb) },
    stderr: { on: () => {} },
    on: (ev: string, cb: FakeListener) => listeners[ev]?.push(cb),
  };
  setImmediate(() => {
    for (const line of CANNED_STREAM) for (const cb of outCbs) cb(Buffer.from(`${line}\n`));
    for (const cb of listeners.close) cb(0);
  });
  return child;
}

export async function selftest(): Promise<string[]> {
  const results: string[] = [];

  // 1) Wiring: writeHarnessHome reuses writeGrokHome → config.toml auto-attaches
  //    mcp-sub8 pointed at THIS bot's desk; OAuth path injects auth.json.
  const home = await writeHarnessHome({ botId: "selftest-bot", authFile: { access_token: "FAKE" }, port: 8123, internalToken: "tok" });
  const toml = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert(/\[mcp_servers\.sub8\]/.test(toml), "config.toml must auto-attach [mcp_servers.sub8]");
  assert(/mcp-sub8/.test(toml), "config.toml sub8 server must point at mcp-sub8");
  assert(/SUB8BOT_BOT_ID = "selftest-bot"/.test(toml), "mcp env must carry the bot id (drives THIS desk)");
  const auth = await fs.readFile(path.join(home, "auth.json"), "utf8");
  assert(/FAKE/.test(auth), "OAuth path must inject auth.json");
  results.push("home+config+auth wired");

  // 2) /turn pipeline: canned grok stream → executor-contract NDJSON events.
  const events: TurnEvent[] = [];
  const captured: CapturedSpawn = {};
  const text = await runTurn(
    { botId: "selftest-bot", content: "cheapest SFO->DCA flight", provider: "xai", model: { id: "grok-4.6", apiKey: "xai-KEY" } },
    (e) => events.push(e),
    { spawnGrok: (spec) => fakeSpawnGrok(spec, captured) },
  );

  const tools = events.filter((e) => e.type === "tool").map((e) => e.name);
  for (const n of ["computer", "shell"]) {
    assert(tools.includes(n), `selftest: tool ${n} never emitted (saw ${tools.join(",")})`);
  }
  const openTool = events.find((e): e is ToolEvent => e.type === "tool" && e.name === "computer");
  assert(openTool?.args?.action === "open", "computer tool must carry args.action for brain.mjs tool rows");
  assert(events.some((e) => e.type === "delta" && /Maps/.test(e.text)), "selftest: no text delta streamed");
  const dones = events.filter((e) => e.type === "done");
  assert(dones.length === 1, `selftest: expected exactly one done event, got ${dones.length}`);
  // The assert above proved there is exactly one done event; all four erase.
  assert(/\$240 Frontier/.test(dones[0]!.content), `selftest: done.content wrong: ${dones[0]!.content}`);
  assert(dones[0]!.usage && typeof dones[0]!.usage === "object", "done event must carry usage (executor contract)");
  assert(!events.some((e) => e.type === "error"), "selftest: unexpected error event");
  assert(/\$240 Frontier/.test(text), `selftest: returned text wrong: ${text}`);
  results.push("turn streamed tool+delta+done matching executor contract");

  // 3) Auth wiring: API-key path sets XAI_API_KEY in the spawn env.
  assert(captured.spec?.env?.XAI_API_KEY === "xai-KEY", "API-key path must set XAI_API_KEY in grok env");
  assert(captured.spec?.env?.GROK_HOME, "grok must run with GROK_HOME set");
  assert(captured.spec?.args?.includes("streaming-json"), "grok must run --output-format streaming-json");
  assert(captured.spec?.args?.includes("--session-id"), "grok must get a fresh --session-id per turn");
  assert(!captured.spec?.args?.includes("--resume"), "cloud turns must not --resume a prior session id");
  let keyAuth = false;
  try {
    // Both assertions are guarded by the two asserts above: the spawn was
    // captured, and it ran with GROK_HOME set.
    await fs.access(path.join(captured.spec!.env.GROK_HOME!, "auth.json"));
    keyAuth = true;
  } catch {
    /* expected — API-key path unlinks host auth.json */
  }
  assert(!keyAuth, "API-key path must not leave GROK_HOME/auth.json");
  results.push("grok spawn env (XAI_API_KEY + GROK_HOME) correct");

  // 4) OAuth path: write oidc auth.json and do not leak a process-env API key.
  const prevKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "should-not-leak";
  try {
    const oauthEvents: TurnEvent[] = [];
    const oauthCaptured: CapturedSpawn = {};
    const oidcAuth = {
      "https://auth.x.ai::test-client": {
        auth_mode: "oidc",
        key: "oauth-KEY",
        refresh_token: "rt",
        user_id: "00000000-0000-4000-8000-000000000001",
        create_time: "2026-01-01T00:00:00.000Z",
      },
    };
    await runTurn(
      { botId: "selftest-bot", content: "oauth turn", provider: "grok-oauth", auth: oidcAuth },
      (e) => oauthEvents.push(e),
      { spawnGrok: (spec) => fakeSpawnGrok(spec, oauthCaptured) },
    );
    assert(!oauthCaptured.spec?.env?.XAI_API_KEY, "OAuth path must not set XAI_API_KEY");
    // runTurn always spawns with GROK_HOME set — the assert on the line above
    // reads the same spawn's env, so both assertions are safe here too.
    const injected: Record<string, { auth_mode?: string; key?: string }> = JSON.parse(
      await fs.readFile(path.join(oauthCaptured.spec!.env.GROK_HOME!, "auth.json"), "utf8"),
    );
    assert(injected["https://auth.x.ai::test-client"]?.auth_mode === "oidc", "OAuth path must write oidc auth.json");
    assert(injected["https://auth.x.ai::test-client"]?.key === "oauth-KEY", "OAuth path must keep the access token in key");
    assert(oauthEvents.some((e) => e.type === "done") && !oauthEvents.some((e) => e.type === "error"), "OAuth canned stream must emit done, not error");
    results.push("oauth auth.json injected, XAI_API_KEY omitted");
  } finally {
    if (prevKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevKey;
  }

  return results;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
