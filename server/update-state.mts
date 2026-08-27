/**
 * Spec `update_state` wrapper. Delegates to memory, routines, skills, and projects.
 * avatar / settings / channel are not wired.
 */
import path from "node:path";
import * as memory from "./memory.mjs";
import * as routines from "@sub8/automations";
import * as skills from "@sub8/skills";

/**
 * `T`, but with an explicitly-passed `undefined` allowed wherever the field is
 * optional. Under `exactOptionalPropertyTypes` an absent property and one set
 * to `undefined` are different things; the object literals below hand every
 * optional field over explicitly, exactly as they always have.
 */
type Loosened<T> = { [K in keyof T]: T[K] | undefined };

/** A project row, as this file reads one back. Only `slug` is ever used. */
export interface ProjectResult {
  slug?: string | undefined;
}

/** What a memory write hands back. Only `ok` and `text` are read here. */
export interface MemoryResult {
  ok?: boolean | undefined;
  text?: string | undefined;
}

/**
 * The seams `handleUpdateState` can be handed instead of the real modules, so
 * tests do not need a desk.
 *
 * These describe what this module hands each seam, which is not always exactly
 * what the real default accepts — see `pickFn` for the three places the two
 * models differ, and the note on `writeMemoryFile` for the one that can bite.
 *
 * `pickFn` resolves each of these by `hasOwnProperty`, so passing an explicit
 * `undefined` is meaningful: it disables the seam rather than falling back to
 * the module default.
 */
export interface UpdateStateDeps {
  handleMemory?(bot: memory.MemoryBot, args: memory.MemoryArgs): MemoryResult | Promise<MemoryResult>;
  appendFile?(bot: memory.MemoryBot, dest: string, text: string): unknown;
  upsertRoutine?(bot: memory.MemoryBot, spec: Loosened<routines.RoutineSpec>): routines.UpsertResult;
  disableRoutine?(bot: memory.MemoryBot, id: string): unknown;
  writeSkill?(args: skills.WriteSkillArgs): skills.WrittenSkill | Promise<skills.WrittenSkill>;
  deleteSkill?(args: Loosened<skills.DeleteSkillArgs>): skills.DeletedSkill | Promise<skills.DeletedSkill>;
  createProject?(spec: memory.CreateProjectSpec): ProjectResult | Promise<ProjectResult>;
  joinProject?(botId: string, slug: string, opts: memory.JoinOptions): ProjectResult | Promise<ProjectResult>;
  leaveProject?(botId: string, slug: string): ProjectResult | Promise<ProjectResult>;
  writer?: skills.SkillWriter | undefined;
  io?: memory.MemoryIo | undefined;
}

/**
 * One `update_state` call, straight off a tool call. The named fields are the
 * ones the schemas declare as strings/booleans and that this file forwards
 * without coercing; everything else it reads it coerces itself.
 */
export interface UpdateStateArgs {
  target?: unknown;
  action?: unknown;
  id?: string | undefined;
  name?: string | undefined;
  schedule?: unknown;
  group_key?: string | undefined;
  groupKey?: string | undefined;
  enabled?: boolean | undefined;
  confirm?: boolean | undefined;
  [key: string]: unknown;
}

/** What one `update_state` call reports back. `persist` asks the caller to save the bot. */
export interface UpdateStateResult {
  ok: boolean;
  text: string;
  persist: boolean;
  [key: string]: unknown;
}

export const UPDATE_STATE_TARGETS = Object.freeze([
  "memory",
  "routine",
  "skill",
  "profile",
  "settings",
  "project",
  "avatar",
  "channel",
]);

export const UPDATE_STATE_ACTIONS = Object.freeze({
  memory: Object.freeze(["write", "forget"]),
  routine: Object.freeze(["create", "update", "pause", "resume", "delete"]),
  skill: Object.freeze(["write", "delete"]),
  profile: Object.freeze(["set"]),
  settings: Object.freeze(["set"]),
  project: Object.freeze(["create", "join", "leave"]),
  avatar: Object.freeze(["set", "clear"]),
  channel: Object.freeze(["disconnect"]),
});

const UNWIRED = new Set(["settings", "avatar", "channel"]);

