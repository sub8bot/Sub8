import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../paths.mjs";
import { writeJsonAtomic } from "@sub8/store";
import { AVATAR_COLORS } from "@sub8/constants";

export const draftPath = () => path.join(dataDir, "cloud-draft.json");

export interface DraftSize {
  label: string;
  ram: string;
  price: string;
}

/**
 * Typed as an open record with "4gb" pinned rather than as three literal keys,
 * because every read here is `SIZES[whatever] || SIZES["4gb"]`: an unknown key
 * has to stay a miss, and the fallback has to stay a hit.
 */
const SIZES: { "4gb": DraftSize } & Record<string, DraftSize | undefined> = {
  "4gb": { label: "Cloud", ram: "4 GB", price: "$39/mo" },
  "8gb": { label: "Cloud Team", ram: "8 GB", price: "$69/mo" },
  "16gb": { label: "Cloud Pro", ram: "16 GB", price: "$119/mo" },
};

/**
 * The rows in data/cloud-draft.json. Every field is optional and the index
 * signature stays open: this file is a mock the UI clicks through, its rows are
 * whatever an older build wrote, and each reader already defaults what it needs.
 */
export interface DraftHarness {
  provider?: string | undefined;
  signedIn?: boolean | undefined;
  apiKeySet?: boolean | undefined;
  apiKeyHint?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  [key: string]: unknown;
}

export interface DraftComputerRow {
  id?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  size?: string | undefined;
  region?: string | undefined;
  harness?: DraftHarness | undefined;
  attachedBotId?: string | null | undefined;
  attachedBotName?: string | null | undefined;
  createdAt?: number | undefined;
  [key: string]: unknown;
}

export interface DraftMessage {
  id?: string | undefined;
  role?: string | undefined;
  content?: string | undefined;
  ts?: number | undefined;
  [key: string]: unknown;
}

export interface DraftBotRow {
  id?: string | undefined;
  name?: string | undefined;
  color?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  avatar?: unknown;
  harness?: DraftHarness | undefined;
  identityId?: string | undefined;
  messages?: DraftMessage[] | undefined;
  routines?: unknown[] | undefined;
  computerId?: string | undefined;
  createdAt?: number | undefined;
  /** Set only by hydrate/publicBot callers; never persisted. */
  _computer?: DraftComputerRow | undefined;
  [key: string]: unknown;
}

export interface DraftData {
  version: number;
  computers: DraftComputerRow[];
  bots: DraftBotRow[];
}

function blank(): DraftData {
  return { version: 1, computers: [], bots: [] };
}

function publicComputer(row: DraftComputerRow) {
  // `as string`: SIZES is keyed by string and a row's size may be absent. The
  // assertion emits the same `SIZES[row.size]` this has always run — an absent
  // key is a miss either way, which is what the `|| SIZES["4gb"]` is for.
  const size = SIZES[row.size as string] || SIZES["4gb"];
  return {
    id: row.id,
    name: row.name,
    kind: "cloud-draft",
    status: row.status || "running",
    size: row.size || "4gb",
    sizeLabel: size.label,
    ram: size.ram,
    price: size.price,
    region: row.region || "nyc1",
    harness: {
      provider: row.harness?.provider || "grok-build",
      signedIn: Boolean(row.harness?.signedIn),
      apiKeySet: Boolean(row.harness?.apiKeySet),
      apiKeyHint: row.harness?.apiKeyHint || "",
    },
    attachedBotId: row.attachedBotId || null,
    attachedBotName: row.attachedBotName || null,
    createdAt: row.createdAt,
    draft: true,
  };
}

