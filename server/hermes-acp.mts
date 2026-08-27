import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * One JSON-RPC envelope on the wire, in either direction. `id` is `number |
 * string` because we only ever mint numbers but JSON-RPC lets the peer send a
 * string, and `handleLine` echoes whatever it was straight back.
 */
export interface AcpEnvelope {
  jsonrpc: string;
  id?: number | string | undefined;
  method?: string | undefined;
  params?: unknown;
  result?: unknown;
}

/** A `result` payload. Only the session id is read; the rest rides along. */
export interface AcpResult {
  sessionId?: string | undefined;
  session_id?: string | undefined;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId?: string | undefined;
  id?: string | undefined;
}

export interface AcpUpdate {
  sessionUpdate?: string | undefined;
  session_update?: string | undefined;
  content?: { text?: string | undefined; content?: string | undefined } | undefined;
}

/** An inbound line, once JSON.parse has had it. Every field is optional: this is the wire. */
export interface AcpMessage {
  id?: number | string | undefined;
  method?: string | undefined;
  error?: { message?: string | undefined } | undefined;
  result?: AcpResult | undefined;
  params?:
    | {
        options?: AcpPermissionOption[] | undefined;
        sessionId?: string | undefined;
        update?: AcpUpdate | undefined;
      }
    | undefined;
}

/** An in-flight rpc call. `bump` is the idle-timer reset touchHermesAcp fans out. */
interface PendingCall {
  resolve: (value: AcpResult | undefined) => void;
  reject: (err: unknown) => void;
  bump: () => void;
}

export interface RpcOptions {
  idleMs?: number | undefined;
  hardMs?: number | undefined;
  firstIdleMs?: number | undefined;
}

/**
 * `bin` is optional only because the parameter carries a `= {}` default, which
 * the sole caller (server/host-cli.mjs, provider === "hermes") never relies on
 * -- it always passes a resolved hermes path. See the non-null assertion at the
 * spawn site.
 */
export interface HermesAcpSpawnOptions {
  bin?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
}

export interface HermesAcpPromptOptions extends HermesAcpSpawnOptions {
  bot: { id: string };
  text?: string | undefined;
  mcpEnv?: Record<string, unknown> | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  signal?: AbortSignal | undefined;
}


const sessions = new Map<string, string>();
let child: ChildProcessWithoutNullStreams | null = null;
let buf = "";
let nextId = 1;
const pending = new Map<number | string, PendingCall>();
const replies = new Map<string, string>();
let starting: Promise<void> | null = null;
let acpHome = "";
const IDLE_MS = 180_000;
const FIRST_IDLE_MS = 360_000;
const HARD_MS = 20 * 60_000;

function send(msg: AcpEnvelope): void {
  if (!child?.stdin?.writable) throw new Error("Hermes ACP is not running");
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function rpc(method: string, params: Record<string, unknown> = {}, opts: RpcOptions = {}): Promise<AcpResult | undefined> {
  const id = nextId++;
  const idleMs = opts.idleMs ?? 0;
  const hardMs = opts.hardMs ?? 60_000;
  return new Promise<AcpResult | undefined>((resolve, reject) => {
    let done = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let firstWait = true;
    const firstIdleMs = opts.firstIdleMs || idleMs;
    const hardTimer = setTimeout(() => fail(new Error(`Hermes ACP ${method} timed out`)), hardMs);
    const clear = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    };
    const fail = (err: unknown) => {
      if (done) return;
      done = true;
      clear();
      pending.delete(id);
      reject(err);
    };
    const ok = (v: AcpResult | undefined) => {
      if (done) return;
      done = true;
      clear();
      pending.delete(id);
      resolve(v);
    };
    const bump = () => {
      if (!idleMs || done) return;
      const wait = firstWait ? firstIdleMs : idleMs;
      firstWait = false;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error(`Hermes ACP ${method} timed out`)), wait);
    };
    pending.set(id, { resolve: ok, reject: fail, bump });
    try {
      send({ jsonrpc: "2.0", id, method, params });
      bump();
    } catch (err) {
      fail(err);
    }
  });
}

export function touchHermesAcp(): void {
  for (const p of pending.values()) {
    try {
      p.bump?.();
    } catch {
      /* ignore */
    }
  }
}

