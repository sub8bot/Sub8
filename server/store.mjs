import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir as defaultDataDir } from "./paths.mjs";
import { AVATAR_COLORS } from "../web/palette.js";

export const dataDir = defaultDataDir;
export const botsPath = path.join(dataDir, "bots.json");
const settingsPath = path.join(dataDir, "settings.json");
export const conversationsDir = path.join(dataDir, "conversations");
export const screensDir = path.join(dataDir, "screens");

export function conversationPath(id) {
  return path.join(conversationsDir, `${id}.json`);
}

export function screenPath(id) {
  return path.join(screensDir, `${id}.png`);
}

export const defaultSettings = {
  version: 1,
  themePreference: "system",
  hardwareAccelerationEnabled: true,
  userTimeZoneOverride: null,
  localExecPermission: "ask",
  autoReviewEnabled: false,
  allowInstructions: [],
  blockInstructions: [],
  autoUpdateWhenIdleOptIn: false,
  updateTrack: "stable",
  sidebarSections: [],
  harness: {
    provider: "grok-build",
    model: "grok-4.6",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    apiKey: "",
    grokBuildCommand: "grok",
  },
};

async function ensure() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(screensDir, { recursive: true });
  await fs.mkdir(conversationsDir, { recursive: true });
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

export async function withFileLock(lockFile, fn) {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      const fh = await fs.open(lockFile, "wx");
      try {
        await fh.write(String(process.pid));
        return await fn();
      } finally {
        await fh.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - t0 > 20_000) throw new Error(`lock timeout ${lockFile}`);
      try {
        const st = await fs.stat(lockFile);
        if (Date.now() - st.mtimeMs > 30_000) await fs.unlink(lockFile);
      } catch {
        /* lock gone */
      }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 25));
    }
  }
}

