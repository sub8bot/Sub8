import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./store.js";

import type { TraceBot, TraceRecord } from "./types.js";

export type { TraceBot, TraceRecord } from "./types.js";

const dir = path.join(dataDir, "traces");

function fileFor(botId: string): string {
  return path.join(dir, `${botId}.jsonl`);
}

export async function write(bot: TraceBot | null | undefined, rec: TraceRecord): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ts: Date.now(),
      botId: bot?.id,
      container: bot?.vm?.container || null,
      ...rec,
    });
    await fs.appendFile(fileFor((bot as TraceBot).id), line + "\n");
  } catch {
    /* never break computer-use on logging */
  }
}

export async function span<T>(
  bot: TraceBot,
  tunnel: string,
  op: string,
  detail: unknown,
  fn: () => T | Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    await write(bot, { tunnel, op, detail, ms: Date.now() - t0, ok: true });
    return result;
  } catch (err) {
    await write(bot, { tunnel, op, detail, ms: Date.now() - t0, ok: false, error: (err as Error).message });
    throw err;
  }
}

export async function read(botId: string, limit = 80): Promise<TraceRecord[]> {
  try {
    const raw = await fs.readFile(fileFor(botId), "utf8");
    const lines = raw.trim() ? raw.trim().split("\n") : [];
    return lines.slice(-Math.max(1, Math.min(200, limit))).map((l) => JSON.parse(l) as TraceRecord);
  } catch {
    return [];
  }
}
