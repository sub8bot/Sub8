/** A SKILL.md split into its frontmatter and its body. */
export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/** What `formatSkillMd` accepts. Callers are untyped `.mjs`, so keep it loose. */
export interface SkillMdInput {
  name?: unknown;
  description?: unknown;
  body?: unknown;
}

/** One skill as the API and the model see it. */
export interface Skill extends ParsedSkill {
  id: string;
  /** Desk path `/config/agent-data/workflows/<id>/SKILL.md`. */
  path: string;
}

export interface WrittenSkill extends Skill {
  markdown: string;
}

export interface DeletedSkill {
  id: string;
  path: string;
  deleted: true;
}

/** The shape `findSkillMentions` needs off a skill row. */
export interface SkillMention {
  id?: string;
  name?: string;
}

/**
 * The desk filesystem, injected. A bare function is `(dest) => text`; an object
 * may name the same thing `list`/`readdir` and `read`/`readFile`.
 */
export type SkillReaderFn = (dest: string) => unknown;

export interface SkillReaderObject {
  list?: (dir: string) => unknown;
  readdir?: (dir: string) => unknown;
  read?: (dest: string) => unknown;
  readFile?: (dest: string) => unknown;
}

export type SkillReader = SkillReaderFn | SkillReaderObject;

/** Same seam for writes. `text: null` means delete. */
export type SkillWriterFn = (dest: string, text: string | null) => unknown;

export interface SkillWriterObject {
  write?: (dest: string, text: string | null) => unknown;
  remove?: (dest: string) => unknown;
  delete?: (dest: string) => unknown;
  rm?: (dest: string) => unknown;
}

export type SkillWriter = SkillWriterFn | SkillWriterObject;

export interface ListSkillsArgs {
  reader?: SkillReader;
}

export interface WriteSkillArgs {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  body?: unknown;
  writer?: SkillWriter;
}

export interface DeleteSkillArgs {
  id?: unknown;
  writer?: SkillWriter;
  confirm?: boolean;
}
