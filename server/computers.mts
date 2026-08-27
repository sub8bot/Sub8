import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths.mjs";

/**
 * One row of data/computers.json — a desk. Real rows carry more than this over
 * time (the file is written by whatever the running build knows about), so the
 * index signature keeps the type open rather than claiming a closed shape.
 */
export interface Computer {
  id: string;
  name: string;
  container: string;
  volume: string;
  novncPort: number | null;
  status: string;
  lastBotId: string | null;
  pausedByQuit: boolean;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

/** The desk half of a bot record. Callers pass the whole, much wider, bot. */
export interface ComputerBotVm {
  computerId?: string | undefined;
  container?: string | undefined;
  volume?: string | undefined;
  novncPort?: number | null | undefined;
  status?: string | undefined;
  [key: string]: unknown;
}

export interface ComputerBot {
  id: string;
  name?: string | undefined;
  vm?: ComputerBotVm | undefined;
}

export interface NewComputerInput {
  name?: string | undefined;
  container?: string | undefined;
  volume?: string | undefined;
  novncPort?: number | null | undefined;
  lastBotId?: string | null | undefined;
}

export const computersPath = path.join(dataDir, "computers.json");

let writeChain: Promise<void> = Promise.resolve();
function withFile<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readAll(): Promise<Computer[]> {
  try {
    const rows = JSON.parse(await fs.readFile(computersPath, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: Computer[]): Promise<Computer[]> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(computersPath, JSON.stringify(rows, null, 2));
  return rows;
}

export function containerForId(id: string | null | undefined): string {
  return `localbot-${String(id || "bot").slice(0, 8)}`;
}

export function volumeForId(id: string | null | undefined): string {
  return `localbot-config-${String(id || "bot").slice(0, 8)}`;
}

export function newComputer({ name, container, volume, novncPort, lastBotId }: NewComputerInput = {}): Computer {
  const id = randomUUID();
  return {
    id,
    name: name || "Computer",
    container: container || containerForId(id),
    volume: volume || volumeForId(id),
    novncPort: novncPort || null,
    status: "missing",
    lastBotId: lastBotId || null,
    pausedByQuit: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function listComputers(): Promise<Computer[]> {
  return withFile(readAll);
}

export async function getComputer(id: string): Promise<Computer | null> {
  return (await listComputers()).find((c) => c.id === id) || null;
}

export async function saveComputer(partial: Partial<Computer> & { id?: string | undefined }): Promise<Computer> {
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((c) => c.id === partial.id);
    if (i < 0) {
      const row = { ...newComputer(), ...partial, id: partial.id || randomUUID(), updatedAt: Date.now() };
      rows.push(row);
      await writeAll(rows);
      return row;
    }
    // `!`: `i` came from findIndex and is >= 0 here, so rows[i] is present.
    // noUncheckedIndexedAccess cannot see that; a runtime guard would add a
    // branch this code has never had.
    rows[i] = { ...rows[i]!, ...partial, id: rows[i]!.id, updatedAt: Date.now() };
    await writeAll(rows);
    return rows[i]!;
  });
}

export async function removeComputer(id: string): Promise<Computer[] | null> {
  return withFile(async () => {
    const rows = await readAll();
    const next = rows.filter((c) => c.id !== id);
    if (next.length === rows.length) return null;
    await writeAll(next);
    return next;
  });
}

export function computerForBot(computers: Computer[], bot: ComputerBot | null | undefined): Computer | null {
  if (!bot) return null;
  if (bot.vm?.computerId) return computers.find((c) => c.id === bot.vm!.computerId) || null;
  const name = bot.vm?.container;
  if (name) return computers.find((c) => c.container === name) || null;
  return null;
}

export async function migrateFromBots(
  bots: ComputerBot[],
  { containerName, configVolume }: { containerName: (id: string) => string; configVolume: (bot: ComputerBot) => string },
): Promise<{ computers: Computer[]; botsChanged: string[] }> {
  return withFile(async () => {
    const rows = await readAll();
    let changed = false;
    const botsChanged: string[] = [];
    for (const bot of bots) {
      let row = computerForBot(rows, bot);
      if (!row) {
        const container = bot.vm?.container || containerName(bot.id);
        const volume = bot.vm?.volume || configVolume(bot);
        row = newComputer({
          name: `${bot.name || "Bot"}'s desk`,
          container,
          volume,
          novncPort: bot.vm?.novncPort || null,
          lastBotId: bot.id,
        });
        row.status = bot.vm?.status === "running" ? "running" : bot.vm?.status || "missing";
        rows.push(row);
        changed = true;
      }
      if (bot.vm?.computerId !== row.id || bot.vm?.container !== row.container || bot.vm?.volume !== row.volume) {
        bot.vm = {
          ...(bot.vm || {}),
          computerId: row.id,
          container: row.container,
          volume: row.volume,
          novncPort: bot.vm?.novncPort || row.novncPort || null,
        };
        botsChanged.push(bot.id);
      }
      if (row.lastBotId !== bot.id) {
        row.lastBotId = bot.id;
        row.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) await writeAll(rows);
    return { computers: rows, botsChanged };
  });
}

export function keepSets(computers: Computer[]): { keepNames: string[]; keepVolumes: string[] } {
  return {
    keepNames: computers.map((c) => c.container).filter(Boolean),
    keepVolumes: computers.map((c) => c.volume).filter(Boolean),
  };
}

export async function ensureComputerForBot(bot: ComputerBot | null | undefined): Promise<Computer | null> {
  if (!bot) return null;
  const rows = await listComputers();
  let row = computerForBot(rows, bot);
  if (!row) {
    const created = newComputer({
      name: `${bot.name || "Bot"}'s desk`,
      lastBotId: bot.id,
      novncPort: bot.vm?.novncPort || null,
      container: bot.vm?.container || undefined,
      volume: bot.vm?.volume || undefined,
    });
    if (bot.vm?.container) created.container = bot.vm.container;
    if (bot.vm?.volume) created.volume = bot.vm.volume;
    row = await saveComputer(created);
  }
  bot.vm = {
    ...(bot.vm || {}),
    computerId: row.id,
    container: row.container,
    volume: row.volume,
    novncPort: bot.vm?.novncPort || row.novncPort || null,
  };
  return row;
}
