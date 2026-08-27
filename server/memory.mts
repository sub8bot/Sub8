import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./paths.mjs";
import * as store from "@sub8/store";
import * as vm from "./vm.mjs";
import { cadenceLabel, type Routine } from "@sub8/automations";

/** A routine plus the rolling run log @sub8/automations does not model. */
export type MemoryRoutine = Routine & { runs?: { ts?: number }[] };

/**
 * As much of a bot's computer as this file reads. `container` carries no explicit
 * `| undefined` for the same reason vm.mts's `VmInfo` does not: the wider type
 * loses assignability to `DeskBot` under exactOptionalPropertyTypes.
 */
export interface MemoryBotVm {
  container?: string;
  status?: string | undefined;
  deskUrl?: string | undefined;
}

/** As much of a bot as this file reads. Callers pass the whole row, which is wider. */
export interface MemoryBot {
  id: string;
  name?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  teamRole?: string | undefined;
  teamId?: string | undefined;
  vm?: MemoryBotVm | undefined;
  routines?: MemoryRoutine[] | undefined;
}

/** What `hasVm` proves: a computer of its own, with a container to write into. */
export type DeskMemoryBot = MemoryBot & { vm: MemoryBotVm & { container: string } };

/**
 * The three container calls this file makes. `vm` is the default; tests and
 * `joinProject` pass a fake. Written as methods so the real `vm` module, whose
 * `container` parameter is a plain `string`, still satisfies it — `box` is
 * `undefined` when `ensureProjectLayout` runs against a fake io and no computer.
 */
export interface MemoryIo {
  mkdirpInContainer(container: string | undefined, dir: string): Promise<void>;
  readFileFromContainer(container: string | undefined, dest: string): Promise<string>;
  writeFileToContainer(container: string | undefined, dest: string, text: string): Promise<void>;
}

/** Desk identity, as `profile.json` holds it. */
export interface ProfileRecord {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  teamRole: string;
}

/** One memory layer: a fact table, a note, or nothing. */
export type MemoryLayer = string | Record<string, unknown> | null | undefined;

/** `mergeMemoryPrecedence` input. `own` and `userMemory` are the older spellings. */
export interface MemoryParts {
  agent?: MemoryLayer;
  project?: MemoryLayer;
  user?: MemoryLayer;
  own?: MemoryLayer;
  userMemory?: MemoryLayer;
  "user-memory"?: MemoryLayer;
}