export async function loadConversation(id) {
  try {
    const rows = JSON.parse(await fs.readFile(conversationPath(id), "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function saveConversation(id, messages) {
  await ensure();
  const prev = await loadConversation(id);
  const merged = unionMessages(messages || [], prev);
  await fs.writeFile(conversationPath(id), JSON.stringify(merged, null, 2));
  return merged;
}

export async function replaceConversation(id, messages) {
  await ensure();
  const rows = (messages || []).filter((m) => m?.id);
  await fs.writeFile(conversationPath(id), JSON.stringify(rows, null, 2));
  return rows;
}

export async function deleteMessages(botId, ids) {
  const drop = new Set((ids || []).filter(Boolean));
  if (!drop.size) return null;
  return withBots(async () => {
    const bots = await loadBotsUnlocked();
    const bot = bots.find((b) => b.id === botId);
    if (!bot) return null;
    const fileMsgs = await loadConversation(botId);
    const before = unionMessages(bot.messages, fileMsgs);
    bot.messages = before.filter((m) => !drop.has(m.id));
    bot.updatedAt = Date.now();
    await replaceConversation(botId, bot.messages);
    await writeJsonAtomic(botsPath, bots);
    return bot;
  });
}

function looksLocalModel(model) {
  const m = String(model || "");
  return /[:/]/.test(m) || /qwen3\.\d|gemma4|\bmlx\b|lmstudio|ollama/i.test(m);
}

function normalizeHarness(h = {}) {
  const allowed = new Set(["grok-build", "hermes", "claude", "codex", "ollama", "lmstudio", "spacexai", "custom"]);
  const provider = allowed.has(h.provider) ? h.provider : "grok-build";
  const localBase = provider === "ollama" ? "http://127.0.0.1:11434/v1" : provider === "lmstudio" ? "http://127.0.0.1:1234/v1" : "";
  let model = typeof h.model === "string" ? h.model : "";
  let baseUrl = typeof h.baseUrl === "string" ? h.baseUrl : "";
  if (provider === "ollama" || provider === "lmstudio") {
    baseUrl = localBase;
  } else if (provider === "custom") {
    baseUrl = baseUrl || "https://api.x.ai/v1";
  } else {
    if (!baseUrl || /127\.0\.0\.1:(11434|1234)/.test(baseUrl)) baseUrl = "https://api.x.ai/v1";
    if (provider === "claude" || provider === "codex" || provider === "hermes") {
      /* empty model means the CLI default */
    } else if (!model || looksLocalModel(model)) {
      model = "grok-4.6";
    }
  }
  return {
    ...defaultSettings.harness,
    ...h,
    provider,
    model,
    baseUrl,
    apiKeyEnv: h.apiKeyEnv || "XAI_API_KEY",
    grokBuildCommand: h.grokBuildCommand || "grok",
  };
}

export async function loadSettings() {
  await ensure();
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const next = {
      ...defaultSettings,
      ...raw,
      harness: normalizeHarness(raw.harness),
    };
    if (JSON.stringify(raw.harness || {}) !== JSON.stringify(next.harness)) {
      await fs.writeFile(settingsPath, JSON.stringify(next, null, 2));
    }
    return next;
  } catch {
    const fresh = { ...defaultSettings, harness: { ...defaultSettings.harness } };
    await fs.writeFile(settingsPath, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

export async function saveSettings(next) {
  await ensure();
  const merged = {
    ...defaultSettings,
    ...next,
    harness: normalizeHarness(next.harness),
  };
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2));
  return merged;
}

let writeChain = Promise.resolve();
function withBots(fn) {
  const run = writeChain.then(
    () => withFileLock(`${botsPath}.lock`, fn),
    () => withFileLock(`${botsPath}.lock`, fn),
  );
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readBotsFile() {
  try {
    const raw = await fs.readFile(botsPath, "utf8");
    const bots = JSON.parse(raw);
    if (!Array.isArray(bots)) throw new Error("bots.json is not an array");
    return bots;
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function loadBotsUnlocked() {
  await ensure();
  const bots = await readBotsFile();
  let migratedHarness = false;
  for (const b of bots) {
    if (!Array.isArray(b.routines)) b.routines = [];
    if (!Array.isArray(b.messages)) b.messages = [];
    if (!b.grokSessionId) b.grokSessionId = b.id;
    if (!b.harness || typeof b.harness !== "object" || !b.harness.provider) {
      b.harness = { provider: "grok-build", model: "grok-4.6" };
      migratedHarness = true;
    }
    const fileMsgs = await loadConversation(b.id);
    if (fileMsgs.length) b.messages = unionMessages(b.messages, fileMsgs);
    else if (b.messages.length) await saveConversation(b.id, b.messages);
    if (!b.avatar || typeof b.avatar !== "object") {
      b.avatar = { expression: "neutral", animation: "idle", body: "rounder" };
    } else {
      const ok = ["mantle","tall","chubby","slim","soft","rounder","short","long","curl","plush"];
      const body = b.avatar.body === "mantle" || !ok.includes(b.avatar.body) ? "rounder" : b.avatar.body;
      b.avatar = {
        expression: b.avatar.expression || "neutral",
        animation: b.avatar.animation || "idle",
        body,
      };
    }
  }
  if (migratedHarness) {
    const disk = await readBotsFile();
    for (const row of disk) {
      if (!row.harness || typeof row.harness !== "object" || !row.harness.provider) {
        row.harness = { provider: "grok-build", model: "grok-4.6" };
      }
    }
    await writeJsonAtomic(botsPath, disk);
  }
  return bots;
}

export async function loadBots() {
  return withBots(() => loadBotsUnlocked());
}

export async function saveBots(bots) {
  return withBots(async () => {
    await ensure();
    await writeJsonAtomic(botsPath, bots);
    return bots;
  });
}

const PALETTE = AVATAR_COLORS;

export function newBot(partial = {}) {
  const id = randomUUID();
  return {
    id,
    name: partial.name || "New Bot",
    title: partial.title || "",
    description: partial.description || "",
    instructions: partial.instructions || "",
    color: partial.color || PALETTE[Math.floor(Math.random() * PALETTE.length)],
    icon: partial.icon || "hex",
    avatar: {
      expression: partial.avatar?.expression || "neutral",
      animation: partial.avatar?.animation || "idle",
      body: partial.avatar?.body || "rounder",
    },
    notificationsEnabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    vm: {
      status: "idle",
      container: null,
      novncPort: null,
      display: ":1",
      error: null,
    },
    messages: [],
    routines: [],
    grokSessionId: id,
    harness: partial.harness && typeof partial.harness === "object" ? partial.harness : { provider: "default" },
    pinned: Boolean(partial.pinned),
    section: partial.section || "",
    unread: Boolean(partial.unread),
    hidden: Boolean(partial.hidden),
    teamId: partial.teamId || "",
    teamRole: partial.teamRole === "chief" || partial.teamRole === "worker" ? partial.teamRole : "",
  };
}

function unionMessages(incoming = [], existing = []) {
  const byId = new Map();
  for (const m of existing) if (m?.id) byId.set(m.id, m);
  for (const m of incoming) if (m?.id) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function preserveRoutineRunMarker(incoming, previous) {
  const incomingDaily = incoming?.schedule?.type === "daily";
  const previousDaily = previous?.schedule?.type === "daily";
  const sameSchedule =
    incomingDaily &&
    previousDaily &&
    incoming.schedule.hour === previous.schedule.hour &&
    incoming.schedule.minute === previous.schedule.minute;
  const sameTimeZone = incoming.nextRunTimeZone === previous.nextRunTimeZone;
  const previousLast = Number(previous.lastRunAt);
  const incomingLast = Number(incoming.lastRunAt || 0);
  if (Number.isFinite(previousLast) && previousLast > incomingLast) incoming.lastRunAt = previousLast;
  const runs = new Map();
  for (const run of [...(previous.runs || []), ...(incoming.runs || [])]) {
    if (Number.isFinite(Number(run?.ts))) runs.set(Number(run.ts), run);
  }
  if (runs.size) incoming.runs = [...runs.values()].sort((a, b) => a.ts - b.ts).slice(-24);
  if (sameSchedule && sameTimeZone) {
    const previousNext = Number(previous.nextRunAt);
    const incomingNext = Number(incoming.nextRunAt);
    const markerHorizon = Date.now() + 2 * 86400_000;
    if (
      Number.isFinite(previousNext) &&
      previousNext <= markerHorizon &&
      (!Number.isFinite(incomingNext) || previousNext > incomingNext)
    ) {
      incoming.nextRunAt = previousNext;
    }
    return;
  }
}

export async function upsertBot(bot) {
  return withBots(async () => {
    const bots = await loadBotsUnlocked();
    const i = bots.findIndex((b) => b.id === bot.id);
    if (i >= 0) {
      const prev = bots[i];
      const fileMsgs = await loadConversation(bot.id);
      bot.messages = unionMessages(unionMessages(bot.messages, prev.messages), fileMsgs);
      // A long turn snapshots the bot at start; don't let it wipe a newer edit.
      if ((prev.updatedAt || 0) > (bot.updatedAt || 0)) {
        for (const key of [
          "avatar",
          "color",
          "name",
          "title",
          "description",
          "instructions",
          "notificationsEnabled",
          "pinned",
          "section",
          "unread",
          "hidden",
          "harness",
          "teamId",
          "teamRole",
        ]) {
          if (prev[key] !== undefined) bot[key] = prev[key];
        }
      } else if (!bot.avatar && prev.avatar) {
        bot.avatar = prev.avatar;
      }
      // Incoming list is authoritative for which routines exist (so Delete sticks).
      // Same-id rows keep the newer updatedAt so a stale turn cannot wipe an edit.
      const incoming = Array.isArray(bot.routines) ? bot.routines : [];
      const existing = new Map((prev.routines || []).map((r) => [r.id, r]));
      bot.routines = incoming.map((r) => {
        const was = existing.get(r.id);
        if (was && (was.updatedAt || 0) > (r.updatedAt || 0)) return was;
        if (was) preserveRoutineRunMarker(r, was);
        return r;
      });
      bots[i] = bot;
    } else bots.push(bot);
    bot.updatedAt = Date.now();
    bot.messages = await saveConversation(bot.id, bot.messages);
    await writeJsonAtomic(botsPath, bots);
    return bot;
  });
}

/** Mutate one bot on disk under the write lock (avoids clobbering in-flight turns). */
export async function patchBot(id, fn) {
  return withBots(async () => {
    const bots = await loadBotsUnlocked();
    const i = bots.findIndex((b) => b.id === id);
    if (i < 0) return null;
    await fn(bots[i]);
    bots[i].updatedAt = Date.now();
    await saveConversation(bots[i].id, bots[i].messages);
    await writeJsonAtomic(botsPath, bots);
    return bots[i];
  });
}

export async function getBot(id) {
  return (await loadBots()).find((b) => b.id === id) || null;
}

export async function deleteBot(id) {
  return withBots(async () => {
    const bots = await loadBotsUnlocked();
    const next = bots.filter((b) => b.id !== id);
    if (next.length === bots.length) return null;
    await writeJsonAtomic(botsPath, next);
    try {
      await fs.unlink(conversationPath(id));
    } catch {
      /* no conversation file yet */
    }
    try {
      await fs.unlink(screenPath(id));
    } catch {
      /* no screenshot yet */
    }
    return next;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listConversationIds() {
  await ensure();
  try {
    const names = await fs.readdir(conversationsDir);
    return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
}

/** Re-create bot rows that vanished from a raced bots.json write. Does not start computers. */
export async function recoverMissingBots(hints = []) {
  const added = [];
  for (const h of hints) {
    if (!h?.id || !UUID_RE.test(h.id)) continue;
    const existing = await getBot(h.id);
    if (existing) continue;
    const bot = newBot({
      name: h.name || "Bot",
      title: h.title || "",
      description: h.description || "",
      instructions: h.instructions || h.description || "",
      harness: h.harness && typeof h.harness === "object" ? h.harness : { provider: "claude", model: "default" },
      color: h.color,
    });
    bot.id = h.id;
    bot.grokSessionId = h.id;
    bot.teamId = h.teamId || "";
    bot.teamRole = h.teamRole === "chief" || h.teamRole === "worker" ? h.teamRole : "";
    if (h.vm && typeof h.vm === "object") bot.vm = { ...bot.vm, ...h.vm };
    if (Array.isArray(h.routines) && h.routines.length) bot.routines = h.routines;
    await upsertBot(bot);
    added.push(bot);
  }
  return added;
}