function publicBot(row: DraftBotRow) {
  const desk = publicComputer(row._computer || { id: row.computerId, name: "Cloud desk", harness: {} });
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description || "",
    instructions: row.instructions || "",
    avatar: row.avatar || { expression: "calm", animation: "idle", body: "rounder" },
    harness: row.harness || { provider: "grok-build", model: "grok-4.6" },
    identityId: row.identityId || "",
    messages: row.messages || [],
    routines: row.routines || [],
    computerId: row.computerId,
    place: "cloud",
    draft: true,
    vm: {
      kind: "cloud-draft",
      computerId: row.computerId,
      status: "running",
      hint: "Draft desk — no real VM yet.",
    },
    desk,
  };
}

async function readAll(): Promise<DraftData> {
  try {
    const raw = JSON.parse(await fs.readFile(draftPath(), "utf8"));
    if (!raw || typeof raw !== "object") return blank();
    return {
      version: 1,
      computers: Array.isArray(raw.computers) ? raw.computers : [],
      bots: Array.isArray(raw.bots) ? raw.bots : [],
    };
  } catch {
    return blank();
  }
}

async function writeAll(data: DraftData): Promise<DraftData> {
  await fs.mkdir(dataDir, { recursive: true });
  const next = { version: 1, computers: data.computers || [], bots: data.bots || [] };
  await writeJsonAtomic(draftPath(), next);
  return next;
}

function hydrate(data: DraftData) {
  const computers = data.computers.map((c) => {
    const bot = data.bots.find((b) => b.id === c.attachedBotId || b.computerId === c.id);
    return publicComputer({ ...c, attachedBotId: bot?.id || c.attachedBotId, attachedBotName: bot?.name || null });
  });
  const bots = data.bots.map((b) => {
    const desk = data.computers.find((c) => c.id === b.computerId);
    return publicBot({ ...b, _computer: desk });
  });
  return { computers, bots };
}

export async function snapshot() {
  return hydrate(await readAll());
}

export async function createComputer({ name, size }: { name?: string | undefined; size?: string | undefined } = {}) {
  const data = await readAll();
  const id = randomUUID();
  const row: DraftComputerRow = {
    id,
    name: String(name || "Cloud desk").trim() || "Cloud desk",
    status: "running",
    size: SIZES[size as string] ? size : "4gb",
    region: "nyc1",
    harness: { provider: "grok-build", signedIn: false, apiKeySet: false },
    attachedBotId: null,
    createdAt: Date.now(),
  };
  data.computers.push(row);
  await writeAll(data);
  return publicComputer(row);
}

export interface DraftComputerPatch {
  name?: string | undefined;
  size?: string | undefined;
  harness?: DraftHarness | undefined;
}

export async function patchComputer(id: string, patch: DraftComputerPatch = {}) {
  const data = await readAll();
  const row = data.computers.find((c) => c.id === id);
  if (!row) return null;
  if (patch.name) row.name = String(patch.name).trim() || row.name;
  if (patch.size && SIZES[patch.size]) row.size = patch.size;
  if (patch.harness && typeof patch.harness === "object") {
    row.harness = { ...(row.harness || {}), ...patch.harness };
    if (patch.harness.apiKey) {
      row.harness.apiKeySet = true;
      row.harness.apiKeyHint = `${String(patch.harness.apiKey).slice(0, 6)}…`;
      delete row.harness.apiKey;
    }
  }
  await writeAll(data);
  return publicComputer(row);
}

export async function destroyComputer(id: string) {
  const data = await readAll();
  if (!data.computers.some((c) => c.id === id)) return false;
  data.computers = data.computers.filter((c) => c.id !== id);
  data.bots = data.bots.filter((b) => b.computerId !== id);
  await writeAll(data);
  return true;
}

export interface CreateBotInput {
  name?: string | undefined;
  description?: string | undefined;
  computerId?: string | undefined;
  harness?: DraftHarness | undefined;
  avatar?: unknown;
  color?: string | undefined;
}

