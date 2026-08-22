import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths.mjs";

export const computersPath = path.join(dataDir, "computers.json");
export const DEFAULT_COMPUTER_BACKEND = "local-docker";

let writeChain = Promise.resolve();
function withFile(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readAll() {
  try {
    const rows = JSON.parse(await fs.readFile(computersPath, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeAll(rows) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(computersPath, JSON.stringify(rows, null, 2));
  return rows;
}

export function containerForId(id) {
  return `localbot-${String(id || "bot").slice(0, 8)}`;
}

export function volumeForId(id) {
  return `localbot-config-${String(id || "bot").slice(0, 8)}`;
}

export function computerBackendName(computer) {
  return computer?.backend === undefined ? DEFAULT_COMPUTER_BACKEND : computer.backend;
}

export function newComputer({ name, container, volume, novncPort, lastBotId, backend = DEFAULT_COMPUTER_BACKEND } = {}) {
  const id = randomUUID();
  return {
    id,
    backend,
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

export async function listComputers() {
  return withFile(readAll);
}

export async function getComputer(id) {
  return (await listComputers()).find((c) => c.id === id) || null;
}

export async function saveComputer(partial) {
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((c) => c.id === partial.id);
    if (i < 0) {
      const row = { ...newComputer(), ...partial, id: partial.id || randomUUID(), updatedAt: Date.now() };
      rows.push(row);
      await writeAll(rows);
      return row;
    }
    rows[i] = { ...rows[i], ...partial, id: rows[i].id, updatedAt: Date.now() };
    await writeAll(rows);
    return rows[i];
  });
}

export async function removeComputer(id) {
  return withFile(async () => {
    const rows = await readAll();
    const next = rows.filter((c) => c.id !== id);
    if (next.length === rows.length) return null;
    await writeAll(next);
    return next;
  });
}

export function computerForBot(computers, bot) {
  if (!bot) return null;
  if (bot.vm?.computerId) return computers.find((c) => c.id === bot.vm.computerId) || null;
  const name = bot.vm?.container;
  if (name) return computers.find((c) => c.container === name) || null;
  return null;
}

export async function migrateFromBots(bots, { containerName, configVolume }) {
  return withFile(async () => {
    const rows = await readAll();
    let changed = false;
    const botsChanged = [];
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

export function keepSets(computers) {
  const local = computers.filter((computer) => computerBackendName(computer) === DEFAULT_COMPUTER_BACKEND);
  return {
    keepNames: local.map((c) => c.container).filter(Boolean),
    keepVolumes: local.map((c) => c.volume).filter(Boolean),
  };
}

export async function ensureComputerForBot(bot) {
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
