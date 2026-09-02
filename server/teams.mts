import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths.mjs";
import * as store from "@sub8/store";
import * as vm from "./vm.mjs";
import * as memory from "./memory.mjs";

/** The five states a job step can be in. */
export type TaskStatus = "pending" | "running" | "done" | "blocked" | "looping";

/** One step of a team's job, exactly as it is persisted on the team row. */
export interface JobStep {
  id: string;
  label: string;
  botId: string | null;
  status: TaskStatus;
  detail: string;
  loopCount: number;
  updatedAt: number;
}

/**
 * A step as a caller hands it in. These arrive as tool arguments, so nothing is
 * trusted; `normalizeStep` is what turns one into a `JobStep`.
 */
export interface JobStepSeed {
  id?: string | undefined;
  label?: unknown;
  botId?: string | null | undefined;
  /** The snake spelling the tool schemas use. */
  bot_id?: string | null | undefined;
  status?: unknown;
  detail?: unknown;
  loopCount?: unknown;
  updatedAt?: number | undefined;
}

/** A team's job: the steps behind the progress bar. */
export interface Job {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  steps: JobStep[];
}

/** What `newJob` accepts. */
export interface JobSeed {
  title?: unknown;
  steps?: JobStepSeed[] | undefined;
}

/** How `findStep` is asked for a step: by id, by label, or by owner. */
export interface StepQuery {
  stepId?: string | undefined;
  label?: unknown;
  botId?: string | null | undefined;
}

/** A `findStep` query plus the two fields `applyStepUpdate` writes. */
export interface StepPatch extends StepQuery {
  status?: unknown;
  detail?: unknown;
}

/** What `jobProgress` counts. */
export interface JobProgress {
  total: number;
  done: number;
  blocked: number;
  looping: number;
  pending: number;
  running: number;
  complete: boolean;
}

/** The slice of a bot the membership helpers read. Callers pass whole bot rows. */
export interface TeamMember {
  id: string;
  name?: string | undefined;
  teamRole?: string | undefined;
  /** Tool-shaped rows spell the role plainly; `@sub8/store` does not model it. */
  role?: string | undefined;
  /** Extra words this member wakes on when they appear in a channel message
   * (beyond their own name/role, which always wake them). Opt-in per bot. */
  channelKeywords?: readonly string[] | undefined;
  /** Coordination state. `hold` = parked by the chief, does not wake on channel
   * traffic until resumed; `active` (default) wakes normally. */
  channelState?: "active" | "hold" | undefined;
}

/** A team as the membership guards read it: a stored row, or an expanded view. */
export interface TeamView {
  id?: string | undefined;
  chiefId?: string | null | undefined;
  memberIds?: string[] | undefined;
  computerId?: unknown;
  /** Never persisted: some tool paths hand these helpers a member-expanded team. */
  members?: TeamMember[] | undefined;
}

/**
 * One row of `data/teams.json`. Rows written by older builds carry fields this
 * version does not know about, so the index signature keeps the type open.
 *
 * `computerId` is `unknown` on purpose: every value that reaches it comes off
 * `bot.vm`, which `@sub8/store` types as `unknown`, and both the read and the
 * write below only ever OR it with a fallback.
 */
export interface Team extends TeamView {
  id: string;
  name: string;
  chiefId: string | null;
  memberIds: string[];
  computerId: unknown;
  section: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  job?: Job | null | undefined;
  /** `saveTeam` strips this on every update; only `setTeamJob` hands it back out. */
  renamed?: unknown;
  [key: string]: unknown;
}

/** What `saveTeam` accepts: a whole row, or just the fields being changed. */
export type TeamPatch = Partial<Team>;

/**
 * The bot `applyBotPatch` edits. `@sub8/store`'s `Bot` and `memory`'s
 * `MemoryBot` describe the same record from two sides, and this patch both
 * persists it and rewrites its desk profile, so it needs to satisfy both.
 */
export type PatchableBot = store.Bot & memory.MemoryBot;

/**
 * A team as vm.mjs's display helpers want one. They type `chiefId` as
 * `string | undefined`; a stored team spells "no chief" as `null`, which those
 * helpers already handle (`team?.chiefId ? … : null`). They read nothing else.
 */
type TeamRosterView = { memberIds: string[]; chiefId?: string | undefined };

/**
 * A stored bot as vm.mjs's display helpers want one. `@sub8/store` types
 * `bot.vm.container` as `string | null | undefined` — `addMember` below writes
 * `null` into it for a teammate whose desk has no container yet — while
 * vm.mts's `VmInfo` narrows that same field to `string`. The three calls that
 * take this read only `display` and `novncPort`, and guard `container` with a
 * truthiness test, so the records cross as they are. The two models genuinely
 * disagree about `container`; nothing here can reconcile them without editing
 * vm.mts.
 */
type DisplayBot = store.Bot & { vm?: vm.VmInfo | undefined };

export const teamsPath = path.join(dataDir, "teams.json");

let writeChain: Promise<void> = Promise.resolve();
function withFile<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(
    () => store.withFileLock(`${teamsPath}.lock`, fn),
    () => store.withFileLock(`${teamsPath}.lock`, fn),
  );
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readAll(): Promise<Team[]> {
  try {
    const rows = JSON.parse(await fs.readFile(teamsPath, "utf8"));
    if (!Array.isArray(rows)) throw new Error("teams.json is not an array");
    return rows;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(rows: Team[]): Promise<Team[]> {
  await fs.mkdir(dataDir, { recursive: true });
  await store.writeJsonAtomic(teamsPath, rows);
  return rows;
}

/**
 * Read → modify → write under ONE lock.
 *
 * `withFile` is held for the duration of a single readAll or writeAll, never
 * across the pair — so the getTeam-then-saveTeam shape used throughout this
 * module is a lost-update race, and saveTeam spreads the caller's whole stale
 * `job` over the row. Turns are serialised per bot but not across bots, and
 * every bot runs in one process, so two workers reporting in overlapping turns
 * is ordinary. The update that loses leaves its step forever `pending`, which
 * means maybeFinalizeSummary can never fire and the job never completes.
 *
 * The callback runs INSIDE the lock: it must mutate the row it is handed and
 * must not call getTeam/saveTeam, which would take the lock again.
 */
async function mutateTeam<T>(
  teamId: string,
  fn: (team: Team) => T | Promise<T>,
): Promise<{ team: Team; out: T } | null> {
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((t) => t.id === teamId);
    if (i < 0) return null;
    const team = rows[i] as Team;
    const out = await fn(team);
    team.updatedAt = Date.now();
    rows[i] = team;
    await writeAll(rows);
    return { team, out };
  });
}