function handleLine(line: string): void {
  let msg: AcpMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    // p! : guarded by pending.has(msg.id) on the line above, with no await
    // between, so the entry is still there. Map.get cannot prove that.
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method && msg.id != null) {
    if (/permission/i.test(msg.method)) {
      const options = msg.params?.options || [];
      const allow = options.find((o) => /allow/i.test(o.optionId || o.id || "")) || options[0];
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          outcome: { outcome: "selected", optionId: allow?.optionId || allow?.id || "allow-once" },
        },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/update") {
    touchHermesAcp();
    const sid = msg.params?.sessionId;
    const update: AcpUpdate = msg.params?.update || {};
    const kind = update.sessionUpdate || update.session_update || "";
    const text = update.content?.text || update.content?.content || "";
    if (sid && /agent_message/i.test(kind) && text) {
      replies.set(sid, `${replies.get(sid) || ""}${text}`);
    }
  }
}

function attachChild(proc: ChildProcessWithoutNullStreams): void {
  child = proc;
  buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) if (line.trim()) handleLine(line);
  });
  proc.stderr.on("data", () => {});
  proc.on("exit", () => {
    child = null;
    sessions.clear();
    for (const [, p] of pending) p.reject(new Error("Hermes ACP exited"));
    pending.clear();
  });
}

export async function ensureHermesAcp({ bin, env, home }: HermesAcpSpawnOptions = {}): Promise<void> {
  if (child && !child.killed && (!home || acpHome === home)) return;
  if (child && !child.killed && home && acpHome !== home) stopHermesAcp();
  if (starting) return starting;
  starting = (async () => {
    const spawnEnv: NodeJS.ProcessEnv = { ...(env || process.env), HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" };
    if (home) spawnEnv.HERMES_HOME = home;
    // bin! : the `= {}` default makes bin optional in the type, but the only
    // caller always passes a resolved hermes path. Passing undefined here has
    // always been a TypeError; a guard would swap that for a different throw.
    const proc = spawn(bin!, ["acp", "--accept-hooks"], {
      env: spawnEnv,
      cwd: home || os.homedir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    attachChild(proc);
    acpHome = home || "";
    await rpc("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "sub8", version: "0.3.16" },
    });
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

export async function hermesAcpPrompt({ bot, text, mcpEnv, command, args, signal, bin, env, home }: HermesAcpPromptOptions): Promise<string> {
  const t0 = Date.now();
  await ensureHermesAcp({ bin, env, home });
  let sid = sessions.get(bot.id);
  let reused = false;
  if (sid) {
    reused = true;
  } else {
    const envList = Object.entries(mcpEnv || {})
      .filter(([, v]) => v != null && String(v))
      .map(([name, value]) => ({ name, value: String(value) }));
    const cwd = path.join(os.tmpdir(), "sub8-hermes");
    await fs.mkdir(cwd, { recursive: true });
    const created = await rpc("session/new", {
      cwd,
      mcpServers: command
        ? [
            {
              name: "sub8",
              command,
              args: args || [],
              env: envList,
            },
          ]
        : [],
    });
    sid = created?.sessionId || created?.session_id;
    if (!sid) throw new Error("Hermes ACP did not return a session");
    sessions.set(bot.id, sid);
  }
  replies.set(sid, "");
  const promptText = reused
    ? `NEW TASK. Ignore the previous goal completely.\n\n${text}`
    : text;
  console.log(`hermes-acp session ${reused ? "reuse" : "new"} ${Date.now() - t0}ms`);
  const onAbort = () => {
    rpc("session/cancel", { sessionId: sid }, { hardMs: 8_000 }).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);
  try {
    await rpc(
      "session/prompt",
      {
        sessionId: sid,
        prompt: [{ type: "text", text: promptText }],
      },
      { idleMs: IDLE_MS, firstIdleMs: FIRST_IDLE_MS, hardMs: HARD_MS },
    );
  } catch (err) {
    sessions.delete(bot.id);
    const partial = (replies.get(sid) || "").trim();
    if (partial && /timed out/i.test((err as Error).message || "")) return partial;
    const silent = /timed out/i.test((err as Error).message || "");
    if (silent) {
      throw new Error(
        "Hermes went silent for 3 minutes in the middle of the desktop work. Send another message to continue — do not start over.",
      );
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  console.log(`hermes-acp prompt ${Date.now() - t0}ms reused=${reused}`);
  return (replies.get(sid) || "").trim();
}

export function stopHermesAcp(): void {
  try {
    child?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  child = null;
  acpHome = "";
  sessions.clear();
  replies.clear();
  pending.clear();
}
