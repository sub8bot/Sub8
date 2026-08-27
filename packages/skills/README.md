# @sub8/skills

Desk workflows — what a `SKILL.md` says, where it lives, and when a line of
user text is asking for one.

Moved verbatim from `server/skills.mjs` (216 lines) with a 257-line test — the
one module in `server/` whose test was larger than its source.

## What is here

- **Layout** — `AGENT_DATA_ROOT`, `WORKFLOWS_DIR`, `SKILL_FILENAME`,
  `skillDir`, `skillMdPath`, `skillSlug`. Ids are validated hard: no `..`, no
  slashes, no NUL, and `/config/agent-data/workflows/<id>/SKILL.md` is the only
  shape that comes out.
- **Frontmatter** — `parseSkillMd` / `formatSkillMd`. A tiny YAML-map reader
  that handles quoted scalars, `''` escapes and trailing ` #` comments, because
  a description like `Use when: the inbox is noisy` has to round-trip.
- **CRUD over an injected filesystem** — `listSkills`, `writeSkill`,
  `deleteSkill`. The desk is a Docker container, so the reader/writer are passed
  in; the package never touches `node:fs`. Both a bare function and an object
  (`list`/`readdir`, `read`/`readFile`, `write`/`remove`/`delete`/`rm`) are
  accepted, which is what lets the tests run against a `Map`.
- **Mentions** — `findSkillMentions`. `/shared-status` or `@shared-status` in a
  message pulls that recipe into the turn.

## The one pinned constant

`server/skills.mjs` reached for `@sub8/orchestration`'s `AGENT_DATA_ROOT`
through an `existsSync` + `await import()` of a relative `dist/` path, falling
back to the literal `/config/agent-data` when `packages/` was not on disk. A
package cannot keep that dance, and taking a runtime dependency on
`@sub8/orchestration` would drag it through `healMcp()` and electron-builder for
one string. So the literal is pinned here — the same call `server/memory.mjs`
and `server/tools-catalog.mjs` already make — and the package test asserts it
against `@sub8/orchestration` so drift fails the build.

## What is deliberately NOT here

Deciding to write a skill. `server/update-state.mjs` owns the model-facing
`update_state` verb and the confirm rules around it; this package only knows the
file format and the path.
