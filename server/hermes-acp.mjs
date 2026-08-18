import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sessions = new Map();
let child = null;
let buf = "";
let nextId = 1;
const pending = new Map();
const replies = new Map();
let starting = null;
const IDLE_MS = 180_000;
const HARD_MS = 20 * 60_000;

function send(msg) {
  if (!child?.stdin?.writable) throw new Error("Hermes ACP is not running");
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function rpc(method, params = {}, opts = {}) {
  const id = nextId++;
  const idleMs = opts.idleMs ?? 0;
  const hardMs = opts.hardMs ?? 60_000;
  return new Promise((resolve, reject) => {
    let done = false;
    let idleTimer = null;
    const hardTimer = setTimeout(() => fail(new Error(`Hermes ACP ${method} timed out`)), hardMs);
    const clear = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      clear();
      pending.delete(id);
      reject(err);
    };
    const ok = (v) => {
      if (done) return;
      done = true;
      clear();
      pending.delete(id);
      resolve(v);
    };
    const bump = () => {
      if (!idleMs || done) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error(`Hermes ACP ${method} timed out`)), idleMs);
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

export function touchHermesAcp() {
  for (const p of pending.values()) {
    try {
      p.bump?.();
    } catch {
      /* ignore */
    }
  }
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id);
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
    const update = msg.params?.update || {};
    const kind = update.sessionUpdate || update.session_update || "";
    const text = update.content?.text || update.content?.content || "";
    if (sid && /agent_message/i.test(kind) && text) {
      replies.set(sid, `${replies.get(sid) || ""}${text}`);
    }
  }
}

function attachChild(proc) {
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

export async function ensureHermesAcp({ bin, env } = {}) {
  if (child && !child.killed) return;
  if (starting) return starting;
  starting = (async () => {
    const spawnEnv = { ...(env || process.env), HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" };
    const proc = spawn(bin, ["acp", "--accept-hooks"], {
      env: spawnEnv,
      cwd: os.homedir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    attachChild(proc);
    await rpc("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "sub8", version: "0.3.14" },
    });
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

export async function hermesAcpPrompt({ bot, text, mcpEnv, command, args, signal, bin, env }) {
  await ensureHermesAcp({ bin, env });
  const prev = sessions.get(bot.id);
  if (prev) {
    rpc("session/cancel", { sessionId: prev }, { hardMs: 8_000 }).catch(() => {});
    sessions.delete(bot.id);
    replies.delete(prev);
  }
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
  const sid = created?.sessionId || created?.session_id;
  if (!sid) throw new Error("Hermes ACP did not return a session");
  sessions.set(bot.id, sid);
  replies.set(sid, "");
  const onAbort = () => {
    rpc("session/cancel", { sessionId: sid }, { hardMs: 8_000 }).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);
  try {
    await rpc(
      "session/prompt",
      {
        sessionId: sid,
        prompt: [{ type: "text", text }],
      },
      { idleMs: IDLE_MS, hardMs: HARD_MS },
    );
  } catch (err) {
    const partial = (replies.get(sid) || "").trim();
    if (partial && /timed out/i.test(err.message || "")) return partial;
    const silent = /timed out/i.test(err.message || "");
    if (silent) {
      throw new Error(
        "Hermes went silent for 3 minutes in the middle of the desktop work. Send another message to continue — do not start over.",
      );
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return (replies.get(sid) || "").trim();
}

export function stopHermesAcp() {
  try {
    child?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  child = null;
  sessions.clear();
}