/** One row of `data/projects.json`: host membership, never desk content. */
export interface ProjectRow {
  slug: string;
  name: string;
  description: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Name and description for a project's `project.md`. */
export interface ProjectMeta {
  name?: string | undefined;
  description?: string | undefined;
}

/** `createProject` takes the slug too, so a caller can name the folder itself. */
export interface CreateProjectSpec extends ProjectMeta {
  slug?: string | undefined;
}

/** `joinProject`: metadata, plus the desk to seed the project layout on. */
export interface JoinOptions extends ProjectMeta {
  bot?: MemoryBot | undefined;
  io?: MemoryIo | undefined;
}

/** The `memory` tool's arguments, straight off a tool call. */
export interface MemoryArgs {
  action?: string | undefined;
  path?: string | undefined;
  content?: string | undefined;
}

const orchPathsHref = new URL("../packages/orchestration/dist/paths.js", import.meta.url);
const orch = existsSync(fileURLToPath(orchPathsHref)) ? await import(orchPathsHref.href) : null;

/** Packaged Electron may omit `packages/`; home stays `/config`. */
export const AGENT_DATA_ROOT: string = orch?.AGENT_DATA_ROOT || "/config/agent-data";
export const agentDir: (id: string) => string = orch?.agentDir || ((id) => `${AGENT_DATA_ROOT}/agents/${id}`);

export function agentRoot(bot: MemoryBot): string {
  return agentDir(bot.id);
}

export function slug(text: unknown): string {
  const s = String(text || "job")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "job";
}

export function resolveMemoryPath(bot: MemoryBot, raw: unknown): string {
  const p = String(raw || "").trim();
  if (!p) throw new Error("path required");
  const abs = p.startsWith("/") ? p : path.posix.join(agentRoot(bot), p);
  const n = path.posix.normalize(abs);
  if (n.includes("..") || n === "/" || n === "/config") throw new Error("invalid path");
  const ok =
    n === "/config/workspace" ||
    n.startsWith("/config/workspace/") ||
    n === AGENT_DATA_ROOT ||
    n.startsWith(`${AGENT_DATA_ROOT}/`);
  if (!ok) throw new Error("path must be under /config/agent-data or /config/workspace");
  return n;
}

export function layoutPaths(bot: MemoryBot) {
  const root = agentRoot(bot);
  const memoryLog = `${root}/memory/log`;
  const automations = `${root}/automations`;
  const userMemoryDir = `${AGENT_DATA_ROOT}/user-memory/by-agent/${bot.id}`;
  const workflows = `${AGENT_DATA_ROOT}/workflows`;
  const projects = `${AGENT_DATA_ROOT}/projects`;
  const workspace = "/config/workspace";
  return {
    root,
    profileJson: `${root}/profile.json`,
    memoryProfile: `${root}/memory/profile.md`,
    memoryLog,
    automations,
    userMemoryDir,
    userMemoryProfile: `${userMemoryDir}/profile.md`,
    workflows,
    projects,
    workspace,
    dirs: [memoryLog, automations, userMemoryDir, workflows, projects, workspace],
  };
}

/** Host membership. Desk files live under `/config/agent-data/projects/<slug>/`. */
export const projectsPath = path.join(dataDir, "projects.json");

/** Highest first: own agent memory → project memory → shared user-memory. */
export const MEMORY_PRECEDENCE = Object.freeze(["agent", "project", "user"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function projectSlug(text: unknown): string {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!s) throw new Error("invalid project slug");
  return s;
}

export function projectDir(raw: unknown): string {
  return `${AGENT_DATA_ROOT}/projects/${projectSlug(raw)}`;
}

export function projectMdPath(raw: unknown): string {
  return `${projectDir(raw)}/project.md`;
}

export function projectMemoryShard(raw: unknown, botId: unknown): string {
  const id = String(botId || "").trim();
  if (!id) throw new Error("bot id required");
  return `${projectDir(raw)}/memory/by-agent/${id}`;
}

export function projectLayoutPaths(raw: unknown, botId?: string | undefined) {
  const root = projectDir(raw);
  const shardDir = botId ? projectMemoryShard(raw, botId) : "";
  return {
    root,
    projectMd: `${root}/project.md`,
    memoryDir: `${root}/memory`,
    shardsDir: `${root}/memory/by-agent`,
    shardDir,
    shardProfile: shardDir ? `${shardDir}/profile.md` : "",
  };
}

function titleFromSlug(s: string): string {
  return String(s || "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(" ");
}

function yamlScalar(value: unknown): string {
  const s = String(value ?? "");
  if (s === "") return '""';
  if (/^[A-Za-z0-9][A-Za-z0-9 _.'-]*$/.test(s) && s === s.trim()) return s;
  return JSON.stringify(s);
}

function parseBotId(value: unknown): string {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!UUID_RE.test(s)) throw new Error("membership is by UUID, not display name");
  return s;
}

function ym(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function iso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

export function seedProfile(bot: MemoryBot): string {
  const title = String(bot?.title || "").trim();
  const desc = String(bot?.description || "").trim();
  return [
    `# ${bot?.name || "Bot"}`,
    title ? `${title}` : "",
    desc ? `\n${desc}` : "",
    "",
    "Lasting facts I should remember go here. Update this file when something should persist across turns.",
    "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export function seedProjectMd({ name, description }: ProjectMeta = {}): string {
  const title = String(name || "").trim() || "Project";
  const desc = String(description ?? "").trim();
  const lines = ["---", `name: ${yamlScalar(title)}`, `description: ${yamlScalar(desc)}`, "---", ""];
  if (desc) lines.push(desc, "");
  lines.push("Shared project memory. Each assistant writes only in `memory/by-agent/<its-id>/`.", "");
  return lines.join("\n");
}

export function parseProjectMd(text: unknown) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  // Both groups always participate when this pattern matches, so `m[1]`/`m[2]`
  // and the one group in `pick` are strings whenever the match is not null.
  const fm = m ? m[1]! : "";
  const body = (m ? m[2]! : raw).trim();
  const pick = (key: string): string => {
    const hit = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!hit) return "";
    const v = hit[1]!.trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        return JSON.parse(v);
      } catch {
        return v.slice(1, -1);
      }
    }
    return v;
  };
  return { name: pick("name"), description: pick("description"), body };
}

function asFacts(layer: MemoryLayer): Record<string, unknown> {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return {};
  return { ...layer };
}

function asText(layer: MemoryLayer): string {
  if (layer == null || layer === "") return "";
  if (typeof layer === "string") return layer.trim();
  if (typeof layer === "object" && !Array.isArray(layer)) {
    return Object.entries(layer)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
  }
  return String(layer);
}

/**
 * Merge memory layers. Precedence (highest first): own agent memory → project memory → user-memory.
 * `parts` is `{ agent, project, user }` (aliases: `own`, `userMemory` / `user-memory`)
 * or `[agent, project, user]`. Object layers overlay so agent keys win; strings concatenate in precedence order.
 */
export function mergeMemoryPrecedence(parts: MemoryParts | MemoryLayer[] = {}) {
  const src: MemoryParts = Array.isArray(parts)
    ? { agent: parts[0], project: parts[1], user: parts[2] }
    : parts && typeof parts === "object"
      ? parts
      : {};
  const agent = src.agent ?? src.own ?? "";
  const project = src.project ?? "";
  const user = src.user ?? src.userMemory ?? src["user-memory"] ?? "";
  const facts = { ...asFacts(user), ...asFacts(project), ...asFacts(agent) };
  const text = [asText(agent), asText(project), asText(user)].filter(Boolean).join("\n\n");
  return {
    precedence: [...MEMORY_PRECEDENCE],
    layers: { agent, project, user },
    facts,
    text,
  };
}

function hasVm(bot: MemoryBot): bot is DeskMemoryBot {
  if (bot?.vm?.deskUrl) return false;
  // `&&` only reaches the right-hand side once `bot.vm.container` was truthy,
  // which is exactly when `bot.vm` is set.
  return Boolean(bot?.vm?.container) && bot.vm!.status !== "missing";
}

/** Desk identity. Host `bots.json` is an index (id, vm, team, harness, messages). */
export function profileRecord(bot: MemoryBot): ProfileRecord {
  return {
    id: bot?.id || "",
    name: bot?.name || "Bot",
    title: bot?.title || "",
    description: bot?.description || "",
    instructions: typeof bot?.instructions === "string" ? bot.instructions : "",
    teamRole: bot?.teamRole || "",
  };
}

export function applyProfile(bot: MemoryBot, rec: Partial<ProfileRecord> | null | undefined): MemoryBot {
  if (!bot || !rec || typeof rec !== "object") return bot;
  if (rec.id && String(rec.id) !== String(bot.id)) return bot;
  if (typeof rec.name === "string" && rec.name.trim()) bot.name = rec.name.trim();
  if (typeof rec.title === "string") bot.title = rec.title;
  if (typeof rec.description === "string") bot.description = rec.description;
  if (typeof rec.instructions === "string") bot.instructions = rec.instructions;
  if (rec.teamRole === "chief" || rec.teamRole === "worker") bot.teamRole = rec.teamRole;
  return bot;
}

export async function writeProfile(bot: MemoryBot, io: MemoryIo = vm): Promise<ProfileRecord | null> {
  if (!hasVm(bot)) return null;
  const rec = profileRecord(bot);
  await io.writeFileToContainer(bot.vm.container, layoutPaths(bot).profileJson, `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

export async function hydrateFromProfile(bot: MemoryBot, io: MemoryIo = vm): Promise<MemoryBot> {
  if (!hasVm(bot)) return bot;
  const raw = await io.readFileFromContainer(bot.vm.container, layoutPaths(bot).profileJson);
  if (!String(raw || "").trim()) return bot;
  try {
    applyProfile(bot, JSON.parse(raw));
  } catch {
    /* keep host index */
  }
  return bot;
}

export async function reconcileProfile(bot: MemoryBot, io: MemoryIo = vm): Promise<ProfileRecord | null> {
  if (!hasVm(bot)) return null;
  const raw = await io.readFileFromContainer(bot.vm.container, layoutPaths(bot).profileJson);
  if (String(raw || "").trim()) {
    try {
      applyProfile(bot, JSON.parse(raw));
      return profileRecord(bot);
    } catch {
      /* rewrite */
    }
  }
  return writeProfile(bot, io);
}

async function writeIfMissing(
  container: string | undefined,
  dest: string,
  text: string,
  io: MemoryIo = vm,
): Promise<boolean> {
  const cur = await io.readFileFromContainer(container, dest);
  if (String(cur || "").trim()) return false;
  await io.writeFileToContainer(container, dest, text);
  return true;
}

export async function ensureLayout(bot: MemoryBot, io: MemoryIo = vm): Promise<string | null> {
  if (!hasVm(bot)) return null;
  const box = bot.vm.container;
  const paths = layoutPaths(bot);
  for (const dir of paths.dirs) await io.mkdirpInContainer(box, dir);
  await writeIfMissing(box, paths.memoryProfile, seedProfile(bot), io);
  await reconcileProfile(bot, io);
  await writeIfMissing(
    box,
    paths.userMemoryProfile,
    `# ${bot.name || "Bot"}\n\nShared facts every assistant on this computer should know.\n`,
    io,
  );
  for (const r of bot.routines || []) {
    if (!r?.id) continue;
    const dir = `${paths.automations}/${slug(r.name || r.id)}`;
    await io.mkdirpInContainer(box, dir);
    await writeIfMissing(
      box,
      `${dir}/automation.json`,
      `${JSON.stringify(
        {
          id: r.id,
          name: r.name || "Routine",
          cadence: cadenceLabel(r),
          instruction: String(r.instruction || "").slice(0, 4000),
        },
        null,
        2,
      )}\n`,
      io,
    );
    await writeIfMissing(box, `${dir}/runs.jsonl`, "", io);
  }
  return paths.root;
}

export async function ensureProjectLayout(
  bot: MemoryBot,
  slug: unknown,
  io: MemoryIo = vm,
  meta: ProjectMeta = {},
) {
  if (!hasVm(bot) && io === vm) return null;
  const box = bot?.vm?.container;
  const p = projectLayoutPaths(slug, bot?.id);
  for (const dir of [p.root, p.memoryDir, p.shardsDir, p.shardDir].filter(Boolean)) {
    await io.mkdirpInContainer(box, dir);
  }
  const name = String(meta.name || "").trim() || titleFromSlug(projectSlug(slug));
  const description = typeof meta.description === "string" ? meta.description : "";
  await writeIfMissing(box, p.projectMd, seedProjectMd({ name, description }), io);
  if (p.shardProfile) {
    await writeIfMissing(
      box,
      p.shardProfile,
      `# ${bot?.name || "Bot"}\n\nProject facts this assistant should remember here.\n`,
      io,
    );
  }
  return p;
}

let projectWriteChain: Promise<void> = Promise.resolve();
function withProjectsFile<T>(fn: () => Promise<T>): Promise<T> {
  const run = projectWriteChain.then(
    () => store.withFileLock(`${projectsPath}.lock`, fn),
    () => store.withFileLock(`${projectsPath}.lock`, fn),
  );
  projectWriteChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function persistProject(row: ProjectRow): ProjectRow {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description || "",
    memberIds: [...row.memberIds],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeProject(raw: Partial<ProjectRow> | null | undefined): ProjectRow {
  let s = "";
  try {
    s = projectSlug(raw?.slug || raw?.name);
  } catch {
    s = "";
  }
  const memberIds = [];
  const seen = new Set();
  for (const value of Array.isArray(raw?.memberIds) ? raw.memberIds : []) {
    const id = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    memberIds.push(id);
  }
  return {
    slug: s,
    name: String(raw?.name || "").trim() || titleFromSlug(s) || "Project",
    description: typeof raw?.description === "string" ? raw.description : "",
    memberIds,
    createdAt: Number(raw?.createdAt) || 0,
    updatedAt: Number(raw?.updatedAt) || 0,
  };
}

function withProjectPaths(row: ProjectRow) {
  const slug = row.slug;
  return {
    ...persistProject(row),
    dir: projectDir(slug),
    projectMd: projectMdPath(slug),
    shardsDir: `${projectDir(slug)}/memory/by-agent`,
  };
}

async function readProjects(): Promise<ProjectRow[]> {
  try {
    const rows = JSON.parse(await fs.readFile(projectsPath, "utf8"));
    if (!Array.isArray(rows)) throw new Error("projects.json is not an array");
    return rows.map((row) => persistProject(normalizeProject(row))).filter((row) => row.slug);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeProjects(rows: ProjectRow[]): Promise<ProjectRow[]> {
  await fs.mkdir(dataDir, { recursive: true });
  await store.writeJsonAtomic(projectsPath, rows);
  return rows;
}

export async function listProjects() {
  return withProjectsFile(async () => (await readProjects()).map((row) => withProjectPaths(normalizeProject(row))));
}

export async function getProject(slug: unknown) {
  const s = projectSlug(slug);
  return (await listProjects()).find((p) => p.slug === s) || null;
}

export async function listJoinedProjects(botId: unknown) {
  const id = parseBotId(botId);
  return (await listProjects()).filter((p) => p.memberIds.includes(id));
}

export async function createProject({ name, description, slug: rawSlug }: CreateProjectSpec = {}) {
  const title = String(name || "").trim();
  const s = projectSlug(rawSlug || title);
  return withProjectsFile(async () => {
    const rows = await readProjects();
    if (rows.some((p) => p.slug === s)) throw new Error("project exists");
    const now = Date.now();
    const row = persistProject({
      slug: s,
      name: title || titleFromSlug(s) || "Project",
      description: typeof description === "string" ? description : "",
      memberIds: [],
      createdAt: now,
      updatedAt: now,
    });
    rows.push(row);
    await writeProjects(rows);
    return withProjectPaths(row);
  });
}

export async function joinProject(botId: unknown, slug: unknown, opts: JoinOptions = {}) {
  const id = parseBotId(botId);
  const s = projectSlug(slug);
  const name = String(opts.name ?? "").trim();
  const description = typeof opts.description === "string" ? opts.description : undefined;
  const row = await withProjectsFile(async () => {
    const rows = await readProjects();
    const now = Date.now();
    let i = rows.findIndex((p) => p.slug === s);
    if (i < 0) {
      rows.push(
        persistProject({
          slug: s,
          name: name || titleFromSlug(s) || "Project",
          description: description || "",
          memberIds: [id],
          createdAt: now,
          updatedAt: now,
        }),
      );
      i = rows.length - 1;
    } else {
      const cur = normalizeProject(rows[i]);
      if (!cur.memberIds.includes(id)) cur.memberIds.push(id);
      if (name) cur.name = name;
      if (description !== undefined) cur.description = description;
      cur.updatedAt = now;
      rows[i] = persistProject(cur);
    }
    await writeProjects(rows);
    return normalizeProject(rows[i]);
  });
  if (opts.io && opts.bot) {
    await ensureProjectLayout(opts.bot, s, opts.io, { name: row.name, description: row.description });
  }
  return {
    ...withProjectPaths(row),
    shardDir: projectMemoryShard(s, id),
  };
}

export async function leaveProject(botId: unknown, slug: unknown) {
  const id = parseBotId(botId);
  const s = projectSlug(slug);
  return withProjectsFile(async () => {
    const rows = await readProjects();
    const i = rows.findIndex((p) => p.slug === s);
    if (i < 0) throw new Error("project not found");
    const cur = normalizeProject(rows[i]);
    cur.memberIds = cur.memberIds.filter((m) => m !== id);
    cur.updatedAt = Date.now();
    rows[i] = persistProject(cur);
    await writeProjects(rows);
    return withProjectPaths(cur);
  });
}

export async function digest(bot: MemoryBot, { max = 1400 }: { max?: number | undefined } = {}): Promise<string> {
  if (!hasVm(bot)) return "";
  try {
    await ensureLayout(bot);
    const box = bot.vm.container;
    const root = agentRoot(bot);
    const profile = await vm.readFileFromContainer(box, `${root}/memory/profile.md`);
    const log = await vm.readFileFromContainer(box, `${root}/memory/log/${ym()}.md`);
    const logTail = String(log || "")
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n");
    let runs = "";
    for (const r of (bot.routines || []).slice(0, 4)) {
      const raw = await vm.readFileFromContainer(box, `${root}/automations/${slug(r.name || r.id)}/runs.jsonl`);
      const last = String(raw || "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-2);
      if (last.length) runs += `\n${r.name}:\n${last.join("\n")}`;
    }
    const body = [`## ${bot.name || "Bot"}`, String(profile || "").trim(), logTail ? `\nRecent log:\n${logTail}` : "", runs]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (body.length <= max) return body;
    return `${body.slice(0, max).trim()}\n…`;
  } catch {
    return "";
  }
}

export async function promptBlock(bot: MemoryBot): Promise<string> {
  const root = agentRoot(bot);
  const facts = await digest(bot);
  const lines = [
    "",
    "## Memory on my computer",
    "Durable notes live on this disk (not an API, not curl). Home is `/config`.",
    `- Lasting facts: \`${root}/memory/profile.md\``,
    `- Dated history: \`${root}/memory/log/${ym()}.md\``,
    `- Shared facts: \`${AGENT_DATA_ROOT}/user-memory/by-agent/${bot.id}/profile.md\``,
    "- Working files: `/config/workspace/`",
    bot?.teamId
      ? `This computer is shared with your team. \`/config/workspace/\` is the shared project folder. Teammates' notes are on the same disk under \`${AGENT_DATA_ROOT}/agents/<their-id>/\`. Do not treat the machine as private.`
      : "",
    "Each turn already includes a short digest. For the full note, `shell` `cat`/`rg` or the `memory` tool. Writes: `memory` (write/append) or `shell`. After a repeating job, append what changed so the next run continues instead of starting over.",
  ];
  if (facts) lines.push("", "### Digest", facts);
  lines.push("");
  return lines.join("\n");
}

export async function appendFile(bot: DeskMemoryBot, dest: string, text: string): Promise<void> {
  const box = bot.vm.container;
  const prev = await vm.readFileFromContainer(box, dest);
  const next = `${prev || ""}${prev && !String(prev).endsWith("\n") ? "\n" : ""}${text}${String(text).endsWith("\n") ? "" : "\n"}`;
  await vm.mkdirpInContainer(box, path.posix.dirname(dest));
  await vm.writeFileToContainer(box, dest, next);
}

export async function noteRoutineFire(
  bot: MemoryBot,
  routine: MemoryRoutine | null | undefined,
  now = Date.now(),
) {
  if (!hasVm(bot) || !routine) return { n: (routine?.runs || []).length, path: "" };
  await ensureLayout(bot);
  const box = bot.vm.container;
  const dir = `${agentRoot(bot)}/automations/${slug(routine.name || routine.id)}`;
  await vm.mkdirpInContainer(box, dir);
  const n = (Array.isArray(routine.runs) ? routine.runs.length : 0) || 1;
  const line = JSON.stringify({
    n,
    ts: now,
    at: iso(now),
    name: routine.name || "Routine",
    event: "fired",
  });
  await appendFile(bot, `${dir}/runs.jsonl`, `${line}\n`);
  const stamp = `## ${iso(now)}\n- Routine “${routine.name || "Routine"}” fired (run ${n}). Continue from prior notes; do not start over.\n`;
  await appendFile(bot, `${agentRoot(bot)}/memory/log/${ym(now)}.md`, stamp);
  return { n, path: `${dir}/runs.jsonl` };
}

export async function recentRuns(
  bot: MemoryBot,
  routine: MemoryRoutine | null | undefined,
  limit = 5,
): Promise<string> {
  if (!hasVm(bot) || !routine) return "";
  const raw = await vm.readFileFromContainer(
    bot.vm.container,
    `${agentRoot(bot)}/automations/${slug(routine.name || routine.id)}/runs.jsonl`,
  );
  return String(raw || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .join("\n");
}

export async function routineFirePrompt(
  bot: MemoryBot,
  accepted: readonly MemoryRoutine[],
  now = Date.now(),
  timeZone = "",
): Promise<string> {
  const r = accepted[0];
  if (!r) return "Standing routine is due.";
  const n = Array.isArray(r.runs) ? r.runs.length : 1;
  const last = r.runs?.[r.runs.length - 2]?.ts || r.lastRunAt || 0;
  const ago = last ? Math.max(1, Math.round((now - last) / 60_000)) : null;
  let hist = "";
  try {
    await noteRoutineFire(bot, r, now);
    hist = await recentRuns(bot, r, 5);
  } catch {
    /* desk may be down */
  }
  const root = agentRoot(bot);
  const auto = `${root}/automations/${slug(r.name || r.id)}`;
  const when = ago != null ? (n > 1 ? `run ${n}, last ran ${ago} min ago` : `run ${n}, first fire`) : `run ${n}`;
  return [
    `Standing routine “${r.name || "Routine"}” is due (${when}, ${cadenceLabel(r, timeZone).toLowerCase()}).`,
    "This is a repeating job, not a first-time task. Continue from previous progress. Do not start over, do not redo finished work, do not ignore the log.",
    `History on my computer: \`${auto}/runs.jsonl\` and \`${root}/memory/log/${ym(now)}.md\`.`,
    hist ? `Recent runs:\n${hist}` : "No prior run notes yet — create them as you go.",
    "After you make progress, append a short note with the memory tool (action=append) so the next fire can continue. If nothing material changed, append one line saying so and stop.",
    "",
    "Job:",
    r.instruction || "",
  ].join("\n");
}

export async function handleMemory(bot: MemoryBot, args: MemoryArgs = {}) {
  if (!hasVm(bot)) return { text: "Computer is not running yet.", ok: false };
  const action = String(args.action || "read").toLowerCase();
  await ensureLayout(bot);
  if (action === "list") {
    const dir = args.path ? resolveMemoryPath(bot, args.path) : agentRoot(bot);
    const r = await vm.shell(bot, `find ${JSON.stringify(dir)} -maxdepth 4 -type f 2>/dev/null | head -80`);
    return { text: r.output || "(empty)", ok: r.ok };
  }
  const dest = resolveMemoryPath(bot, args.path);
  if (action === "read") {
    const text = await vm.readFileFromContainer(bot.vm.container, dest);
    return { text: text || "(empty)", ok: true };
  }
  const content = String(args.content ?? "");
  if (action === "write") {
    await vm.mkdirpInContainer(bot.vm.container, path.posix.dirname(dest));
    await vm.writeFileToContainer(bot.vm.container, dest, content.endsWith("\n") ? content : `${content}\n`);
    return { text: `wrote ${dest}`, ok: true };
  }
  if (action === "append") {
    await appendFile(bot, dest, content);
    return { text: `appended ${dest}`, ok: true };
  }
  return { text: "action must be read, write, append, or list", ok: false };
}
