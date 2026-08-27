import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverPath = path.join(root, "server", "index.mjs");
const START_MS = 15_000;
const LOG_CAP = 8_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function logBuf() {
  let s = "";
  return {
    push(chunk) {
      s += chunk;
      if (s.length > LOG_CAP) s = s.slice(-LOG_CAP);
    },
    dump() {
      return s.trim() || "(no server output)";
    },
  };
}

export function client(base) {
  return {
    get: (p) => fetch(base + p),
    post: (p, body) =>
      fetch(base + p, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

/** Scenario cannot run (no Docker, no localbot, …). Runner treats this as not a failure. */
export class SkipError extends Error {
  constructor(reason = "skipped") {
    super(String(reason || "skipped"));
    this.name = "SkipError";
  }
}

export function skip(reason) {
  throw new SkipError(reason);
}

async function waitHealthy(base, child, logs) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < START_MS) {
    if (child.exitCode != null || child.signalCode) {
      throw new Error(`server exited ${child.exitCode ?? child.signalCode}\n${logs.dump()}`);
    }
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message || String(err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy in ${START_MS}ms (${last})\n${logs.dump()}`);
}

function stop(child) {
  if (!child || child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 2_000);
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      done();
    }
  });
}

export async function withTempData(fn) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-e2e-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = logBuf();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SUB8BOT_DATA: data },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onChunk = (buf) => logs.push(String(buf));
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", (err) => logs.push(`spawn: ${err.message}\n`));
  try {
    await waitHealthy(base, child, logs);
    // `data` so a test can plant or inspect a fixture on disk. Additive:
    // existing callers destructure only what they use.
    return await fn({ base, client: client(base), data });
  } catch (err) {
    if (!String(err.message || err).includes(logs.dump())) {
      err.message = `${err.message || err}\n${logs.dump()}`;
    }
    throw err;
  } finally {
    await stop(child);
    await fs.rm(data, { recursive: true, force: true });
  }
}