export function conversationId(teamId: string): string {
  return `team-${teamId}`;
}

export async function listTeams(): Promise<Team[]> {
  return withFile(readAll);
}

export async function getTeam(id: string | null | undefined): Promise<Team | null> {
  return (await listTeams()).find((t) => t.id === id) || null;
}

/** The slice of a bot `ensureTeamForBot` needs to find or create its crew. */
export type TeamChiefBot = {
  id: string;
  name?: string | undefined;
  teamId?: string | undefined;
  teamRole?: string | undefined;
  vm?: { computerId?: unknown } | undefined;
};

function sameComputer(team: Team, bot: TeamChiefBot): boolean {
  const want = bot.vm?.computerId ? String(bot.vm.computerId) : "";
  const have = team.computerId ? String(team.computerId) : "";
  if (!want || !have) return true;
  return want === have;
}

function findTeamForChief(rows: Team[], bot: TeamChiefBot): Team | undefined {
  if (bot.teamId) {
    const byId = rows.find((t) => t.id === bot.teamId);
    if (byId) return byId;
  }
  const asChief = rows.find((t) => t.chiefId === bot.id && sameComputer(t, bot));
  if (asChief) return asChief;
  return rows.find((t) => (t.memberIds || []).includes(bot.id) && sameComputer(t, bot));
}

/**
 * Find-or-create the chief's team under the teams.json lock.
 *
 * Parallel create_teammate used to each `saveTeam` when `bot.teamId` was empty,
 * so one request for two workers spawned two teams with the same name and the
 * first worker sat Unassigned.
 */