function ym(ts: number = Date.now()): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The injected dep if the key is present — an explicit `undefined` counts, and
 * disables the seam — else the module default.
 *
 * `fallback` is `unknown` and asserted back on the way out. The three real
 * defaults are each a shade off the seams declared above in ways
 * `exactOptionalPropertyTypes` cannot reconcile, and none of the three is a
 * runtime difference:
 *   - `memory.appendFile` demands a bot that already HAS a desk container;
 *   - `@sub8/automations`'s `RoutineSpec` declares its optional fields without
 *     `| undefined`, and the spec built below hands every one of them over
 *     explicitly;
 *   - `skills.deleteSkill` declares `confirm?: boolean`, and this file forwards
 *     `boolean | undefined` into it.
 * Injected deps and every call below are still checked against the seams.
 */
function pickFn<K extends keyof UpdateStateDeps>(
  deps: UpdateStateDeps | null | undefined,
  key: K,
  fallback: unknown,
): UpdateStateDeps[K] | null {
  if (deps && Object.prototype.hasOwnProperty.call(deps, key)) return deps[key];
  return fallback as UpdateStateDeps[K] | null;
}

function firstString(args: UpdateStateArgs | null | undefined, keys: readonly string[]): string {
  for (const key of keys) {
    const v = args?.[key];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function fail(text: unknown): UpdateStateResult {
  return { ok: false, text: String(text), persist: false };
}

function ok(text: unknown, extra: Record<string, unknown> = {}): UpdateStateResult {
  return { ok: true, text: String(text), persist: false, ...extra };
}

/** Desk path for memory write/forget from scope + tier, or an explicit path. */
export function resolveStateMemoryPath(bot: memory.MemoryBot, args: UpdateStateArgs = {}): string {
  const explicit = String(args.path || "").trim();
  if (explicit) return memory.resolveMemoryPath(bot, explicit);
  if (!bot?.id) throw new Error("bot id required");
  const scope = String(args.scope || "agent").trim().toLowerCase();
  const tier = String(args.tier || "note").trim().toLowerCase();
  const paths = memory.layoutPaths(bot);
  if (scope === "user") {
    if (tier === "profile") return paths.userMemoryProfile;
    if (tier === "log") return `${paths.userMemoryDir}/log/${ym()}.md`;
    if (tier !== "note") throw new Error("tier must be profile, log, or note");
    return `${paths.userMemoryDir}/notes.md`;
  }
  if (scope === "project") {
    const slug = firstString(args, ["slug", "project", "project_slug"]);
    if (!slug) throw new Error("project slug required");
    const shard = memory.projectLayoutPaths(slug, bot.id);
    if (tier === "profile") return shard.shardProfile;
    if (tier === "log") return `${shard.shardDir}/log/${ym()}.md`;
    if (tier !== "note") throw new Error("tier must be profile, log, or note");
    return `${shard.shardDir}/notes.md`;
  }
  if (scope !== "agent") throw new Error("scope must be agent, user, or project");
  if (tier === "profile") return paths.memoryProfile;
  if (tier === "log") return `${paths.memoryLog}/${ym()}.md`;
  if (tier !== "note") throw new Error("tier must be profile, log, or note");
  return `${paths.root}/memory/notes.md`;
}

function findRoutine(bot: memory.MemoryBot, id: unknown): memory.MemoryRoutine {
  const rid = String(id || "").trim();
  if (!rid) throw new Error("id required");
  const r = (bot.routines || []).find((x) => x.id === rid);
  if (!r) throw new Error("routine not found");
  return r;
}

/**
 * NOTE — unchanged behaviour, but worth knowing: the `appendFile` branch is
 * only reached when a caller passes `handleMemory: undefined` explicitly. The
 * module default `memory.handleMemory` checks `hasVm` first; `memory.appendFile`
 * does not, and reads `bot.vm.container` outright. So a caller that disables
 * `handleMemory` without also injecting `appendFile` would crash here on a bot
 * with no desk. Every in-tree caller that disables the one injects the other.
 */
async function writeMemoryFile(
  bot: memory.MemoryBot,
  dest: string,
  content: string,
  deps: UpdateStateDeps | null | undefined,
): Promise<MemoryResult> {
  const handleMemoryFn = pickFn(deps, "handleMemory", memory.handleMemory);
  if (typeof handleMemoryFn === "function") {
    return handleMemoryFn(bot, { action: "write", path: dest, content });
  }
  const appendFileFn = pickFn(deps, "appendFile", memory.appendFile);
  if (typeof appendFileFn === "function") {
    await appendFileFn(bot, dest, content);
    return { ok: true, text: `appended ${dest}` };
  }
  throw new Error("memory write is unavailable");
}

async function handleMemoryTarget(
  bot: memory.MemoryBot,
  action: string,
  args: UpdateStateArgs,
  deps: UpdateStateDeps,
): Promise<UpdateStateResult> {
  const dest = resolveStateMemoryPath(bot, args);
  if (action === "forget") {
    const r = await writeMemoryFile(bot, dest, "", deps);
    return { ok: r?.ok !== false, text: r?.text || `forgot ${dest}`, persist: false, path: dest };
  }
  if (action !== "write") throw new Error(`unknown action ${action} for target memory`);
  const content = args.content != null ? String(args.content) : args.text != null ? String(args.text) : "";
  if (!String(args.content ?? args.text ?? "").length) throw new Error("content required");
  const r = await writeMemoryFile(bot, dest, content, deps);
  return { ok: r?.ok !== false, text: r?.text || `wrote ${dest}`, persist: false, path: dest };
}

async function handleRoutineTarget(
  bot: memory.MemoryBot,
  action: string,
  args: UpdateStateArgs,
  deps: UpdateStateDeps,
): Promise<UpdateStateResult> {
  if (!bot.routines) bot.routines = [];
  const upsert = pickFn(deps, "upsertRoutine", routines.upsertRoutine);
  if (action === "create" || action === "update") {
    const instruction = firstString(args, ["instruction", "prompt", "content"]);
    if (action === "create" && !instruction) throw new Error("instruction required");
    if (action === "update" && !String(args.id || "").trim()) throw new Error("id required");
    const minutes = Number(args.interval_minutes);
    const spec = {
      id: action === "update" ? args.id : args.id || undefined,
      name: args.name,
      instruction,
      intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
      schedule: args.schedule,
      groupKey: args.group_key || args.groupKey || undefined,
      forceNew: action === "create",
      forceReplace: action === "update" || args.force_replace === true,
      replace: args.replace !== false,
      enabled: args.enabled,
    };
    if (typeof upsert !== "function") throw new Error("routines.upsert is unavailable");
    const { routine, merged, rejected } = upsert(bot, spec);
    if (rejected && !routine) return fail(rejected);
    if (rejected) {
      return { ok: false, text: rejected, persist: true, routine, merged };
    }
    const verb = merged ? "Updated" : "Created";
    return {
      ok: true,
      // `!`: every `routine: null` result `upsertRoutine` can return carries a
      // `rejected` reason, and both `rejected` branches have already returned.
      text: `${verb} "${routine!.name}" (${routine!.id})`,
      persist: true,
      routine,
      merged,
    };
  }
  const r = findRoutine(bot, args.id);
  if (action === "pause") {
    const disable = pickFn(deps, "disableRoutine", null);
    if (typeof disable === "function") await disable(bot, r.id);
    else r.enabled = false;
    r.updatedAt = Date.now();
    return { ok: true, text: `paused ${r.name}`, persist: true, routine: r };
  }
  if (action === "resume") {
    r.enabled = true;
    r.updatedAt = Date.now();
    return { ok: true, text: `resumed ${r.name}`, persist: true, routine: r };
  }
  if (action === "delete") {
    bot.routines = bot.routines.filter((x) => x.id !== r.id);
    return { ok: true, text: `deleted ${r.name}`, persist: true, id: r.id };
  }
  throw new Error(`unknown action ${action} for target routine`);
}

async function defaultSkillWriter(bot: memory.MemoryBot): Promise<skills.SkillWriterFn> {
  const box = bot?.vm?.container;
  // `!`: `||` short-circuits, so this half only runs when `box` is truthy —
  // which is exactly when `bot.vm` is there to read `status` off.
  if (!box || bot.vm!.status === "missing") throw new Error("Computer is not running yet.");
  const vm = await import("./vm.mjs");
  return async (dest, text) => {
    if (text == null) {
      // `as`: `box` is truthy, so this bot has a container — but narrowing
      // `bot.vm.container` narrows that property, not the type of `bot`, which
      // is what `vm.shell` asks for. Same object either way.
      await vm.shell(bot as memory.DeskMemoryBot, `rm -f ${JSON.stringify(dest)}`);
      return;
    }
    await vm.mkdirpInContainer(box, path.posix.dirname(dest));
    await vm.writeFileToContainer(box, dest, text);
  };
}

async function handleSkillTarget(
  bot: memory.MemoryBot,
  action: string,
  args: UpdateStateArgs,
  deps: UpdateStateDeps,
): Promise<UpdateStateResult> {
  const writer = deps.writer || (await defaultSkillWriter(bot));
  if (action === "write") {
    // `!`: `pickFn` yields null/undefined only for `writeSkill: undefined`
    // passed explicitly, which threw right here before this file had types.
    const writeSkillFn = pickFn(deps, "writeSkill", skills.writeSkill)!;
    const row = await writeSkillFn({
      id: args.id || args.skill_id,
      name: args.name,
      description: args.description,
      body: args.body ?? args.content ?? "",
      writer,
    });
    return ok(`wrote skill ${row.id}`, { skill: row });
  }
  if (action === "delete") {
    // `!`: same as `writeSkill` above.
    const deleteSkillFn = pickFn(deps, "deleteSkill", skills.deleteSkill)!;
    const row = await deleteSkillFn({
      id: args.id || args.skill_id,
      writer,
      confirm: args.confirm,
    });
    return ok(`deleted skill ${row.id}`, { skill: row });
  }
  throw new Error(`unknown action ${action} for target skill`);
}

function handleProfileTarget(bot: memory.MemoryBot, action: string, args: UpdateStateArgs): UpdateStateResult {
  if (action !== "set") throw new Error(`unknown action ${action} for target profile`);
  const name = args.name != null ? String(args.name).trim() : "";
  const hasDesc = args.description != null;
  if (!name && !hasDesc) throw new Error("name or description required");
  if (name) bot.name = name;
  if (hasDesc) bot.description = String(args.description);
  return { ok: true, text: `updated profile ${bot.name || ""}`.trim(), persist: true };
}

async function handleProjectTarget(
  bot: memory.MemoryBot,
  action: string,
  args: UpdateStateArgs,
  deps: UpdateStateDeps,
): Promise<UpdateStateResult> {
  const slug = firstString(args, ["slug", "project", "project_slug", "id"]);
  const name = args.name != null ? String(args.name).trim() : "";
  const description = typeof args.description === "string" ? args.description : undefined;
  if (action === "create") {
    if (!name && !slug) throw new Error("name or slug required");
    // `!`: `pickFn` yields null/undefined only for `createProject: undefined`
    // passed explicitly, which threw right here before this file had types.
    const createProjectFn = pickFn(deps, "createProject", memory.createProject)!;
    const row = await createProjectFn({ name, description, slug: slug || undefined });
    return ok(`created project ${row?.slug || slug || name}`, { project: row });
  }
  if (!slug) throw new Error("slug required");
  const botId = bot?.id;
  if (action === "join") {
    // `!`: same as `createProject` above.
    const joinProjectFn = pickFn(deps, "joinProject", memory.joinProject)!;
    const row = await joinProjectFn(botId, slug, {
      name,
      description,
      bot,
      io: deps.io,
    });
    return ok(`joined ${row?.slug || slug}`, { project: row });
  }
  if (action === "leave") {
    // `!`: same as `createProject` above.
    const leaveProjectFn = pickFn(deps, "leaveProject", memory.leaveProject)!;
    const row = await leaveProjectFn(botId, slug);
    return ok(`left ${row?.slug || slug}`, { project: row });
  }
  throw new Error(`unknown action ${action} for target project`);
}

/**
 * Apply one `update_state` call. `deps` injects memory/routines/skills/project
 * helpers and a skill `writer` so tests do not need a desk.
 */
export async function handleUpdateState(
  bot: memory.MemoryBot | null | undefined,
  args: UpdateStateArgs = {},
  deps: UpdateStateDeps = {},
): Promise<UpdateStateResult> {
  try {
    if (!bot) return fail("bot required");
    const target = String(args.target || "").trim().toLowerCase();
    if (!target) return fail("target required");
    const action = String(args.action || "").trim().toLowerCase();
    if (!action) return fail("action required");
    if (UNWIRED.has(target)) return fail(`${target} is not wired`);
    if (!UPDATE_STATE_TARGETS.includes(target)) return fail(`unknown target ${target}`);
    if (target === "memory") return await handleMemoryTarget(bot, action, args, deps);
    if (target === "routine") return await handleRoutineTarget(bot, action, args, deps);
    if (target === "skill") return await handleSkillTarget(bot, action, args, deps);
    if (target === "profile") return handleProfileTarget(bot, action, args);
    if (target === "project") return await handleProjectTarget(bot, action, args, deps);
    return fail(`unknown target ${target}`);
  } catch (err) {
    return fail((err as Error | undefined)?.message || err);
  }
}
