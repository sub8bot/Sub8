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

function normalizeHarness(h = {}) {
  const provider = h.provider === "custom" || h.provider === "spacexai" ? h.provider : "grok-build";
  return {
    ...defaultSettings.harness,
    ...h,
    provider,
    model: h.model || "grok-4.6",
    baseUrl: provider === "custom" ? h.baseUrl || "https://api.x.ai/v1" : "https://api.x.ai/v1",
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
    if (raw.harness?.provider && raw.harness.provider !== next.harness.provider) {
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
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function loadBotsUnlocked() {
  await ensure();
  try {
    const bots = JSON.parse(await fs.readFile(botsPath, "utf8"));
    for (const b of bots) {
      if (!Array.isArray(b.routines)) b.routines = [];
      if (!Array.isArray(b.messages)) b.messages = [];
      if (!b.grokSessionId) b.grokSessionId = b.id;
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
    return bots;
  } catch {
    return [];
  }
}

export async function loadBots() {
  return withBots(() => loadBotsUnlocked());
}

export async function saveBots(bots) {
  return withBots(async () => {
    await ensure();
    await fs.writeFile(botsPath, JSON.stringify(bots, null, 2));
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
    color: partial.color || PALETTE[0],
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
    pinned: Boolean(partial.pinned),
    section: partial.section || "",
    unread: Boolean(partial.unread),
    hidden: Boolean(partial.hidden),
  };
}

function unionMessages(incoming = [], existing = []) {
  const byId = new Map();
  for (const m of existing) if (m?.id) byId.set(m.id, m);
  for (const m of incoming) if (m?.id) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
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
        ]) {
          if (prev[key] !== undefined) bot[key] = prev[key];
        }
      } else if (!bot.avatar && prev.avatar) {
        bot.avatar = prev.avatar;
      }
      // Keep the newer routine text if a worker still holds an old snapshot.
      const incoming = Array.isArray(bot.routines) ? bot.routines : [];
      const existing = Array.isArray(prev.routines) ? prev.routines : [];
      const byId = new Map(incoming.map((r) => [r.id, r]));
      for (const r of existing) {
        const cur = byId.get(r.id);
        if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(r.id, r);
      }
      bot.routines = [...byId.values()];
      bots[i] = bot;
    } else bots.push(bot);
    bot.updatedAt = Date.now();
    bot.messages = await saveConversation(bot.id, bot.messages);
    await fs.writeFile(botsPath, JSON.stringify(bots, null, 2));
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
    await fs.writeFile(botsPath, JSON.stringify(bots, null, 2));
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
    await fs.writeFile(botsPath, JSON.stringify(next, null, 2));
    try {
      await fs.unlink(conversationPath(id));
    } catch {
      /* no conversation file yet */
    }
    return next;
  });
}
