import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, withFileLock, writeJsonAtomic } from "./store.js";

import type {
  Channel,
  ChannelLike,
  ChannelListing,
  ChannelRef,
  ChannelSeed,
  DeskWriter,
  GroupJson,
  PersistedChannel,
  ProfileJson,
} from "./types.js";

export type {
  Channel,
  ChannelLike,
  ChannelListing,
  ChannelRef,
  ChannelSeed,
  DeskWriter,
  GroupJson,
  PersistedChannel,
  ProfileJson,
} from "./types.js";

/** Host source of truth. Desk `group.json` is a mirror (see syncGroupJsonToDesk). */
export const channelsPath = path.join(dataDir, "channels.json");
export const MAX_MEMBERS = 6;
export const GROUP_JSON_VERSION = 1;
export const DESK_AGENTS_ROOT = "/config/agent-data/agents";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let writeChain: Promise<void> = Promise.resolve();
function withFile<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(
    () => withFileLock(`${channelsPath}.lock`, fn),
    () => withFileLock(`${channelsPath}.lock`, fn),
  );
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function parseMemberId(value: unknown): string {
  const s = String(value ?? "").trim().toLowerCase();
  if (!isUuid(s)) throw new Error("membership is by UUID, not display name");
  return s;
}

function parseMemberIds(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error("memberIds required");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const id = parseMemberId(value);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (!out.length) throw new Error("channel cannot be empty");
  if (out.length > MAX_MEMBERS) throw new Error("channel max 6 members");
  return out;
}

function asMemberIds(list: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(list) ? list : []) {
    const s = String(value ?? "").trim().toLowerCase();
    if (!isUuid(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function channelIdOf(channelOrId: ChannelRef): string {
  if (typeof channelOrId === "string") return channelOrId;
  return channelOrId?.id || "";
}

function persistShape(row: PersistedChannel): PersistedChannel {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    memberIds: [...row.memberIds],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function groupJson(channel: ChannelLike | null | undefined): GroupJson {
  return {
    version: GROUP_JSON_VERSION,
    memberIds: [...(channel?.memberIds || channel?.group?.memberIds || [])],
  };
}

export function profileJson(channel: ChannelLike | null | undefined): ProfileJson {
  return {
    name: channel?.name || "Channel",
    description: typeof channel?.description === "string" ? channel.description : "",
  };
}

function publicRow(row: PersistedChannel): Channel {
  const memberIds = [...row.memberIds];
  return {
    ...persistShape(row),
    group: { version: GROUP_JSON_VERSION, memberIds },
  };
}

function normalize(raw: ChannelLike | null | undefined): PersistedChannel {
  const memberIds = asMemberIds(raw?.memberIds || raw?.group?.memberIds);
  return {
    id: String(raw?.id || ""),
    name: String(raw?.name || "").trim() || "Channel",
    description: typeof raw?.description === "string" ? raw.description : "",
    memberIds,
    createdAt: Number(raw?.createdAt) || 0,
    updatedAt: Number(raw?.updatedAt) || 0,
  };
}

async function readAll(): Promise<PersistedChannel[]> {
  try {
    const rows: unknown = JSON.parse(await fs.readFile(channelsPath, "utf8"));
    if (!Array.isArray(rows)) throw new Error("channels.json is not an array");
    return (rows as ChannelLike[]).map((row) => persistShape(normalize(row)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(rows: PersistedChannel[]): Promise<PersistedChannel[]> {
  await fs.mkdir(dataDir, { recursive: true });
  await writeJsonAtomic(channelsPath, rows);
  return rows;
}

/** True when a desk listing (or host row) includes group.json. */
export function isChannel(dirListing: ChannelListing | null | undefined): boolean {
  if (dirListing == null || typeof dirListing !== "object") return false;
  if (dirListing.groupJson != null) return true;
  return dirListing.group != null && dirListing.group.version === GROUP_JSON_VERSION && Array.isArray(dirListing.group.memberIds);
}

export function deskChannelDir(channelId: string): string {
  return `${DESK_AGENTS_ROOT}/${channelId}`;
}

/**
 * Write group.json + profile.json onto the desk.
 * `writer(dest, text)` must create parent dirs. A8 supplies vm mkdir/write;
 * this module does not import vm.mjs.
 */
export async function syncGroupJsonToDesk(
  channel: ChannelLike | null | undefined,
  writer?: DeskWriter,
): Promise<{ dir: string; group: GroupJson; profile: ProfileJson }> {
  if (!channel?.id) throw new Error("channel missing");
  if (typeof writer !== "function") throw new Error("writer required");
  const dir = deskChannelDir(channel.id);
  const group = groupJson(channel);
  const profile = profileJson(channel);
  await writer(`${dir}/group.json`, `${JSON.stringify(group, null, 2)}\n`);
  await writer(`${dir}/profile.json`, `${JSON.stringify(profile, null, 2)}\n`);
  return { dir, group, profile };
}

export async function listChannels(): Promise<Channel[]> {
  return withFile(async () => (await readAll()).map((row) => publicRow(normalize(row))));
}

export async function getChannel(id: string | null | undefined): Promise<Channel | null> {
  if (!id) return null;
  return (await listChannels()).find((c) => c.id === id) || null;
}

export async function createChannel({ name, memberIds, description }: ChannelSeed = {}): Promise<Channel> {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("name required");
  const members = parseMemberIds(memberIds);
  const now = Date.now();
  const row = persistShape({
    id: randomUUID(),
    name: trimmed,
    description: typeof description === "string" ? description : "",
    memberIds: members,
    createdAt: now,
    updatedAt: now,
  });
  return withFile(async () => {
    const rows = await readAll();
    rows.push(row);
    await writeAll(rows);
    return publicRow(normalize(row));
  });
}

export async function addMember(channelOrId: ChannelRef, memberId: unknown): Promise<Channel> {
  const id = channelIdOf(channelOrId);
  if (!id) throw new Error("channel missing");
  const uid = parseMemberId(memberId);
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((c) => c.id === id);
    if (i < 0) throw new Error("channel not found");
    const row = normalize(rows[i]);
    if (row.memberIds.includes(uid)) return publicRow(row);
    if (row.memberIds.length >= MAX_MEMBERS) throw new Error("channel max 6 members");
    row.memberIds.push(uid);
    row.updatedAt = Date.now();
    rows[i] = persistShape(row);
    await writeAll(rows);
    return publicRow(row);
  });
}

export async function removeMember(channelOrId: ChannelRef, memberId: unknown): Promise<Channel> {
  const id = channelIdOf(channelOrId);
  if (!id) throw new Error("channel missing");
  const uid = parseMemberId(memberId);
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((c) => c.id === id);
    if (i < 0) throw new Error("channel not found");
    const row = normalize(rows[i]);
    if (!row.memberIds.includes(uid)) return publicRow(row);
    if (row.memberIds.length <= 1) throw new Error("cannot remove last member");
    row.memberIds = row.memberIds.filter((m) => m !== uid);
    row.updatedAt = Date.now();
    rows[i] = persistShape(row);
    await writeAll(rows);
    return publicRow(row);
  });
}

/** Host-only delete for tests / user sidebar. Agents have no deleteChannel. */
export async function removeChannel(id: string | null | undefined): Promise<Channel[] | null> {
  if (!id) return null;
  return withFile(async () => {
    const rows = await readAll();
    const next = rows.filter((c) => c.id !== id);
    if (next.length === rows.length) return null;
    await writeAll(next);
    return next.map((row) => publicRow(normalize(row)));
  });
}
