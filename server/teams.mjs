import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths.mjs";
import * as store from "./store.mjs";
import * as vm from "./vm.mjs";

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
        section: partial.section || "",
        pinned: Boolean(partial.pinned),
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
  const all = await store.loadBots();
  const mates = membersOf(saved, all);
  vm.applyTeamDisplays(saved, mates, src.novncPort || null);
  for (const m of mates) await store.upsertBot(m);
  if (src.container) {
    vm.bindDisplayStreams(src.container, mates).catch(() => {});
    vm.ensureBotDisplay(mates.find((m) => m.id === bot.id) || bot).catch(() => {});
    vm.scaleDeskMemory(src.container, mates.length).catch(() => {});
  }
  return { bot: mates.find((m) => m.id === bot.id) || bot, team: saved };
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

export const TASK_STATUSES = ["pending", "running", "done", "blocked", "looping"];

export function newJob({ title, steps } = {}) {
  const now = Date.now();
  return {
    id: randomUUID(),
    title: String(title || "Job").slice(0, 80),
    createdAt: now,
    updatedAt: now,
    steps: (Array.isArray(steps) ? steps : []).map((s) => normalizeStep(s, now)),
  };
}

function normalizeStep(s = {}, now = Date.now()) {
  const status = TASK_STATUSES.includes(s.status) ? s.status : "pending";
  return {
    id: s.id || randomUUID(),
    label: String(s.label || "step").slice(0, 48),
    botId: s.botId || s.bot_id || null,
    status,
    detail: String(s.detail || "").slice(0, 160),
    loopCount: Number(s.loopCount) > 0 ? Number(s.loopCount) : 0,
    updatedAt: s.updatedAt || now,
  };
}

export function jobProgress(job) {
  const steps = job?.steps || [];
  const done = steps.filter((s) => s.status === "done").length;
  const blocked = steps.filter((s) => s.status === "blocked").length;
  const looping = steps.filter((s) => s.status === "looping").length;
  return {
    total: steps.length,
    done,
    blocked,
    looping,
    pending: steps.filter((s) => s.status === "pending").length,
    running: steps.filter((s) => s.status === "running").length,
    complete: steps.length > 0 && done + blocked === steps.length,
  };
}

export function findStep(job, { stepId, label, botId } = {}) {
  const steps = job?.steps || [];
  if (stepId) return steps.find((s) => s.id === stepId) || null;
  if (botId) {
    const hits = steps.filter((s) => s.botId === botId);
    if (hits.length === 1) return hits[0];
    if (label) return hits.find((s) => s.label.toLowerCase() === String(label).toLowerCase()) || hits[0] || null;
  }
  if (label) {
    const want = String(label).toLowerCase();
    return steps.find((s) => s.label.toLowerCase() === want) || steps.find((s) => s.label.toLowerCase().includes(want)) || null;
  }
  return null;
}

export function applyStepUpdate(job, patch = {}) {
  if (!job?.steps) return { job, step: null };
  const step = findStep(job, patch);
  if (!step) return { job, step: null };
  const next = TASK_STATUSES.includes(patch.status) ? patch.status : step.status;
  if (next === "running" && (step.status === "running" || step.status === "looping")) {
    step.loopCount = (step.loopCount || 0) + 1;
    step.status = step.loopCount >= 2 ? "looping" : "running";
  } else {
    step.status = next;
    if (next === "done" || next === "pending") step.loopCount = 0;
  }
  if (patch.detail != null) step.detail = String(patch.detail).slice(0, 160);
  step.updatedAt = Date.now();
  job.updatedAt = Date.now();
  return { job, step };
}

/** When every non-summary step is done/blocked, mark Summary done. No text matching. */
export function maybeFinalizeSummary(job) {
  if (!job?.steps?.length) return { job, finalized: false };
  const summary = job.steps.find((s) => String(s.label || "").toLowerCase() === "summary");
  if (!summary || summary.status === "done") return { job, finalized: false };
  const others = job.steps.filter((s) => s !== summary);
  if (!others.length || !others.every((s) => s.status === "done" || s.status === "blocked")) {
    return { job, finalized: false };
  }
  applyStepUpdate(job, { stepId: summary.id, status: "done", detail: summary.detail || "compiled" });
  return { job, finalized: true };
}

export async function setTeamJob(teamId, spec) {
  const team = await getTeam(teamId);
  if (!team) return null;
  const job = newJob(spec);
  return saveTeam({ ...team, job });
}

export async function patchTeamStep(teamId, patch) {
  const team = await getTeam(teamId);
  if (!team?.job) return null;
  const { job, step } = applyStepUpdate(team.job, patch);
  if (!step) return { team, job, step: null };
  const saved = await saveTeam({ ...team, job });
  return { team: saved, job: saved.job, step };
}
