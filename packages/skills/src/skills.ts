import type {
  DeleteSkillArgs,
  DeletedSkill,
  ListSkillsArgs,
  ParsedSkill,
  Skill,
  SkillMdInput,
  SkillMention,
  SkillReader,
  SkillWriter,
  WriteSkillArgs,
  WrittenSkill,
} from "./types.js";

/**
 * The desk's data root. Must equal `@sub8/orchestration`'s AGENT_DATA_ROOT —
 * pinned rather than imported so this package keeps zero dependencies, the same
 * way server/tools-catalog.mjs pins TOOL_ALIASES. test/orchestration-layout.mjs
 * fails if the two ever drift.
 */
export const AGENT_DATA_ROOT = "/config/agent-data";
export const WORKFLOWS_DIR = `${AGENT_DATA_ROOT}/workflows`;
export const SKILL_FILENAME = "SKILL.md";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function assertSkillId(id: unknown): string {
  const s = String(id ?? "").trim();
  if (!s) throw new Error("id required");
  if (s.includes("..") || /[\\/]/.test(s) || s.includes("\0")) throw new Error("invalid skill id");
  if (!ID_RE.test(s)) throw new Error("invalid skill id");
  return s.toLowerCase();
}

export function skillSlug(text: unknown): string {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "skill";
}

/** Desk path `/config/agent-data/workflows/<id>`. */
export function skillDir(id: unknown): string {
  return `${WORKFLOWS_DIR}/${assertSkillId(id)}`;
}

export function skillMdPath(id: unknown): string {
  return `${skillDir(id)}/${SKILL_FILENAME}`;
}

function yamlScalar(value: unknown): string {
  const s = String(value ?? "");
  if (s === "" || !/^[A-Za-z0-9][A-Za-z0-9 +.,'()/_-]*$/.test(s) || s.includes(": ")) {
    return JSON.stringify(s);
  }
  return s;
}

function unquoteYaml(raw: unknown): string {
  let v = String(raw ?? "").trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  const hash = v.indexOf(" #");
  if (hash >= 0) v = v.slice(0, hash).trim();
  return v;
}

function parseYamlMap(block: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(block || "").split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    out[m[1] as string] = unquoteYaml(m[2]);
  }
  return out;
}

export function parseSkillMd(text: unknown): ParsedSkill {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: "", description: "", body: src };
  const fm = parseYamlMap(m[1]);
  return {
    name: String(fm.name ?? "").trim(),
    description: String(fm.description ?? "").trim(),
    body: (m[2] as string).replace(/^\r?\n/, ""),
  };
}

export function formatSkillMd({ name, description, body }: SkillMdInput = {}): string {
  const rest = String(body ?? "").replace(/^\r?\n/, "");
  const tail = rest && !rest.endsWith("\n") ? `${rest}\n` : rest;
  return `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n\n${tail}`;
}

function listingToId(entry: unknown): string {
  const s = String(entry ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!s) return "";
  const parts = s.split("/").filter(Boolean);
  const skillIdx = parts.findIndex((p) => p === SKILL_FILENAME);
  if (skillIdx > 0) return parts[skillIdx - 1] as string;
  const wf = parts.lastIndexOf("workflows");
  if (wf >= 0 && parts[wf + 1] && parts[wf + 1] !== SKILL_FILENAME) return parts[wf + 1] as string;
  if (parts.length === 1 && parts[0] !== SKILL_FILENAME) return parts[0] as string;
  return "";
}

function asIds(listing: unknown): string[] {
  if (listing == null || listing === "") return [];
  if (Array.isArray(listing)) return listing.map(listingToId).filter(Boolean);
  if (typeof listing === "object") {
    const bag = listing as { entries?: unknown; ids?: unknown; files?: unknown };
    const rows = bag.entries || bag.ids || bag.files;
    if (Array.isArray(rows)) return rows.map(listingToId).filter(Boolean);
  }
  return [];
}

async function listIds(reader: SkillReader | undefined): Promise<string[]> {
  if (!reader) throw new Error("reader required");
  if (typeof reader === "function") return asIds(await reader(WORKFLOWS_DIR));
  if (typeof reader.list === "function") return asIds(await reader.list(WORKFLOWS_DIR));
  if (typeof reader.readdir === "function") return asIds(await reader.readdir(WORKFLOWS_DIR));
  throw new Error("reader required");
}

async function readText(reader: SkillReader, dest: string): Promise<unknown> {
  if (typeof reader === "function") return reader(dest);
  if (typeof reader.read === "function") return reader.read(dest);
  if (typeof reader.readFile === "function") return reader.readFile(dest);
  throw new Error("reader required");
}

async function callWriter(writer: SkillWriter, dest: string, text: string | null): Promise<unknown> {
  if (typeof writer === "function") return writer(dest, text);
  if (text == null) {
    if (typeof writer?.remove === "function") return writer.remove(dest);
    if (typeof writer?.delete === "function") return writer.delete(dest);
    if (typeof writer?.rm === "function") return writer.rm(dest);
  }
  if (typeof writer?.write === "function") return writer.write(dest, text);
  throw new Error("writer required");
}

function publicSkill(id: string, parsed: ParsedSkill): Skill {
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    path: skillMdPath(id),
  };
}

export async function listSkills({ reader }: ListSkillsArgs = {}): Promise<Skill[]> {
  const ids = [...new Set(await listIds(reader))];
  const out: Skill[] = [];
  for (const raw of ids) {
    let id;
    try {
      id = assertSkillId(raw);
    } catch {
      continue;
    }
    const text = await readText(reader as SkillReader, skillMdPath(id));
    if (text == null || text === false) continue;
    out.push(publicSkill(id, parseSkillMd(String(text))));
  }
  out.sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
  return out;
}

export async function writeSkill({ id, name, description, body, writer }: WriteSkillArgs = {}): Promise<WrittenSkill> {
  if (writer == null) throw new Error("writer required");
  const label = String(name ?? "").trim();
  const when = String(description ?? "").trim();
  if (!label) throw new Error("name required");
  if (!when) throw new Error("description required");
  const skillId = assertSkillId(id || skillSlug(label));
  const markdown = formatSkillMd({ name: label, description: when, body: body ?? "" });
  await callWriter(writer, skillMdPath(skillId), markdown);
  return { ...publicSkill(skillId, { name: label, description: when, body: String(body ?? "") }), markdown };
}

/** Tests may call this; `confirm: true` is required to actually delete. */
export async function deleteSkill({ id, writer, confirm }: DeleteSkillArgs = {}): Promise<DeletedSkill> {
  const skillId = assertSkillId(id);
  if (writer == null) throw new Error("writer required");
  if (confirm !== true) throw new Error("confirm required");
  const path = skillMdPath(skillId);
  await callWriter(writer, path, null);
  return { id: skillId, path, deleted: true };
}

/** `/id` or `@id` (and name slugs) in user text — inject those recipes into the turn. */
export function findSkillMentions(text: unknown, skills: SkillMention[]): SkillMention[] {
  const list: SkillMention[] = Array.isArray(skills) ? skills : [];
  const byToken = new Map<string, SkillMention>();
  for (const skill of list) {
    if (!skill) continue;
    if (skill.id) byToken.set(String(skill.id).toLowerCase(), skill);
    if (skill.name) byToken.set(skillSlug(skill.name), skill);
  }
  const hits: SkillMention[] = [];
  const seen = new Set<unknown>();
  const src = String(text ?? "");
  const re = /(?:^|[^\w])[/@]([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const skill = byToken.get((m[1] as string).toLowerCase());
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    hits.push(skill);
  }
  return hits;
}
