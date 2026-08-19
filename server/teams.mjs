import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths.mjs";
import * as store from "./store.mjs";

export const teamsPath = path.join(dataDir, "teams.json");

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
    const rows = JSON.parse(await fs.readFile(teamsPath, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeAll(rows) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(teamsPath, JSON.stringify(rows, null, 2));
  return rows;
}

export function conversationId(teamId) {
  return `team-${teamId}`;
}

export async function listTeams() {
  return withFile(readAll);
}

export async function getTeam(id) {
  return (await listTeams()).find((t) => t.id === id) || null;
}

export async function saveTeam(partial) {
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((t) => t.id === partial.id);
    if (i < 0) {
      const row = {
        id: partial.id || randomUUID(),
        name: partial.name || "Team",
        chiefId: partial.chiefId || null,
        memberIds: Array.isArray(partial.memberIds) ? partial.memberIds : [],
        computerId: partial.computerId || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      rows.push(row);
      await writeAll(rows);
      return row;
    }
    rows[i] = { ...rows[i], ...partial, id: rows[i].id, updatedAt: Date.now() };
    await writeAll(rows);
    return rows[i];
  });
}

export async function removeTeam(id) {
  return withFile(async () => {
    const rows = await readAll();
    const next = rows.filter((t) => t.id !== id);
    if (next.length === rows.length) return null;
    await writeAll(next);
    return next;
  });
}

export async function loadMessages(teamId) {
  return store.loadConversation(conversationId(teamId));
}

export async function appendMessage(teamId, msg) {
  const rows = await store.loadConversation(conversationId(teamId));
  const next = { ...msg, id: msg.id || `t${Date.now()}${Math.random().toString(36).slice(2, 5)}`, teamId, ts: msg.ts || Date.now() };
  rows.push(next);
  await store.replaceConversation(conversationId(teamId), rows);
  return next;
}

export function teamForBot(teams, bot) {
  if (!bot?.teamId) return null;
  return teams.find((t) => t.id === bot.teamId) || null;
}

export function membersOf(team, bots) {
  const ids = new Set(team?.memberIds || []);
  return (bots || []).filter((b) => ids.has(b.id));
}

export const BOT_JOB_CHOICES = [
  { id: "a", label: "X / notifications" },
  { id: "b", label: "GitHub / PRs" },
  { id: "c", label: "Research / browsing" },
  { id: "d", label: "I'll describe it" },
];

export async function addMember(team, spec = {}) {
  if (!team?.id) throw new Error("team missing");
  const bots = await store.loadBots();
  const chief = bots.find((b) => b.id === team.chiefId) || bots.find((b) => b.teamId === team.id);
  const role = spec.role === "chief" ? "chief" : "worker";
  const job = String(spec.job || spec.description || spec.instructions || "").trim();
  const bot = store.newBot({
    name: String(spec.name || role).trim() || role,
    description: job,
    instructions: job,
    harness: spec.harness && typeof spec.harness === "object" ? spec.harness : chief?.harness || { provider: "default" },
    teamId: team.id,
    teamRole: role,
    color: spec.color,
    avatar: spec.avatar,
  });
  const src = chief?.vm || {};
  bot.vm = {
    ...(bot.vm || {}),
    computerId: src.computerId || team.computerId || null,
    container: src.container || null,
    volume: src.volume || null,
    novncPort: src.novncPort || null,
    status: src.status || "idle",
    detached: false,
    hint: src.status === "running" ? "" : "Joining the shared desk…",
  };
  await store.upsertBot(bot);
  const memberIds = [...new Set([...(team.memberIds || []), bot.id])];
  const saved = await saveTeam({ ...team, memberIds, computerId: bot.vm.computerId || team.computerId });
  return { bot, team: saved };
}

export async function applyBotPatch(target, args = {}) {
  if (args.name) target.name = String(args.name).trim() || target.name;
  if (typeof args.instructions === "string") target.instructions = args.instructions;
  if (typeof args.description === "string") target.description = args.description;
  if (args.color) target.color = String(args.color);
  if (args.role === "chief" || args.role === "worker") target.teamRole = args.role;
  if (args.harness || args.provider || args.model) {
    target.harness = {
      ...(target.harness || {}),
      ...(args.harness || args.provider ? { provider: String(args.harness || args.provider) } : {}),
      ...(args.model ? { model: String(args.model) } : {}),
    };
  }
  await store.upsertBot(target);
  return target;
}

export async function removeMember(team, botId) {
  if (!team?.id || !botId) return team;
  const memberIds = (team.memberIds || []).filter((id) => id !== botId);
  const chiefId = team.chiefId === botId ? memberIds[0] || null : team.chiefId;
  if (!memberIds.length) {
    await removeTeam(team.id);
    return null;
  }
  return saveTeam({ ...team, memberIds, chiefId });
}

export function mentionedMemberIds(text, members) {
  const tags = [...String(text || "").matchAll(/@([^\s@.,!?]+)/g)].map((m) => m[1].toLowerCase());
  if (!tags.length) return [];
  const ids = [];
  for (const m of members || []) {
    const name = String(m.name || "").toLowerCase();
    const role = String(m.teamRole || m.role || "").toLowerCase();
    if (tags.some((t) => t === name || t === role || (name && name.startsWith(t)))) ids.push(m.id);
  }
  return [...new Set(ids)];
}