export async function createBot({ name, description, computerId, harness, avatar, color }: CreateBotInput = {}) {
  const data = await readAll();
  let desk = data.computers.find((c) => c.id === computerId) || data.computers[0];
  if (!desk) {
    const made = await createComputer({ name: "Cloud desk" });
    const fresh = await readAll();
    desk = fresh.computers.find((c) => c.id === made.id);
    data.computers = fresh.computers;
  }
  const id = randomUUID();
  const palette = AVATAR_COLORS.filter((c) => c !== "#f8fafc");
  const row: DraftBotRow = {
    id,
    name: String(name || "Cloud Bot").trim() || "Cloud Bot",
    description: String(description || "").trim(),
    instructions: "",
    color: color || palette[data.bots.length % palette.length],
    avatar: avatar || { expression: "calm", animation: "idle", body: "rounder" },
    harness: harness && typeof harness === "object" ? harness : { provider: "grok-build", model: "grok-4.6" },
    // `!`: the branch above just wrote this desk through createComputer, so the
    // re-read finds it. A miss would already have thrown on this line before the
    // conversion — the assertion keeps that, it does not paper over a new case.
    computerId: desk!.id,
    messages: [
      {
        id: randomUUID(),
        role: "assistant",
        content:
          "This is a Cloud draft. No VM is running yet — I only exist so you can click through the story. Chats stay here on this Mac under data/cloud-draft.json.",
        ts: Date.now(),
      },
    ],
    routines: [],
    createdAt: Date.now(),
  };
  desk!.attachedBotId = id;
  data.bots.push(row);
  await writeAll(data);
  return publicBot({ ...row, _computer: desk });
}

export interface DraftBotPatch {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  color?: string | undefined;
  avatar?: Record<string, unknown> | undefined;
  harness?: DraftHarness | undefined;
  identityId?: string | undefined;
  [key: string]: unknown;
}

export async function patchBot(id: string, patch: DraftBotPatch = {}) {
  const data = await readAll();
  const row = data.bots.find((b) => b.id === id);
  if (!row) return null;
  for (const key of ["name", "description", "instructions", "color"]) {
    if (patch[key] != null) row[key] = patch[key];
  }
  if (patch.avatar) row.avatar = { ...(row.avatar || {}), ...patch.avatar };
  if (patch.harness) row.harness = { ...(row.harness || {}), ...patch.harness };
  if (patch.identityId != null) row.identityId = String(patch.identityId).trim();
  await writeAll(data);
  const desk = data.computers.find((c) => c.id === row.computerId);
  return publicBot({ ...row, _computer: desk });
}

export async function deleteBot(id: string) {
  const data = await readAll();
  const row = data.bots.find((b) => b.id === id);
  if (!row) return false;
  data.bots = data.bots.filter((b) => b.id !== id);
  for (const c of data.computers) {
    if (c.attachedBotId === id) c.attachedBotId = data.bots.find((b) => b.computerId === c.id)?.id || null;
  }
  await writeAll(data);
  return true;
}

const DRAFT_REPLIES = [
  "Draft Cloud is working. When this ships, I would run on a desk that stays on after you close the laptop.",
  "Got it — still a mock. Next we would use Grok on that VM, or an Anthropic API key pasted on the desk.",
  "Noted. Destroying this draft computer would wipe the desk mock, not your This Mac Bots.",
];

export async function addMessage(botId: string, content: string) {
  const data = await readAll();
  const row = data.bots.find((b) => b.id === botId);
  if (!row) return null;
  const text = String(content || "").trim();
  if (!text) return publicBot(row);
  row.messages = row.messages || [];
  row.messages.push({ id: randomUUID(), role: "user", content: text, ts: Date.now() });
  // `!`: the index is `n % DRAFT_REPLIES.length` on a non-empty const array, so
  // it is always in range.
  const reply = DRAFT_REPLIES[row.messages.filter((m) => m.role === "user").length % DRAFT_REPLIES.length]!;
  row.messages.push({ id: randomUUID(), role: "assistant", content: reply, ts: Date.now() + 1 });
  await writeAll(data);
  const desk = data.computers.find((c) => c.id === row.computerId);
  return publicBot({ ...row, _computer: desk });
}

export { SIZES };
