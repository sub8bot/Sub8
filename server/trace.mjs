import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.mjs";

const dir = path.join(dataDir, "traces");

function fileFor(botId) {
  return path.join(dir, `${botId}.jsonl`);
}

export async function write(bot, rec) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ts: Date.now(),
      botId: bot?.id,
      container: bot?.vm?.container || null,
      ...rec,
    });
    await fs.appendFile(fileFor(bot.id), line + "\n");
  } catch {
    /* never break computer-use on logging */
  }
}

export async function span(bot, tunnel, op, detail, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    await write(bot, { tunnel, op, detail, ms: Date.now() - t0, ok: true });
    return result;
  } catch (err) {
    await write(bot, { tunnel, op, detail, ms: Date.now() - t0, ok: false, error: err.message });
    throw err;
  }
}

export async function read(botId, limit = 80) {
  try {
    const raw = await fs.readFile(fileFor(botId), "utf8");
    const lines = raw.trim() ? raw.trim().split("\n") : [];
    return lines.slice(-Math.max(1, Math.min(200, limit))).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