export async function ensureTeamForBot(bot: TeamChiefBot): Promise<Team> {
  let dropped: string[] = [];
  const team = await withFile(async () => {
    const rows = await readAll();
    const matches = rows.filter((t) => t.chiefId === bot.id && sameComputer(t, bot));
    const existing = (bot.teamId && matches.find((t) => t.id === bot.teamId)) || matches[0] || findTeamForChief(rows, bot);
    if (existing) {
      const extras = matches.filter((t) => t.id !== existing.id);
      dropped = extras.map((t) => t.id);
      existing.memberIds = [
        ...new Set([...(existing.memberIds || []), bot.id, ...extras.flatMap((t) => t.memberIds || [])]),
      ];
      existing.updatedAt = Date.now();
      const next = extras.length ? rows.filter((t) => !dropped.includes(t.id)) : rows;
      await writeAll(next);
      return existing;
    }
    const row: Team = {
      id: randomUUID(),
      name: `${bot.name || "Bot"}'s team`,
      chiefId: bot.id,
      memberIds: [bot.id],
      computerId: bot.vm?.computerId || null,
      section: "",
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    rows.push(row);
    await writeAll(rows);
    return row;
  });
  if (dropped.length) {
    const drop = new Set(dropped);
    for (const b of await store.loadBots()) {
      if (b.teamId && drop.has(b.teamId)) {
        await store.patchBot(b.id, (row) => {
          row.teamId = team.id;
          if (!row.teamRole) row.teamRole = "worker";
        });
      }
    }
  }
  await store.patchBot(bot.id, (b) => {
    b.teamId = team.id;
    b.teamRole = b.teamRole || "chief";
  });
  bot.teamId = team.id;
  bot.teamRole = bot.teamRole || "chief";
  return team;
}

export async function saveTeam(partial: TeamPatch): Promise<Team> {
  return withFile(async () => {
    const rows = await readAll();
    const i = rows.findIndex((t) => t.id === partial.id);
    if (i < 0) {
      const row: Team = {
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
    // `!`: `i` came from findIndex and is >= 0 here, so rows[i] is present.
    // noUncheckedIndexedAccess cannot see that; a runtime guard would add a
    // branch this code has never had.
    rows[i] = { ...rows[i]!, ...partial, id: rows[i]!.id, updatedAt: Date.now() };
    delete rows[i]!.renamed;
    await writeAll(rows);
    return rows[i]!;
  });
}

export async function removeTeam(id: string): Promise<Team[] | null> {
  return withFile(async () => {
    const rows = await readAll();
    const next = rows.filter((t) => t.id !== id);
    if (next.length === rows.length) return null;
    await writeAll(next);
    return next;
  });
}

export async function loadMessages(teamId: string): Promise<store.Message[]> {
  return store.loadConversation(conversationId(teamId));
}

export async function appendMessage(teamId: string, msg: Partial<store.Message>): Promise<store.Message> {
  const next = { ...msg, id: msg.id || `t${Date.now()}${Math.random().toString(36).slice(2, 5)}`, teamId, ts: msg.ts || Date.now() };
  // appendConversation does the read-modify-write under ONE lock. The old
  // load/push/replace here lost a message whenever two turns on the same
  // team overlapped -- the normal case for a chief plus its workers, and
  // worse across processes, since mcp-sub8 runs as a separate one.
  await store.appendConversation(conversationId(teamId), [next]);
  return next;
}

export function teamForBot<T extends { id: string }>(
  teams: readonly T[],
  bot: { teamId?: string | undefined } | null | undefined,
): T | null {
  if (!bot?.teamId) return null;
  return teams.find((t) => t.id === bot.teamId) || null;
}

export function membersOf<T extends { id: string }>(
  team: TeamView | null | undefined,
  bots: readonly T[] | null | undefined,
): T[] {
  const ids = new Set(team?.memberIds || []);
  return (bots || []).filter((b) => ids.has(b.id));
}

/** A leftover chief-only team is not a group — rail and title treat it as a solo bot. */
export function isSoloTeam(team: TeamView | null | undefined, bots?: readonly { id: string }[] | null): boolean {
  if (!team) return true;
  const live = bots ? membersOf(team, bots) : null;
  if (live) return live.length < 2;
  const ids = (team.memberIds || []).filter(Boolean);
  if (ids.length < 2) return true;
  return Boolean(team.chiefId && ids.every((id) => id === team.chiefId));
}

/** One option on the card a fresh bot is offered when it has no job yet. */
export interface BotJobChoice {
  id: string;
  label: string;
}

export const BOT_JOB_CHOICES: readonly BotJobChoice[] = [
  { id: "a", label: "X / notifications" },
  { id: "b", label: "GitHub / PRs" },
  { id: "c", label: "Research / browsing" },
  { id: "d", label: "I'll describe it" },
];

/** What `addMember` accepts: tool arguments, so every field is a guess. */
export interface MemberSpec {
  role?: string | undefined;
  job?: unknown;
  description?: unknown;
  instructions?: unknown;
  name?: unknown;
  harness?: store.BotHarness | undefined;
  color?: string | undefined;
  avatar?: Partial<store.BotAvatar> | undefined;
}

export async function addMember(
  team: Team | null | undefined,
  spec: MemberSpec = {},
): Promise<{ bot: store.Bot; team: Team }> {
  if (!team?.id) throw new Error("team missing");
  const bots = await store.loadBots();
  const chief = bots.find((b) => b.id === team.chiefId) || bots.find((b) => b.teamId === team.id);
  const role = spec.role === "chief" ? "chief" : "worker";
  const job = String(spec.job || spec.description || spec.instructions || "").trim();
  const mateName = String(spec.name || role).trim() || role;
  const bot = store.newBot({
    name: mateName,
    description: job,
    instructions: job,
    harness: spec.harness && typeof spec.harness === "object" ? spec.harness : chief?.harness || { provider: "default" },
    teamId: team.id,
    teamRole: role,
    color: spec.color,
    avatar: spec.avatar,
    channelState: "active",
  });
  const src: store.BotVm = chief?.vm || {};
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
  const mutated = await mutateTeam(team.id, (row) => {
    row.memberIds = [...new Set([...(row.memberIds || []), bot.id])];
    if (bot.vm?.computerId && !row.computerId) row.computerId = bot.vm.computerId;
  });
  await store.upsertBot(bot);
  const saved = mutated?.team || (await saveTeam({ ...team, memberIds: [...new Set([...(team.memberIds || []), bot.id])], computerId: bot.vm.computerId || team.computerId }));
  const all = await store.loadBots();
  const mates = membersOf(saved, all);
  vm.applyTeamDisplays(saved as TeamRosterView, mates as DisplayBot[], src.novncPort || null);
  for (const m of mates) await store.upsertBot(m);
  if (src.container) {
    vm.bindDisplayStreams(src.container, mates as DisplayBot[]).catch(() => {});
    vm.ensureBotDisplay((mates.find((m) => m.id === bot.id) || bot) as DisplayBot).catch(() => {});
    vm.scaleDeskMemory(src.container, mates.length).catch(() => {});
  }
  return { bot: mates.find((m) => m.id === bot.id) || bot, team: saved };
}

/** One of the three fields that ARE a teammate. */
export type IdentityField = "name" | "description" | "instructions";

/** The three fields that ARE a teammate. One tool call must never smear one string across them. */
export const IDENTITY_FIELDS: readonly IdentityField[] = ["name", "description", "instructions"];

/** A rename_bot / update_bot patch, straight off a tool call. */
export interface BotPatchArgs {
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  color?: unknown;
  role?: unknown;
  harness?: unknown;
  provider?: unknown;
  model?: unknown;
  bot_id?: unknown;
  [key: string]: unknown;
}

/**
 * Refuse the shape that destroyed a teammate: a "send Scout a ping" turn reached
 * rename_bot and wrote the message text into name AND description AND
 * instructions, so Scout showed up as "ping LOCALSUITE-1787676564" with no job
 * left — while the marker assertion still went green. One string in `name` and
 * the same string in description/instructions is never a real edit: a name is a
 * label, a description/instructions is a brief. Returns a reason, or null.
 */
export function botPatchRefusal(args: BotPatchArgs = {}): string | null {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return null;
  const smeared = IDENTITY_FIELDS.filter((f) => f !== "name").filter(
    (f) => typeof args[f] === "string" && String(args[f]).trim() === name,
  );
  if (!smeared.length) return null;
  return (
    `Refused: that call writes the same text into name and ${smeared.join(" and ")}, which erases who the Bot is and what its job is. ` +
    "That is never an edit. To say something to a teammate use message_teammate. To rename, call rename_bot with only name."
  );
}

/** The three identity fields as a plain record. */
export type Identity = Record<IdentityField, string>;

function identityOf(bot: PatchableBot | null | undefined): Identity {
  return {
    name: bot?.name || "",
    description: bot?.description || "",
    instructions: bot?.instructions || "",
  };
}

/** What `applyBotPatch` reports back: the bot, plus what it refused or dropped. */
export interface BotPatchResult {
  ok: boolean;
  bot: PatchableBot;
  ignored: string[];
  refused?: string | undefined;
  changed?: IdentityField[] | undefined;
  prior?: Identity | null | undefined;
}

/**
 * Apply a rename_bot / update_bot patch.
 *
 * `tool` splits the aliases that used to share this body: rename_bot may set
 * ONLY the name (that is all its schema ever declared), update_bot owns the
 * rest. Whatever a rename_bot call also carried is reported back as ignored so
 * the model learns instead of silently losing the edit.
 *
 * Any change to name/description/instructions leaves the old values on the
 * record as `priorIdentity`, so a bad edit is undoable.
 */
export async function applyBotPatch(
  target: PatchableBot,
  args: BotPatchArgs = {},
  { tool = "update_bot" }: { tool?: string | undefined } = {},
): Promise<BotPatchResult> {
  const refused = botPatchRefusal(args);
  if (refused) return { ok: false, refused, bot: target, ignored: [] };
  const renameOnly = String(tool) === "rename_bot";
  const ignored = renameOnly
    ? Object.keys(args).filter((k) => k !== "name" && k !== "bot_id" && args[k] !== undefined)
    : [];
  const before = identityOf(target);
  if (args.name) target.name = String(args.name).trim() || target.name;
  if (!renameOnly) {
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
  }
  const after = identityOf(target);
  const changed = IDENTITY_FIELDS.filter((f) => before[f] !== after[f]);
  if (changed.length) target.priorIdentity = { ...before, changed, tool: String(tool), at: Date.now() };
  await store.upsertBot(target);
  await memory.writeProfile(target).catch(() => {});
  return { ok: true, bot: target, ignored, changed, prior: changed.length ? before : null };
}

export async function removeMember(team: Team | null | undefined, botId: string): Promise<Team | null | undefined> {
  return removeMembers(team, [botId]);
}

export function wantsCloseTeammates(text: unknown): boolean {
  const t = String(text || "");
  return (
    /\b(close|delete|remove|dismiss|kill|shut\s*down)\b[\s\S]{0,48}\b(all\s+)?(the\s+)?(other\s+)?(bots?|teammates?|workers?|mates?)\b/i.test(t) ||
    /\b(all\s+)?(the\s+)?(other\s+)?(bots?|teammates?|workers?)\b[\s\S]{0,24}\b(close|delete|remove)\b/i.test(t)
  );
}

/** The close_teammate tool's arguments. */
export interface CloseArgs {
  all_workers?: unknown;
  bot_id?: unknown;
}

/** What `idsToClose` decides: the ids to close, or why it refuses. */
export interface CloseTargets {
  ids?: string[] | undefined;
  error?: string | undefined;
}

export function idsToClose(
  team: TeamView | null | undefined,
  selfId: string | null | undefined,
  args: CloseArgs = {},
  deskWorkerIds: readonly string[] = [],
): CloseTargets {
  const memberIds = Array.isArray(team?.memberIds)
    ? team.memberIds.filter(Boolean)
    : (team?.members || []).map((m) => m.id).filter(Boolean);
  const known = [...new Set([...memberIds, ...deskWorkerIds.filter(Boolean)])];
  const chiefId =
    team?.chiefId ||
    (team?.members || []).find((m) => m.role === "chief" || m.teamRole === "chief")?.id ||
    null;
  const all = args.all_workers === true || String(args.bot_id || "").trim().toLowerCase() === "all";
  if (all) {
    return { ids: known.filter((id) => id && id !== selfId && id !== chiefId) };
  }
  const targetId = String(args.bot_id || "").trim();
  if (!targetId) return { error: "bot_id required (or all_workers=true to close every worker)" };
  if (targetId === selfId) return { error: "You cannot delete yourself with this tool. Ask the human." };
  if (targetId === chiefId) return { error: "The desk bot stays until you destroy the computer." };
  if (!known.includes(targetId)) return { error: "that Bot is not on your team" };
  return { ids: [targetId] };
}

/** The slice of a bot `workerIdsOnDesk` needs. */
export type DeskMateBot = {
  id: string;
  teamId?: string | undefined;
  teamRole?: string | undefined;
  vm?: unknown;
};

function computerOf(bot: DeskMateBot | null | undefined): string {
  const vm = bot?.vm;
  if (!vm || typeof vm !== "object") return "";
  const id = (vm as { computerId?: unknown }).computerId;
  return id ? String(id) : "";
}

/**
 * Workers on this chief's desk, including ones stranded on a duplicate team or
 * with a cleared teamId after the last delete. list/delete_teammate used only
 * `bot.teamId`, so those orphans stayed in the rail.
 */
export function workerIdsOnDesk(
  self: DeskMateBot | null | undefined,
  bots: readonly DeskMateBot[] | null | undefined,
  teamsList: readonly TeamView[] | null | undefined = [],
): string[] {
  if (!self?.id) return [];
  const computer = computerOf(self);
  const chiefTeams = new Set(
    (teamsList || [])
      .filter((t) => t.chiefId === self.id && (!computer || !t.computerId || String(t.computerId) === computer))
      .map((t) => t.id)
      .filter(Boolean) as string[],
  );
  if (self.teamId) chiefTeams.add(self.teamId);
  const ids: string[] = [];
  for (const b of bots || []) {
    if (!b?.id || b.id === self.id) continue;
    if (b.teamRole === "chief") continue;
    const sameTeam = Boolean(b.teamId && chiefTeams.has(b.teamId));
    const sameDesk = Boolean(computer && computerOf(b) === computer);
    if (sameTeam || sameDesk) ids.push(b.id);
  }
  return [...new Set(ids)];
}

export async function listDeskWorkers(self: DeskMateBot | null | undefined): Promise<store.Bot[]> {
  const [bots, teamsList] = await Promise.all([store.loadBots(), listTeams()]);
  const ids = new Set(workerIdsOnDesk(self, bots, teamsList));
  return bots.filter((b) => ids.has(b.id));
}

export async function closeTargetsForBot(self: DeskMateBot | null | undefined, args: CloseArgs = {}): Promise<CloseTargets> {
  const [bots, teamsList] = await Promise.all([store.loadBots(), listTeams()]);
  const team = self?.teamId ? await getTeam(self.teamId) : null;
  return idsToClose(team, self?.id, args, workerIdsOnDesk(self, bots, teamsList));
}

export async function removeMembers(
  team: Team | null | undefined,
  botIds: readonly (string | null | undefined)[] | null | undefined,
): Promise<Team | null | undefined> {
  if (!team?.id) return team;
  const drop = new Set((botIds || []).filter(Boolean));
  // The chief is not removable through here — removeMembers is how workers get
  // closed (delete_teammate, all_workers or by id), and a chief closing itself
  // would orphan the team. Asking to remove it is therefore a silent no-op.
  if (team.chiefId) drop.delete(team.chiefId);
  if (!drop.size) return team;
  const memberIds = (team.memberIds || []).filter((id) => !drop.has(id));
  // The chief always survives, because the line above removed it from `drop`.
  // This used to read `drop.has(team.chiefId) ? memberIds[0] || null : …`, a
  // promote-the-first-member branch that could never be reached once the chief
  // became unremovable. Kept explicit so it is not re-added as if it ran.
  const chiefId = team.chiefId;
  const leftover = memberIds.filter(Boolean);
  // A lead alone is still a team: they open workers again later, and their
  // channel history must not vanish because the last worker was closed (the
  // rail already shows a one-bot team as just that bot, so nothing twins).
  // Only a team with NO lead dissolves when it drops below two.
  const leadStays = Boolean(chiefId && leftover.includes(chiefId));
  const dissolve = !leftover.length || (!leadStays && leftover.length < 2);
  if (dissolve) {
    await removeTeam(team.id);
    const bots = await store.loadBots();
    for (const b of bots) {
      if (b.teamId === team.id) {
        await store.patchBot(b.id, (row) => {
          row.teamId = "";
          row.teamRole = "";
        });
      }
    }
    return null;
  }
  return saveTeam({ ...team, memberIds, chiefId });
}

/**
 * Drop leftover teams that have no lead: a lone worker whose chief is gone is
 * not a team. A chief-only team is kept on purpose — the lead persists alone
 * and opens workers again later (its channel history survives).
 */
export async function pruneSoloTeams(): Promise<void> {
  const [rows, bots] = await Promise.all([listTeams(), store.loadBots()]);
  for (const t of rows) {
    const leadAlive = Boolean(t.chiefId && bots.some((b) => b.id === t.chiefId && b.teamId === t.id));
    if (leadAlive) continue;
    if (isSoloTeam(t, bots)) {
      await removeTeam(t.id);
      for (const b of bots) {
        if (b.teamId === t.id) {
          await store.patchBot(b.id, (row) => {
            row.teamId = "";
            row.teamRole = "";
          });
        }
      }
    }
  }
}

/**
 * Resolve what a model passed as a teammate reference — the exact bot id, the
 * teammate's name (case-insensitive), or an id prefix — to a member. A lead
 * that wrote bot_id:"Pixel" got "bot not found" and told the user its
 * teammates were unreachable; a name is an unambiguous reference and should
 * just work. Team members are searched first, then every bot.
 */
export function resolveTeammate<T extends { id: string; name?: string | undefined }>(
  ref: unknown,
  members: readonly T[] | null | undefined,
  allBots: readonly T[] | null | undefined = null,
): T | null {
  const want = String(ref || "").trim();
  if (!want) return null;
  const pools = [members || [], allBots || []];
  for (const pool of pools) {
    const exact = pool.find((b) => b.id === want);
    if (exact) return exact;
  }
  const lower = want.toLowerCase();
  for (const pool of pools) {
    const byName = pool.find((b) => String(b.name || "").trim().toLowerCase() === lower);
    if (byName) return byName;
  }
  if (want.length >= 8) {
    for (const pool of pools) {
      const hits = pool.filter((b) => b.id.startsWith(want));
      if (hits.length === 1) return hits[0]!;
    }
  }
  return null;
}

export function mentionedMemberIds(text: unknown, members: readonly TeamMember[] | null | undefined): string[] {
  // `!`: the pattern has exactly one group and it is not optional, so group 1
  // participates in every match this iterator yields.
  const tags = [...String(text || "").matchAll(/@([^\s@.,!?]+)/g)].map((m) => m[1]!.toLowerCase());
  if (!tags.length) return [];
  const ids: string[] = [];
  for (const m of members || []) {
    const name = String(m.name || "").toLowerCase();
    const role = String(m.teamRole || m.role || "").toLowerCase();
    if (tags.some((t) => t === name || t === role || (name && name.startsWith(t)))) ids.push(m.id);
  }
  return [...new Set(ids)];
}

/** The words that wake a member when they appear in a channel message: their
 * own name, their role, and any opted-in keywords. Name/role are matched by the
 * @mention router; this returns the extra keyword set, lowercased. */
/** Default wake keywords for a new teammate, derived from its name (words >=3
 * chars). So a "Pipeline Ops" worker wakes on "pipeline"/"ops" in the channel
 * even without an @mention. Opt-in extra words can be added later. */
/** Park or resume a teammate on the channel. A held worker does not wake on
 * channel @mentions/keywords (routeChannelMessage skips it) until resumed. */
export async function setChannelState(botId: unknown, state: "active" | "hold"): Promise<store.Bot | null> {
  const id = String(botId || "");
  const bot = await store.getBot(id);
  if (!bot) return null;
  (bot as store.Bot & { channelState?: string }).channelState = state;
  await store.upsertBot(bot);
  return bot;
}

/**
 * Route one channel message: everyone sees it (the caller appends it to the
 * shared log); this decides who is WOKEN — gets a turn — so a broadcast does
 * not spin up every teammate. A member wakes when it is addressed: named in
 * the tool's `to` list, or @mentioned in the text (the human's addressing
 * syntax). No keyword matching — the sender says who it wants. Never the
 * author, never a member on hold.
 */
export function routeChannelMessage(
  { authorId, text, members, to }: { authorId?: string | null | undefined; text?: unknown; members?: readonly TeamMember[] | null | undefined; to?: readonly unknown[] | null | undefined },
): { wake: string[]; mentioned: string[] } {
  const roster = members || [];
  const named = (to || []).map((ref) => resolveTeammate(ref, roster)?.id).filter((id): id is string => Boolean(id));
  const mentioned = [...new Set([...named, ...mentionedMemberIds(String(text || ""), roster)])];
  const author = String(authorId || "");
  const held = new Set(roster.filter((m) => m.channelState === "hold").map((m) => m.id));
  const wake = mentioned.filter((id) => id !== author && !held.has(id));
  return { wake, mentioned };
}

export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "running", "done", "blocked", "looping"];

/** `TASK_STATUSES.includes`, as a guard. Same answer as the array test for every input. */
function isTaskStatus(value: unknown): value is TaskStatus {
  const known: readonly string[] = TASK_STATUSES;
  return typeof value === "string" && known.includes(value);
}

export function newJob({ title, steps }: JobSeed = {}): Job {
  const now = Date.now();
  return {
    id: randomUUID(),
    title: String(title || "Job").slice(0, 80),
    createdAt: now,
    updatedAt: now,
    steps: (Array.isArray(steps) ? steps : []).map((s) => normalizeStep(s, now)),
  };
}

function normalizeStep(s: JobStepSeed = {}, now: number = Date.now()): JobStep {
  const status = isTaskStatus(s.status) ? s.status : "pending";
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

export function jobProgress(job: Job | null | undefined): JobProgress {
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

export function findStep(job: Job | null | undefined, { stepId, label, botId }: StepQuery = {}): JobStep | null {
  const steps = job?.steps || [];
  if (stepId) return steps.find((s) => s.id === stepId) || null;
  if (botId) {
    const hits = steps.filter((s) => s.botId === botId);
    if (label) {
      const want = String(label).toLowerCase();
      const named = hits.find((s) => s.label.toLowerCase() === want) || hits.find((s) => s.label.toLowerCase().includes(want));
      if (named) return named;
    }
    // `!`: length is exactly 1, so index 0 is present.
    if (hits.length === 1) return hits[0]!;
    if (hits[0] && !label) return hits[0];
  }
  if (label) {
    const want = String(label).toLowerCase();
    return steps.find((s) => s.label.toLowerCase() === want) || steps.find((s) => s.label.toLowerCase().includes(want)) || null;
  }
  return null;
}

/**
 * Chief `message_teammate` still carries job-bar fields. After a step is
 * done/blocked, a follow-up note used to pass status=running and reopen it,
 * so the next worker reply looked like a fresh report and the chief
 * recompiled instead of relaying the one-liner.
 */
export function statusForExistingStep(current: unknown, requested: unknown): TaskStatus | undefined {
  const want = isTaskStatus(requested) ? requested : undefined;
  const now = String(current || "");
  if ((now === "done" || now === "blocked") && (!want || want === "running" || want === "pending" || want === "looping")) {
    return undefined;
  }
  return want;
}

/** True once the chief has already compiled (Summary is done). Later worker lines are follow-ups to relay. */
export function isChiefFollowUpReport(job: Job | null | undefined): boolean {
  if (!job?.steps?.length) return false;
  if (job.steps.some((s) => isMetaStepLabel(s.label) && s.status === "done")) return true;
  return jobProgress(job).complete;
}

export function applyStepUpdate(
  job: Job | null | undefined,
  patch: StepPatch = {},
): { job: Job | null | undefined; step: JobStep | null } {
  if (!job?.steps) return { job, step: null };
  const step = findStep(job, patch);
  if (!step) return { job, step: null };
  const hasStatus = isTaskStatus(patch.status);
  const next = isTaskStatus(patch.status) ? patch.status : step.status;
  if (hasStatus && next === "running" && (step.status === "running" || step.status === "looping")) {
    step.loopCount = (step.loopCount || 0) + 1;
    step.status = step.loopCount >= 2 ? "looping" : "running";
  } else if (hasStatus) {
    step.status = next;
    if (next === "done" || next === "pending") step.loopCount = 0;
  }
  if (patch.detail != null) step.detail = String(patch.detail).slice(0, 160);
  if (patch.botId) {
    const meta = isMetaStepLabel(step.label);
    for (const s of job.steps) {
      if (s.botId === patch.botId && s.id !== step.id && isMetaStepLabel(s.label) === meta) s.botId = null;
    }
    step.botId = patch.botId;
  }
  step.updatedAt = Date.now();
  job.updatedAt = Date.now();
  return { job, step };
}

export function isMetaStepLabel(label: unknown): boolean {
  return /^(summary|compile(?:d)?(?: list)?|report)$/i.test(String(label || "").trim());
}

export function taskTabName(raw: unknown): string {
  // `!`: String.prototype.split always yields at least one element.
  let s = String(raw || "").split(/[\n.]/)[0]!.replace(/\s+/g, " ").trim();
  s = s.replace(/^(go:\s*|please\s+|find\s+\d*\s*|search(?:\s+the\s+web)?\s+(?:for\s+)?)/i, "");
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  if (s.length > 36) {
    const cut = s.slice(0, 36);
    const sp = cut.lastIndexOf(" ");
    s = (sp > 16 ? cut.slice(0, sp) : cut).trim();
  }
  return s || "";
}

/**
 * Names create_teammate already chose. The job bar used to overwrite
 * "ExampleScout" with the step label ("example.com h1" → "example"), so the
 * sidebar lost the name the chief picked. Only placeholders get auto-named.
 */
export function isGenericWorkerName(name: unknown): boolean {
  const s = String(name || "").trim();
  if (!s) return true;
  if (/^worker(?:\s+\d+)?$/i.test(s)) return true;
  if (/^worker on /i.test(s)) return true;
  return false;
}

export function uniqueMemberName(
  want: unknown,
  members: readonly TeamMember[] | null | undefined,
  selfId: string | null | undefined,
): string {
  const base = taskTabName(want) || String(want || "").trim().slice(0, 32);
  if (!base) return "";
  const taken = new Set(
    (members || []).filter((m) => m.id !== selfId).map((m) => String(m.name || "").toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 20; n++) {
    const cand = `${base.slice(0, 28)} ${n}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return base;
}

export function matchStepForAssignment(job: Job | null | undefined, content: unknown): JobStep | null {
  const t = String(content || "").toLowerCase();
  if (!t || !job?.steps?.length) return null;
  let best: JobStep | null = null;
  let bestScore = 0;
  for (const s of job.steps) {
    if (isMetaStepLabel(s.label)) continue;
    const tokens = String(s.label || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    if (!tokens.length) continue;
    const hits = tokens.filter((w) => t.includes(w)).length;
    if (!hits) continue;
    const score = hits / tokens.length + (s.botId ? 0 : 0.05);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

/** What `nameWorkerForTask` is told about the assignment it is naming for. */
export interface NameWorkerOptions {
  teamId?: string | null | undefined;
  assignment?: unknown;
  setBrief?: boolean | undefined;
}

export async function nameWorkerForTask(
  bot: store.Bot | null | undefined,
  label: unknown,
  { teamId, assignment, setBrief = false }: NameWorkerOptions = {},
): Promise<store.Bot | null | undefined> {
  if (!bot || bot.teamRole === "chief") return bot;
  if (isMetaStepLabel(label)) return bot;
  if (!isGenericWorkerName(bot.name)) return bot;
  const members = teamId ? membersOf(await getTeam(teamId), await store.loadBots()) : [];
  const want = uniqueMemberName(label, members, bot.id);
  if (!want) return bot;
  const brief = setBrief ? String(assignment || label || "").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (bot.name === want && (!brief || bot.description === brief)) return bot;
  const patched = await store.patchBot(bot.id, (b) => {
    b.name = want;
    if (brief) {
      b.description = brief;
      b.instructions = brief;
    }
  });
  return patched || bot;
}

export async function syncJobWorkerNames(team: Team | null | undefined): Promise<store.Bot[]> {
  const renamed: store.Bot[] = [];
  if (!team?.job) return renamed;
  // step.botId arrives from the model through set_job and was never checked
  // against the team, so a step naming a bot on someone ELSE's team renamed
  // that bot. rename_bot and update_bot already refuse exactly this with "that
  // Bot is not on your team" -- this path was a way around the same rule.
  // Foreign ids are obtainable in-band: a channel wake payload carries fromId.
  const memberIds = new Set(membersOf(team, await store.loadBots()).map((m) => m.id));
  for (const step of team.job.steps || []) {
    if (!step.botId || isMetaStepLabel(step.label)) continue;
    if (!memberIds.has(step.botId)) continue;
    const bot = await store.getBot(step.botId);
    if (!bot) continue;
    const before = bot.name;
    const next = await nameWorkerForTask(bot, step.label, { teamId: team.id });
    if (next && next.name !== before) renamed.push(next);
  }
  return renamed;
}

export function jobTitleFromText(text: unknown, fallback: string = "Job"): string {
  const line = String(text || "").split("\n").find((l) => l.trim()) || "";
  const t = line.replace(/^(please|hey|ok[,.]?)\s+/i, "").trim();
  return (t || fallback || "Job").slice(0, 80);
}

/** The named arguments `upsertJobStep` accepts. */
export interface UpsertStepArgs extends StepPatch {
  content?: unknown;
  chiefId?: string | null | undefined;
  title?: unknown;
}

/** Create or extend a team job so the progress bar always has a step for this assignment. */
/**
 * Which of a worker's steps an unlabelled `update_task` is about.
 *
 * Exactly one owned step is unambiguous. With MORE than one and nothing to
 * disambiguate, upsertJobStep used to fall through and CREATE a step — labelled
 * "Task", because there was no label to name it from — on every such update.
 * They accumulated without bound, each one `running`, so maybeFinalizeSummary
 * could never fire and the job could never complete. Worse, the caller was told
 * about a DIFFERENT step (the first the bot owned), so the model saw a
 * plausible answer and never noticed.
 *
 * Pick what the worker is most plausibly reporting on: the step in flight, else
 * the next one waiting, else the most recent. Shared with patchTeamStep so the
 * step reported back is the step actually touched.
 */
export function pickOwnedStep(job: Job | null | undefined, botId: string | null | undefined): JobStep | null {
  if (!job || !botId) return null;
  const owned = (job.steps || []).filter((s) => s.botId === botId && !isMetaStepLabel(s.label));
  if (!owned.length) return null;
  return (
    owned.find((s) => s.status === "running") ||
    owned.find((s) => s.status === "pending") ||
    owned[owned.length - 1] ||
    null
  );
}

export function upsertJobStep(
  job: Job | null | undefined,
  { botId, label, content, status, detail, stepId, chiefId, title }: UpsertStepArgs = {},
): Job {
  const stepLabel = (!isMetaStepLabel(label) && taskTabName(label)) || taskTabName(content) || "Task";
  if (!job) {
    return newJob({
      title: String(title || "Job").slice(0, 80),
      steps: [
        { label: stepLabel, bot_id: botId, status: isTaskStatus(status) ? status : "running", detail },
        { label: "Summary", bot_id: chiefId || null },
      ],
    });
  }
  const hint = [label, content].filter(Boolean).join(" ");
  let step: JobStep | null = null;
  if (stepId || label) step = findStep(job, { stepId, label });
  if (!step) step = matchStepForAssignment(job, hint);
  if (!step && botId) {
    const owned = (job.steps || []).filter((s) => s.botId === botId && !isMetaStepLabel(s.label));
    // ONE owned step is unambiguous whatever the caller said — this is the
    // original fallback, and dropping it was a regression: the stored label is
    // rewritten by taskTabName ("Find flights" -> "flights"), so a worker has no
    // way to know the stored spelling without list_tasks. Rewording its own
    // label then missed findStep AND matchStepForAssignment and invented a
    // second step, leaving the first `pending` forever — exactly the failure
    // this function was being fixed for.
    if (owned.length === 1) step = owned[0]!;
    // More than one, and nothing to disambiguate: pick the one in flight.
    else if (!stepId && !label) step = pickOwnedStep(job, botId);
  }
  if (!step) {
    step = normalizeStep({
      label: stepLabel,
      bot_id: botId,
      status: isTaskStatus(status) ? status : "running",
      detail,
    });
    const i = (job.steps || []).findIndex((s) => isMetaStepLabel(s.label));
    if (i >= 0) job.steps.splice(i, 0, step);
    else job.steps.push(step);
    job.updatedAt = Date.now();
    return job;
  }
  applyStepUpdate(job, {
    stepId: step.id,
    botId,
    ...(isTaskStatus(status) ? { status } : {}),
    ...(detail != null ? { detail } : {}),
  });
  return job;
}

/** What a worker assignment moved: the team, the worker, its step, any rename. */
export interface WorkerAssignment {
  team: Team | null;
  bot: store.Bot | null;
  step: JobStep | null | undefined;
  renamed: store.Bot[];
}

export async function onWorkerAssigned(
  teamId: string,
  workerId: string,
  { label, content, status, detail, stepId, title }: UpsertStepArgs = {},
): Promise<WorkerAssignment> {
  const team = await getTeam(teamId);
  const bot = await store.getBot(workerId);
  if (!team || !bot || bot.teamRole === "chief") return { team, bot, step: null, renamed: [] };
  // A handoff is just a message. It tracks a step only in a job the lead
  // already set up (set_job); it never creates one — that made every "say
  // hello" spawn a job card with a Summary step.
  if (!team.job) return { team, bot, step: null, renamed: [] };
  const existing =
    findStep(team.job, { botId: workerId, label, stepId }) || (team.job ? pickOwnedStep(team.job, workerId) : null);
  const job = upsertJobStep(team.job, {
    botId: workerId,
    label,
    content,
    status: statusForExistingStep(existing?.status, status),
    detail,
    stepId,
    chiefId: team.chiefId,
    title: title || team.name,
  });
  const saved = await saveTeam({ ...team, job });
  // `!`: the line above persisted `job`, a Job, onto this very row.
  const step = findStep(saved.job, { botId: workerId, label }) || saved.job!.steps.find((s) => s.botId === workerId && !isMetaStepLabel(s.label));
  const nameFrom = (step && !isMetaStepLabel(step.label) ? step.label : "") || label || content;
  const before = bot.name;
  const next = await nameWorkerForTask(bot, nameFrom, { teamId, assignment: content || detail, setBrief: true });
  const renamed = next && next.name !== before ? [next] : [];
  return { team: await getTeam(teamId), bot: next || bot, step, renamed };
}

/** When every non-summary step is done/blocked, mark Summary done. No text matching. */
export function maybeFinalizeSummary(job: Job | null | undefined): {
  job: Job | null | undefined;
  finalized: boolean;
} {
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

export async function setTeamJob(teamId: string, spec: JobSeed): Promise<(Team & { renamed: store.Bot[] }) | null> {
  const team = await getTeam(teamId);
  if (!team) return null;
  const job = newJob(spec);
  const saved = await saveTeam({ ...team, job });
  const renamed = await syncJobWorkerNames(saved);
  return { ...saved, renamed };
}

/** Drop a finished (or abandoned) job so the bar can close. The next team message seeds a new one. */
export async function clearTeamJob(teamId: string): Promise<Team | null> {
  const team = await getTeam(teamId);
  if (!team) return null;
  return saveTeam({ ...team, job: null });
}

/** What `patchTeamStep` moved: the saved team, its job, the step, any rename. */
export interface TeamStepPatchResult {
  team: Team;
  job: Job | null | undefined;
  step: JobStep | null;
  renamed: store.Bot[];
}

export async function patchTeamStep(teamId: string, patch: StepPatch): Promise<TeamStepPatchResult | null> {
  // Read, modify and write under one lock — see mutateTeam. Doing this as
  // getTeam-then-saveTeam lost one of two concurrent workers' updates.
  const res = await mutateTeam(teamId, (row) => {
    let job = row.job;
    let step: JobStep | null = null;
    if (isMetaStepLabel(patch.label)) {
      if (!job) return { job: null, step: null, applied: false };
      ({ job, step } = applyStepUpdate(job, patch));
      if (!step) return { job, step: null, applied: false };
    } else {
      // update_task only moves a step in a job that exists; with no job it is a
      // no-op rather than the seed of one (jobs come from set_job).
      if (!job) return { job: null, step: null, applied: false };
      job = upsertJobStep(job, {
        botId: patch.botId,
        label: patch.label,
        status: patch.status,
        detail: patch.detail,
        stepId: patch.stepId,
        chiefId: row.chiefId,
        title: job?.title || row.name,
      });
      step =
        findStep(job, { stepId: patch.stepId, label: patch.label }) ||
        // Same selector upsertJobStep used, so the step reported back is the
        // step actually touched. This used to take the FIRST step the bot
        // owned, which for a worker with two tasks was routinely the wrong one.
        pickOwnedStep(job, patch.botId) ||
        null;
      if (!step) return { job, step: null, applied: false };
    }
    row.job = job;
    return { job, step, applied: true };
  });
  if (!res) return null;
  const team = res.team;
  const { job, step, applied } = res.out;
  if (!applied || !step) return { team, job, step: null, renamed: [] };
  const saved = team;
  const renamed: store.Bot[] = [];
  if (step.botId && !isMetaStepLabel(step.label)) {
    const bot = await store.getBot(step.botId);
    if (bot) {
      const before = bot.name;
      const next = await nameWorkerForTask(bot, step.label, { teamId });
      if (next && next.name !== before) renamed.push(next);
    }
  }
  return { team: saved, job: saved.job, step, renamed };
}
