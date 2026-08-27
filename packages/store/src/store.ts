import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AVATAR_COLORS } from "@sub8/constants";
import { dropWakes } from "@sub8/wakes";

import type {
  Bot,
  BotHint,
  BotSeed,
  HarnessInput,
  HarnessSettings,
  Message,
  RoutineRun,
  Settings,
  StoredRoutine,
} from "./types.js";

/**
 * The user's data root. `server/paths.mjs` re-exports this rather than defining
 * it: everything under `data/` is written by this package, and the tests bind
 * it by setting `SUB8BOT_DATA` before the first import.
 */
export const dataDir = process.env.SUB8BOT_DATA || process.env.OCTOBOT_DATA || path.join(process.cwd(), "data");
/** Host index (id, vm, team, harness, messages). Desk `profile.json` is canonical identity. */
export const botsPath = path.join(dataDir, "bots.json");
const settingsPath = path.join(dataDir, "settings.json");
export const conversationsDir = path.join(dataDir, "conversations");
export const screensDir = path.join(dataDir, "screens");

export function conversationPath(id: string): string {
  return path.join(conversationsDir, `${id}.json`);
}

export function screenPath(id: string): string {
  return path.join(screensDir, `${id}.png`);
}

export const defaultSettings: Settings = {
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

async function ensure(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(screensDir, { recursive: true });
  await fs.mkdir(conversationsDir, { recursive: true });
}

/** Bumped per call so two writes in the same millisecond cannot share a temp path. */
let atomicSeq = 0;

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // pid + Date.now() alone COLLIDES: two writes to the same file in one
  // millisecond from one process built the same temp path, the first rename
  // consumed it, and the rest threw ENOENT. Callers serialised by withBots were
  // safe, but the conversation and team-chat writers are not -- so two bots on
  // one team appending in the same tick lost writes, and in message_teammate the
  // throw happened BEFORE the dispatch, dropping the message entirely.
  const uniq = `${process.pid}.${Date.now()}.${(atomicSeq = (atomicSeq + 1) % 1e6)}`;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${uniq}.tmp`);
  // 0600, not the 0644 an unmasked create gives: these files carry the Cloud
  // session token, the provider API key and every conversation, and the dev
  // dataDir is `cwd()/data` under a 0755 tree that every local account can
  // read. The mode goes on the temp file because rename keeps the source's.
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await matchDirOwner(file);
}

/**
 * On a desk the data dir is chowned to the unprivileged user mcp-sub8 runs as,
 * while THIS process is root — so a root-owned 0600 file there is unreadable
 * to the tools, which is the "permission denied ... lock files" EACCES the
 * harness already documents. Root writes are the only ones that can land with
 * the wrong owner, so this is a no-op everywhere else, including macOS.
 */
async function matchDirOwner(file: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  try {
    const dir = await fs.stat(path.dirname(file));
    if (dir.uid === 0 && dir.gid === 0) return;
    await fs.chown(file, dir.uid, dir.gid);
  } catch {
    /* best effort: the file is still correct for the user that wrote it */
  }
}

/**
 * LOCK_STALE_MS must stay BELOW LOCK_WAIT_MS, or a waiter can never break an
 * orphaned lock: it was 30s stale against a 20s wait, so anyone arriving while
 * the orphan was younger than 10s threw "lock timeout" first and the lock
 * survived to block the next caller too.
 *
 * Locks are orphaned by any writer killed inside withBots -- the finally that
 * unlinks never runs. That happens routinely: electron/main.mts kills the
 * server process on quit and server/index.mts installs no signal handler, and
 * probeMcpTools SIGKILLs a real mcp-sub8 (which touches the store) after every
 * handshake.
 *
 * A legitimate hold is one read-modify-write, milliseconds even on a large
 * bots.json, so 10s is a generous ceiling. Breaking a lock costs at worst a
 * lost update -- writeJsonAtomic renames into place, so a reader never sees a
 * half-written file.
 */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 30_000;

export async function withFileLock<T>(lockFile: string, fn: () => T | Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      const fh = await fs.open(lockFile, "wx");
      // A token, not just the pid: the release below has to prove it still
      // owns the lock, and a pid is not unique across a break-and-reacquire.
      const token = `${process.pid}.${randomUUID()}`;
      try {
        await fh.write(token);
        return await fn();
      } finally {
        await fh.close().catch(() => {});
        // Unlink ONLY what we still hold. A hold that outruns LOCK_STALE_MS is
        // broken by a waiter, which then creates its own lock file -- and this
        // finally used to delete THAT one, so the critical section stood open
        // for every later arrival, not just the one that broke in. Reachable
        // without a dead process: deleteBot holds bots.json.lock while awaiting
        // one channels.json.lock per channel (bounded by LOCK_WAIT_MS = 30s,
        // three times the stale threshold), and a laptop sleeping mid-hold does
        // it too, since mtime is stamped once at acquire and never refreshed.
        try {
          if ((await fs.readFile(lockFile, "utf8")) === token) await fs.unlink(lockFile);
        } catch {
          /* already broken and gone, or unreadable -- either way not ours */
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`lock timeout ${lockFile}`);
      try {
        const st = await fs.stat(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.unlink(lockFile);
      } catch {
        /* lock gone */
      }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 25));
    }
  }
}

/**
 * `ok:false` means the file exists but could not be read or parsed. That is
 * NOT the same as "no messages", and conflating the two erased transcripts:
 * loadConversation answered [], saveConversation merged against that phantom
 * empty, and writeJsonAtomic renamed a 2-byte file over the real one. Reads
 * fail for real reasons -- EACCES when the desk's root-written file meets the
 * unprivileged mcp-sub8, or a transcript past V8's string cap.
 */
async function readConversationFile(id: string): Promise<{ ok: boolean; rows: Message[] }> {
  try {
    const rows: unknown = JSON.parse(await fs.readFile(conversationPath(id), "utf8"));
    return { ok: true, rows: Array.isArray(rows) ? (rows as Message[]) : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, rows: [] };
    console.error(`[store] conversation ${id} unreadable:`, (err as Error)?.message || err);
    return { ok: false, rows: [] };
  }
}

export async function loadConversation(id: string): Promise<Message[]> {
  return (await readConversationFile(id)).rows;
}

/** One writer at a time per transcript. */
function conversationLock(id: string): string {
  return `${conversationPath(id)}.lock`;
}

/**
 * bots.json is the INDEX; conversations/<id>.json owns the transcript.
 *
 * Every message used to be written to BOTH, so bots.json grew without bound --
 * 7.7 MB for six bots, one row alone 6.3 MB across 16,519 messages, duplicated
 * byte for byte in conversations/. Worse, every store operation re-read,
 * re-parsed and rewrote the whole file inside the global mutex, so a single
 * appended message cost ~70 ms of CPU and IO, rising linearly forever.
 *
 * Only the copy that LANDS in bots.json is emptied -- callers keep their
 * in-memory `messages`. loadBotsUnlocked already prefers the conversation file
 * and falls back to the row, so an older bots.json that still carries messages
 * keeps working and is migrated the first time it is rewritten.
 *
 * Every caller of this must have written the conversation file first, or the
 * transcript is what gets dropped.
 */
function indexRows(bots: readonly Bot[]): Bot[] {
  return bots.map((b) => (b?.messages?.length ? { ...b, messages: [] } : b));
}

export async function saveConversation(id: string, messages?: readonly Message[] | null): Promise<Message[]> {
  await ensure();
  return withFileLock(conversationLock(id), async () => {
    const prev = await readConversationFile(id);
    // Refuse to write over a transcript we could not read. Merging against a
    // phantom [] is how one unreadable read turned 400 messages into 0.
    if (!prev.ok) throw new Error(`refusing to overwrite unreadable conversation ${id}`);
    const merged = unionMessages(messages || [], prev.rows);
    await writeJsonAtomic(conversationPath(id), merged);
    return merged;
  });
}

/**
 * Append under ONE lock. Callers used to read, push and replace with nothing
 * serialising them, so two team messages in flight -- the normal case, since a
 * chief and its workers take turns concurrently -- lost one outright, and
 * across processes lost far more.
 */
export async function appendConversation(id: string, rows: readonly Message[]): Promise<Message[]> {
  await ensure();
  return withFileLock(conversationLock(id), async () => {
    const prev = await readConversationFile(id);
    if (!prev.ok) throw new Error(`refusing to append to unreadable conversation ${id}`);
    const next = [...prev.rows, ...rows.filter((m) => m?.id)];
    await writeJsonAtomic(conversationPath(id), next);
    return next;
  });
}

/** Deliberate truncation (deleteMessages). Locked, but does NOT merge. */
export async function replaceConversation(id: string, messages?: readonly Message[] | null): Promise<Message[]> {
  await ensure();
  const rows = (messages || []).filter((m) => m?.id);
  return withFileLock(conversationLock(id), async () => {
    await writeJsonAtomic(conversationPath(id), rows);
    return rows;
  });
}

export async function deleteMessages(botId: string, ids?: readonly unknown[] | null): Promise<Bot | null> {
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
    await writeJsonAtomic(botsPath, indexRows(bots));
    return bot;
  });
}

function looksLocalModel(model: unknown): boolean {
  const m = String(model || "");
  return /[:/]/.test(m) || /qwen3\.\d|gemma4|\bmlx\b|lmstudio|ollama/i.test(m);
}

function normalizeHarness(h: HarnessInput = {}): HarnessSettings {
  const allowed = new Set<unknown>([
    "grok-build",
    "hermes",
    "claude",
    "codex",
    "ollama",
    "lmstudio",
    "spacexai",
    "openrouter",
    "openai",
    "custom",
  ]);
  const provider = (allowed.has(h.provider) ? h.provider : "grok-build") as string;
  const localBase = provider === "ollama" ? "http://127.0.0.1:11434/v1" : provider === "lmstudio" ? "http://127.0.0.1:1234/v1" : "";
  const apiDefault =
    provider === "openrouter"
      ? { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" }
      : provider === "openai"
        ? { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" }
        : { baseUrl: "https://api.x.ai/v1", model: "grok-4.6" };
  let model = typeof h.model === "string" ? h.model : "";
  let baseUrl = typeof h.baseUrl === "string" ? h.baseUrl : "";
  if (provider === "ollama" || provider === "lmstudio") {
    baseUrl = localBase;
  } else if (provider === "custom" || provider === "openrouter" || provider === "openai") {
    baseUrl = baseUrl || apiDefault.baseUrl;
    if (!model) model = apiDefault.model;
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
    apiKeyEnv: h.apiKeyEnv || (provider === "spacexai" ? "XAI_API_KEY" : ""),
    grokBuildCommand: h.grokBuildCommand || "grok",
    setupComplete: Boolean(h.setupComplete),
    setupSkipped: Boolean(h.setupSkipped),
  };
}

export async function loadSettings(): Promise<Settings> {
  await ensure();
  let raw: Partial<Settings>;
  try {
    raw = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Partial<Settings>;
  } catch (err) {
    // ENOENT is the ONLY error that means "no settings yet". The catch used to
    // be bare, so a SyntaxError from a truncated file was answered by writing
    // defaults back -- destroying the stored provider API key. settings.json is
    // also the one file that skipped writeJsonAtomic, so a crash inside
    // fs.writeFile (O_TRUNC: zero bytes before the first byte lands) produced
    // exactly that truncated file. Same guard readBotsFile has always had.
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
    const fresh: Settings = { ...defaultSettings, harness: { ...defaultSettings.harness } };
    await writeJsonAtomic(settingsPath, fresh);
    return fresh;
  }
  const next: Settings = {
    ...defaultSettings,
    ...raw,
    harness: normalizeHarness(raw.harness),
  };
  if (JSON.stringify(raw.harness || {}) !== JSON.stringify(next.harness)) {
    await writeJsonAtomic(settingsPath, next);
  }
  return next;
}

export async function saveSettings(next: Partial<Settings>): Promise<Settings> {
  await ensure();
  const merged: Settings = {
    ...defaultSettings,
    ...next,
    harness: normalizeHarness(next.harness),
  };
  await writeJsonAtomic(settingsPath, merged);
  return merged;
}

let writeChain: Promise<void> = Promise.resolve();
function withBots<T>(fn: () => T | Promise<T>): Promise<T> {
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

async function readBotsFile(): Promise<Bot[]> {
  try {
    const raw = await fs.readFile(botsPath, "utf8");
    const bots: unknown = JSON.parse(raw);
    if (!Array.isArray(bots)) throw new Error("bots.json is not an array");
    return bots as Bot[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * `only` limits the transcript reads to ONE bot. Every other row comes back
 * index-only (empty `messages`), which is exactly what getBot needs and is
 * what the whole-file parse used to cost it: 22 ms per call against a 7 MB
 * transcript, on every route that touches a bot and on the 5s and 15s timers.
 * The per-bot repair below still runs for every bot on a full load.
 */
async function loadBotsUnlocked(only?: string): Promise<Bot[]> {
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
    if (only && b.id !== only) {
      b.messages = [];
      continue;
    }
    const fileMsgs = await loadConversation(b.id);
    // Flush whenever the ROW carries anything the conversation file lacks, not
    // only when the file is empty.
    //
    // indexRows now strips messages from every row on any write, so the row
    // copy is no longer a durable second copy — it is a leftover from before
    // the split. The old `else if` rescued a row only when the file was
    // completely empty, so a file merely BEHIND the row (a restore, a backup,
    // an interrupted write) lost the difference the first time any other bot
    // was written: the union was computed, used in memory, and thrown away.
    // Verified as a regression against the pre-split behaviour, where
    // loadBotsUnlocked's union was written back to bots.json.
    //
    // saveConversation unions, so this is idempotent and stops firing as soon
    // as the file has caught up.
    const merged = unionMessages(b.messages, fileMsgs);
    if (b.messages.length && merged.length > fileMsgs.length) await saveConversation(b.id, merged);
    b.messages = merged;
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
    await writeJsonAtomic(botsPath, indexRows(disk));
  }
  return bots;
}

export async function loadBots(): Promise<Bot[]> {
  return withBots(() => loadBotsUnlocked());
}

export async function saveBots(bots: Bot[]): Promise<Bot[]> {
  return withBots(async () => {
    await ensure();
    // Unlike the other writers these rows come from the caller, not from
    // loadBotsUnlocked, so their transcripts are flushed here before the index
    // drops them.
    for (const b of bots) if (b?.id && b.messages?.length) await saveConversation(b.id, b.messages);
    await writeJsonAtomic(botsPath, indexRows(bots));
    return bots;
  });
}

const PALETTE = AVATAR_COLORS;

export function newBot(partial: BotSeed = {}): Bot {
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

export function unionMessages(incoming: readonly Message[] = [], existing: readonly Message[] = []): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) if (m?.id) byId.set(m.id, m);
  for (const m of incoming) {
    if (!m?.id) continue;
    const was = byId.get(m.id);
    // A live turn snapshots messages at start. Don't let it reopen a card the human already answered.
    if (was?.kind === "choices" && was.pending === false && m.kind === "choices" && m.pending !== false) continue;
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function preserveRoutineRunMarker(incoming: StoredRoutine, previous: StoredRoutine): void {
  const incomingDaily = incoming?.schedule?.type === "daily";
  const previousDaily = previous?.schedule?.type === "daily";
  const sameSchedule =
    incomingDaily &&
    previousDaily &&
    incoming.schedule?.hour === previous.schedule?.hour &&
    incoming.schedule?.minute === previous.schedule?.minute;
  const sameTimeZone = incoming.nextRunTimeZone === previous.nextRunTimeZone;
  const previousLast = Number(previous.lastRunAt);
  const incomingLast = Number(incoming.lastRunAt || 0);
  if (Number.isFinite(previousLast) && previousLast > incomingLast) incoming.lastRunAt = previousLast;
  const runs = new Map<number, RoutineRun>();
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

export async function upsertBot(bot: Bot): Promise<Bot> {
  return withBots(async () => {
    const bots = await loadBotsUnlocked();
    const i = bots.findIndex((b) => b.id === bot.id);
    if (i >= 0) {
      const prev = bots[i] as Bot;
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
          // Five that were missing, each a real revert:
          //
          // awaitingUserSelection -- POST /api/bots/:id/choice clears it with
          //   patchBot while a turn started earlier still holds `true` in its
          //   snapshot. runUserTurn upserts the whole bot on every emitted
          //   message, so the clear was written straight back, permanently
          //   latching send_message off: the card is `pending:false` by then,
          //   so /choice answers `already` and never reaches the clear again.
          // vm -- ensureDesktops (12s interval) and the pause route write
          //   container status; a `shell` tool call snapshots the row, blocks up
          //   to 30s, then upserts, reverting "paused" to "running" with no
          //   self-heal, because ensureDesktops then sees "running" and skips.
          // grokSessionId, icon, createdAt -- same stale-snapshot revert.
          "awaitingUserSelection",
          "vm",
          "grokSessionId",
          "icon",
          "createdAt",
        ]) {
          if (prev[key] !== undefined) bot[key] = prev[key];
        }
      } else if (!bot.avatar && prev.avatar) {
        bot.avatar = prev.avatar;
      }
      // Incoming list is authoritative for which routines exist (so Delete sticks).
      // Same-id rows keep the newer updatedAt so a stale turn cannot wipe an edit.
      const incoming = Array.isArray(bot.routines) ? bot.routines : [];
      const existing = new Map<string, StoredRoutine>((prev.routines || []).map((r) => [r.id, r]));
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
    await writeJsonAtomic(botsPath, indexRows(bots));
    return bot;
  });
}

/** Mutate one bot on disk under the write lock (avoids clobbering in-flight turns). */
export async function patchBot(id: string, fn: (bot: Bot) => unknown): Promise<Bot | null> {
  return withBots(async () => {
    const bots = await loadBotsUnlocked();
    const i = bots.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const row = bots[i] as Bot;
    await fn(row);
    row.updatedAt = Date.now();
    await saveConversation(row.id, row.messages);
    await writeJsonAtomic(botsPath, indexRows(bots));
    return row;
  });
}

export async function getBot(id: string): Promise<Bot | null> {
  const want = String(id || "");
  if (!want) return null;
  // Only this bot's transcript, not all of them -- see loadBotsUnlocked.
  const bots = await withBots(() => loadBotsUnlocked(want));
  return bots.find((b) => b.id === want) || null;
}

export async function deleteBot(id: string): Promise<Bot[] | null> {
  return withBots(async () => {
    const bots = await loadBotsUnlocked();
    const next = bots.filter((b) => b.id !== id);
    if (next.length === bots.length) return null;
    await writeJsonAtomic(botsPath, indexRows(next));
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
    // Everything else keyed by this bot id, or it outlives the bot forever.
    //
    // Wakes: every drain path iterates LIVE bots (store.loadBots), so no take*
    // is ever called for an id that no longer exists — a closed teammate's
    // queue just sat in wakes.json. Channel membership: a room the bot still
    // belonged to kept enqueueing a wake for that ghost on every send, so the
    // file grew monotonically, and sendToAgent counted the ghost in its
    // `queued: N` reply, telling the sender it reached one more member than it
    // did.
    //
    // Done HERE rather than at the four call sites (the delete_teammate tool in
    // both harnesses, the team-delete loop, and DELETE /api/bots/:id), because
    // missing one is exactly how this happened.
    try {
      dropWakes(id);
    } catch {
      /* wake store unavailable */
    }
    try {
      // Deferred import: channels.ts imports dataDir/withFileLock from THIS
      // module, so a static import back would be a load-time cycle.
      const { listChannels, removeMember } = await import("./channels.js");
      for (const ch of await listChannels()) {
        if (!(ch.memberIds || []).includes(id)) continue;
        try {
          await removeMember(ch.id, id);
        } catch {
          // Per channel, so one refusal cannot skip the rest. removeMember
          // throws "cannot remove last member", which a room whose only member
          // is this bot will hit; that room is left intact rather than deleted
          // here, because discarding a conversation is the user's call, not a
          // side effect of closing a teammate.
        }
      }
    } catch {
      /* channels unavailable */
    }
    return next;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listConversationIds(): Promise<string[]> {
  await ensure();
  try {
    const names = await fs.readdir(conversationsDir);
    return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
}

/** Re-create bot rows that vanished from a raced bots.json write. Does not start computers. */
export async function recoverMissingBots(hints: readonly BotHint[] = []): Promise<Bot[]> {
  const added: Bot[] = [];
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
