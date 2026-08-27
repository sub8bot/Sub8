/**
 * Host-side desk-harness supervisor for This Mac.
 * Used when the container :3011 mapping is not serving yet. Same NDJSON contract.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessHealthy } from "../desk-client.mjs";

/** What a supervised harness looks like to callers. */
export interface LocalHarness {
  ok: boolean;
  url: string;
  port: number;
  started: boolean;
}

/** The bot fields the cache key is built from. Callers pass the whole bot. */
export interface LocalHarnessBot {
  id?: string | undefined;
  vm?: { computerId?: string | undefined; container?: string | undefined } | undefined;
}

export interface EnsureLocalHarnessOptions {
  port?: number | string | undefined;
  token?: string | undefined;
  bot?: LocalHarnessBot | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "server.mjs");
const children = new Map<number, ChildProcess>();
const byKey = new Map<string, LocalHarness>();

export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      // `as AddressInfo`: inside the listen callback a TCP server always has a
      // bound address, and Server#address() only widens to `string | null` for
      // pipe servers and closed ones. Nothing runs at the call site either way.
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export async function ensureLocalHarness({ port, token, bot, env = process.env }: EnsureLocalHarnessOptions = {}): Promise<LocalHarness> {
  const key = bot?.vm?.computerId || bot?.vm?.container || bot?.id || String(port || "default");
  const cached = byKey.get(key);
  if (cached?.url && (await harnessHealthy(cached.url, { timeoutMs: 600 }))) return { ...cached, started: false };
  const want = Number(port) || cached?.port || (await freePort());
  const url = `http://127.0.0.1:${want}`;
  if (await harnessHealthy(url, { timeoutMs: 800 })) {
    const hit = { ok: true, url, port: want, started: false };
    byKey.set(key, hit);
    return hit;
  }
  const prev = children.get(want);
  if (prev && prev.exitCode == null) {
    await waitHealthy(url, 8000);
    return { ok: true, url, port: want, started: true };
  }
  const child = spawn(process.execPath, [serverJs], {
    env: {
      ...env,
      DESK_HARNESS: "1",
      DESK_HARNESS_PORT: String(want),
      DESK_TOKEN: String(token || env.DESK_TOKEN || ""),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(want, child);
  child.on("exit", () => {
    if (children.get(want) === child) children.delete(want);
  });
  await waitHealthy(url, 8000);
  const started = { ok: true, url, port: want, started: true };
  byKey.set(key, started);
  return started;
}

export function stopLocalHarness(port: number | string): void {
  const child = children.get(Number(port));
  if (!child) return;
  child.kill("SIGTERM");
  children.delete(Number(port));
}

function waitHealthy(url: string, ms: number): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = async () => {
      if (await harnessHealthy(url, { timeoutMs: 400 })) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`desk-harness did not become healthy on ${url}`));
      setTimeout(tick, 150);
    };
    tick();
  });
}
