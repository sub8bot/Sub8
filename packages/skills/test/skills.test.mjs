import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DATA_ROOT as orchestrationRoot } from "@sub8/orchestration";
import {
  AGENT_DATA_ROOT,
  WORKFLOWS_DIR,
  SKILL_FILENAME,
  skillDir,
  skillMdPath,
  skillSlug,
  parseSkillMd,
  formatSkillMd,
  listSkills,
  writeSkill,
  deleteSkill,
  findSkillMentions,
} from "../dist/index.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureMd = readFileSync(
  path.join(repo, "packages/orchestration/fixtures/workflows/shared-status/SKILL.md"),
  "utf8",
);

function memoryIo() {
  const files = new Map();
  const reader = async (p) => {
    if (p === WORKFLOWS_DIR || p === `${WORKFLOWS_DIR}/`) {
      const ids = new Set();
      for (const key of files.keys()) {
        if (!key.startsWith(`${WORKFLOWS_DIR}/`)) continue;
        const id = key.slice(WORKFLOWS_DIR.length + 1).split("/")[0];
        if (id) ids.add(id);
      }
      return [...ids];
    }
    return files.has(p) ? files.get(p) : null;
  };
  const writer = async (p, text) => {
    if (text == null) {
      files.delete(p);
      const prefix = p.endsWith("/") ? p : `${p}/`;
      for (const key of [...files.keys()]) {
        if (key === p || key.startsWith(prefix)) files.delete(key);
      }
      return;
    }
    files.set(p, String(text));
  };
  return { files, reader, writer };
}

test("skillDir uses orchestration AGENT_DATA_ROOT", () => {
  assert.equal(AGENT_DATA_ROOT, "/config/agent-data");
  assert.equal(AGENT_DATA_ROOT, orchestrationRoot, "pinned copy drifted from @sub8/orchestration");
  assert.equal(WORKFLOWS_DIR, "/config/agent-data/workflows");
  assert.equal(skillDir("shared-status"), "/config/agent-data/workflows/shared-status");
  assert.equal(skillMdPath("shared-status"), "/config/agent-data/workflows/shared-status/SKILL.md");
  assert.equal(SKILL_FILENAME, "SKILL.md");
  assert.equal(skillSlug("Shared status"), "shared-status");
  assert.throws(() => skillDir("../etc"), /invalid skill id/);
  assert.throws(() => skillDir("a/b"), /invalid skill id/);
  assert.throws(() => skillDir(""), /id required/);
});

test("parseSkillMd reads YAML name + description from fixture", () => {
  const parsed = parseSkillMd(fixtureMd);
  assert.equal(parsed.name, "Shared status");
  assert.match(parsed.description, /summarizing what every assistant/);
  assert.match(parsed.body, /List teammates by UUID/);
  assert.doesNotMatch(parsed.body, /^---/);
});

test("parseSkillMd roundtrips formatSkillMd including quoted colon", () => {
  const src = {
    name: "Human name",
    description: "Use when: the inbox is noisy",
    body: "# Steps\n1. Read the thread.\n",
  };
  const md = formatSkillMd(src);
  assert.match(md, /^---\nname: Human name\n/);
  assert.match(md, /description: "Use when: the inbox is noisy"/);
  const parsed = parseSkillMd(md);
  assert.equal(parsed.name, src.name);
  assert.equal(parsed.description, src.description);
  assert.equal(parsed.body, src.body);
  const again = parseSkillMd(formatSkillMd(parsed));
  assert.deepEqual(again, parsed);
});

test("parseSkillMd without frontmatter leaves body intact", () => {
  const parsed = parseSkillMd("# Just notes\n\nDo the thing.\n");
  assert.equal(parsed.name, "");
  assert.equal(parsed.description, "");
  assert.match(parsed.body, /Just notes/);
});

test("writeSkill writes SKILL.md via injected writer", async () => {
  const io = memoryIo();
  const row = await writeSkill({
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Use when the user wants mail sorted.",
    body: "# Steps\n1. Open the inbox.\n",
    writer: io.writer,
  });
  assert.equal(row.id, "inbox-triage");
  assert.equal(row.path, skillMdPath("inbox-triage"));
  const disk = io.files.get(skillMdPath("inbox-triage"));
  assert.equal(disk, row.markdown);
  const parsed = parseSkillMd(disk);
  assert.equal(parsed.name, "Inbox triage");
  assert.equal(parsed.description, "Use when the user wants mail sorted.");
  assert.match(parsed.body, /Open the inbox/);
});

test("writeSkill slugs name when id omitted", async () => {
  const io = memoryIo();
  const row = await writeSkill({
    name: "Shared status",
    description: "Use when summarizing teammates.",
    body: "List by UUID.\n",
    writer: io.writer,
  });
  assert.equal(row.id, "shared-status");
  assert.equal(io.files.has(skillMdPath("shared-status")), true);
});

test("writeSkill requires name, description, and writer", async () => {
  const io = memoryIo();
  await assert.rejects(
    () => writeSkill({ name: "X", description: "when to use it", body: "1" }),
    /writer required/,
  );
  await assert.rejects(
    () => writeSkill({ name: "X", description: "", body: "1", writer: io.writer }),
    /description required/,
  );
  await assert.rejects(
    () => writeSkill({ description: "when to use it", body: "1", writer: io.writer }),
    /name required/,
  );
  assert.equal(io.files.size, 0);
});

test("listSkills reads workflows via injected reader", async () => {
  const io = memoryIo();
  await writeSkill({
    id: "beta",
    name: "Beta",
    description: "Use when testing list order.",
    body: "B\n",
    writer: io.writer,
  });
  await writeSkill({
    id: "alpha",
    name: "Alpha",
    description: "Use when listing alphabetically.",
    body: "A\n",
    writer: io.writer,
  });
  const listed = await listSkills({ reader: io.reader });
  assert.deepEqual(
    listed.map((s) => s.id),
    ["alpha", "beta"],
  );
  assert.equal(listed[0].name, "Alpha");
  assert.equal(listed[0].path, skillMdPath("alpha"));
  assert.match(listed[1].description, /list order/);
});

test("listSkills accepts object reader and skips missing files", async () => {
  const files = new Map();
  files.set(skillMdPath("keep"), formatSkillMd({ name: "Keep", description: "Use when keeping.", body: "ok\n" }));
  const listed = await listSkills({
    reader: {
      list: async () => ["keep", "gone", "keep/SKILL.md"],
      read: async (p) => (files.has(p) ? files.get(p) : null),
    },
  });
  assert.deepEqual(
    listed.map((s) => s.id),
    ["keep"],
  );
});

test("listSkills requires reader", async () => {
  await assert.rejects(() => listSkills(), /reader required/);
  await assert.rejects(() => listSkills({}), /reader required/);
});

test("deleteSkill is callable but confirm: true is required to delete", async () => {
  const io = memoryIo();
  await writeSkill({
    id: "temp",
    name: "Temp",
    description: "Use when testing delete confirm.",
    body: "gone\n",
    writer: io.writer,
  });
  let called = false;
  await assert.rejects(
    () =>
      deleteSkill({
        id: "temp",
        writer: async (...args) => {
          called = true;
          return io.writer(...args);
        },
      }),
    /confirm required/,
  );
  assert.equal(called, false);
  assert.equal(io.files.has(skillMdPath("temp")), true);

  await assert.rejects(() => deleteSkill({ id: "temp", writer: io.writer, confirm: false }), /confirm required/);
  await assert.rejects(() => deleteSkill({ id: "temp", confirm: true }), /writer required/);

  const result = await deleteSkill({ id: "temp", writer: io.writer, confirm: true });
  assert.equal(result.deleted, true);
  assert.equal(result.id, "temp");
  assert.equal(result.path, skillMdPath("temp"));
  assert.equal(io.files.has(skillMdPath("temp")), false);
  const left = await listSkills({ reader: io.reader });
  assert.equal(left.some((s) => s.id === "temp"), false);
});

test("findSkillMentions matches /id and @id", async () => {
  const io = memoryIo();
  const written = await writeSkill({
    name: "Shared status",
    description: "Use when summarizing teammates.",
    body: "UUID list.\n",
    writer: io.writer,
  });
  const skills = await listSkills({ reader: io.reader });
  const slash = findSkillMentions("please run /shared-status now", skills);
  assert.equal(slash.length, 1);
  assert.equal(slash[0].id, written.id);
  const at = findSkillMentions("use @shared-status on this desk", skills);
  assert.equal(at[0].id, "shared-status");
  assert.deepEqual(findSkillMentions("no mentions here", skills), []);
});

// ---------------------------------------------------------------------------
// Create / update identity: which writes are the same skill
// ---------------------------------------------------------------------------

test("writeSkill never refuses an unknown id — every write is a create", async () => {
  // There is no reader in the write path, so writeSkill cannot tell an update
  // from a create and never tries. update_state target=skill action=write
  // forwards `args.id || args.skill_id` straight through, so a model that
  // mistypes the id of a skill it meant to edit silently gets a SECOND skill
  // instead of an error, and the original keeps the stale body.
  const io = memoryIo();
  await writeSkill({ id: "inbox-triage", name: "Inbox triage", description: "Use when mail piles up.", body: "v1\n", writer: io.writer });
  const typo = await writeSkill({ id: "inbox-triage2", name: "Inbox triage", description: "Use when mail piles up.", body: "v2\n", writer: io.writer });
  assert.equal(typo.id, "inbox-triage2");
  assert.equal(io.files.size, 2);
  assert.match(io.files.get(skillMdPath("inbox-triage")), /v1/, "the intended target still holds v1");
  const listed = await listSkills({ reader: io.reader });
  assert.deepEqual(listed.map((s) => s.id), ["inbox-triage", "inbox-triage2"]);
  assert.equal(listed[0].name, listed[1].name, "two skills, one name, nothing complains");
});

test("an id that differs only in case is the SAME skill and overwrites it", async () => {
  // assertSkillId lowercases on the way out, so `Inbox-Triage` and
  // `inbox-triage` resolve to one path. A caller that believes ids are
  // case-sensitive destroys the first skill without any signal.
  const io = memoryIo();
  const first = await writeSkill({ id: "Inbox-Triage", name: "Triage", description: "Use when mail piles up.", body: "keep me\n", writer: io.writer });
  const second = await writeSkill({ id: "inbox-triage", name: "Other", description: "Use for something else.", body: "clobbered\n", writer: io.writer });
  assert.equal(first.id, "inbox-triage");
  assert.equal(second.id, "inbox-triage");
  assert.equal(io.files.size, 1);
  assert.match(io.files.get(skillMdPath("inbox-triage")), /clobbered/);
  assert.doesNotMatch(io.files.get(skillMdPath("inbox-triage")), /keep me/);
});

test("names that slug alike collide when the id is left to skillSlug", async () => {
  // skillSlug strips everything that is not [a-z0-9] and cuts to 48 chars, then
  // falls back to the literal "skill". Two differently-named skills written
  // without an id therefore land on one file — the second wins, silently.
  assert.equal(skillSlug("!!!"), "skill");
  assert.equal(skillSlug("???"), "skill");
  assert.equal(skillSlug(`${"a".repeat(48)} one`), skillSlug(`${"a".repeat(48)} two`), "the cut is at 48 characters");

  const io = memoryIo();
  await writeSkill({ name: "!!!", description: "Use when shouting.", body: "first\n", writer: io.writer });
  const second = await writeSkill({ name: "???", description: "Use when asking.", body: "second\n", writer: io.writer });
  assert.equal(second.id, "skill");
  assert.equal(io.files.size, 1);
  assert.match(io.files.get(skillMdPath("skill")), /second/);
});

test("an id is validated before confirm and before the writer is ever consulted", async () => {
  // Order matters for a traversal id: it must be refused here, not handed to a
  // writer that would run `rm -f` on the desk with it. deleteSkill checks the
  // id first, so a bad one never reaches the filesystem seam under any confirm.
  let touched = 0;
  const trap = async () => {
    touched += 1;
  };
  for (const id of ["../../etc/passwd", "a/b", "..", "  ", ""]) {
    await assert.rejects(() => deleteSkill({ id, writer: trap, confirm: true }), /invalid skill id|id required/, JSON.stringify(id));
  }
  for (const id of ["../../etc/passwd", "a/b", "..", "  "]) {
    await assert.rejects(() => writeSkill({ id, name: "N", description: "D", writer: trap }), /invalid skill id|id required/, JSON.stringify(id));
  }
  assert.equal(touched, 0);
  // ...and it is checked before the writer too, so a bad id comes back as an id
  // error even when no writer was supplied at all.
  await assert.rejects(() => deleteSkill({ id: "../../etc/passwd", confirm: true }), /invalid skill id/);
  await assert.rejects(() => deleteSkill({ id: "", confirm: true }), /id required/);
  // An id of "" is the one falsy spelling that is NOT refused on the write
  // path: `id || skillSlug(label)` falls back to the name, so an empty id
  // quietly creates a name-slugged skill rather than failing.
  const io = memoryIo();
  const fallback = await writeSkill({ id: "", name: "Inbox triage", description: "Use when mail piles up.", writer: io.writer });
  assert.equal(fallback.id, "inbox-triage");
  // The length bound is 81 characters — one leading char plus {0,80}.
  assert.equal(skillDir("a".repeat(81)).endsWith("a".repeat(81)), true);
  assert.throws(() => skillDir("a".repeat(82)), /invalid skill id/);
});

// ---------------------------------------------------------------------------
// deleteSkill: what `confirm` actually accepts
// ---------------------------------------------------------------------------

test("only a literal true deletes — every truthy lookalike is refused", async () => {
  // server/update-state.mts declares `confirm?: boolean` and forwards
  // `args.confirm`, but those args are parsed JSON from a model, so the runtime
  // value can be anything. `confirm !== true` means a model that writes
  // confirm:"true" or confirm:1 gets "confirm required" rather than a delete —
  // the safe direction, and worth pinning so it stays that way.
  for (const confirm of [undefined, null, false, 0, 1, "true", "yes", {}, []]) {
    const io = memoryIo();
    await writeSkill({ id: "temp", name: "Temp", description: "Use when testing.", body: "x\n", writer: io.writer });
    await assert.rejects(
      () => deleteSkill({ id: "temp", writer: io.writer, ...(confirm === undefined ? {} : { confirm }) }),
      /confirm required/,
      JSON.stringify(confirm ?? null),
    );
    assert.equal(io.files.has(skillMdPath("temp")), true, JSON.stringify(confirm ?? null));
  }
});

test("deleteSkill prefers a remove seam and falls back to write(path, null)", async () => {
  // The writer may be a bare function or an object naming the same thing four
  // ways. A delete asks remove/delete/rm first and only then write(dest, null),
  // so a desk that implements both never gets an empty file where a removal was
  // meant.
  for (const key of ["remove", "delete", "rm"]) {
    const seen = [];
    await deleteSkill({
      id: "temp",
      confirm: true,
      writer: { [key]: async (dest) => seen.push([key, dest]), write: async () => seen.push(["write", null]) },
    });
    assert.deepEqual(seen, [[key, skillMdPath("temp")]]);
  }
  const written = [];
  await deleteSkill({ id: "temp", confirm: true, writer: { write: async (dest, text) => written.push([dest, text]) } });
  assert.deepEqual(written, [[skillMdPath("temp"), null]]);
  await assert.rejects(() => deleteSkill({ id: "temp", confirm: true, writer: {} }), /writer required/);
  await assert.rejects(() => writeSkill({ id: "temp", name: "N", description: "D", writer: {} }), /writer required/);
});

// ---------------------------------------------------------------------------
// Round trip, and what a damaged record reads back as
// ---------------------------------------------------------------------------

test("every field survives a round trip through the store, punctuation included", async () => {
  const io = memoryIo();
  const src = {
    id: "round-trip",
    // A colon forces the quoted YAML branch; a # would be a comment unquoted;
    // a newline has to survive as an escape on one line.
    name: "Triage: inbox",
    description: 'Use when the user says #urgent, or "later", or nothing at all.\nSecond line.',
    // A body that opens with its own --- must not be re-read as frontmatter.
    body: "---\nnot frontmatter\n---\n\n# Steps\n1. Öffne die Inbox 📥\n2. Done.\n",
  };
  const row = await writeSkill({ ...src, writer: io.writer });
  const disk = io.files.get(skillMdPath("round-trip"));
  assert.equal(disk, row.markdown);
  const back = parseSkillMd(disk);
  assert.equal(back.name, src.name);
  assert.equal(back.description, src.description);
  assert.equal(back.body, src.body);
  // ...and a second lap changes nothing.
  assert.deepEqual(parseSkillMd(formatSkillMd(back)), back);
  // The listed row is the parsed one, so it matches too.
  const [listed] = await listSkills({ reader: io.reader });
  assert.equal(listed.name, src.name);
  assert.equal(listed.description, src.description);
  assert.equal(listed.body, src.body);
});

test("writeSkill's returned body is not the body it wrote", async () => {
  // formatSkillMd appends the trailing newline the file needs, but the row
  // handed back to the caller (and into update_state's `{skill: row}` reply)
  // carries the raw input. A caller that diffs its row against a later
  // listSkills row sees a change that is not one.
  const io = memoryIo();
  const row = await writeSkill({ id: "nl", name: "NL", description: "Use when checking newlines.", body: "no trailing newline", writer: io.writer });
  assert.equal(row.body, "no trailing newline");
  const [listed] = await listSkills({ reader: io.reader });
  assert.equal(listed.body, "no trailing newline\n");
  assert.notEqual(row.body, listed.body);
  assert.equal(parseSkillMd(row.markdown).body, listed.body);
});

test("a truncated SKILL.md becomes a nameless skill rather than an error", async () => {
  // A write cut short mid-frontmatter leaves no closing ---, the regex does not
  // match, and the WHOLE file becomes the body. listSkills then offers the
  // model a recipe with no name and no "use when", so it can never be selected
  // — and nothing anywhere reports the damage.
  const half = "---\nname: Inbox triage\ndescription: Use when mail piles";
  const parsed = parseSkillMd(half);
  assert.equal(parsed.name, "");
  assert.equal(parsed.description, "");
  assert.equal(parsed.body, half);

  const io = memoryIo();
  io.files.set(skillMdPath("half"), half);
  io.files.set(skillMdPath("blank"), "");
  const listed = await listSkills({ reader: io.reader });
  assert.deepEqual(listed.map((s) => s.id), ["blank", "half"]);
  assert.deepEqual(listed.map((s) => s.name), ["", ""]);
  // An empty file is listed, because the skip is `== null || === false` and ""
  // is neither. Only a reader that answers null/false drops the entry.
  assert.equal(listed[0].body, "");
  const dropped = await listSkills({ reader: { list: async () => ["gone", "denied"], read: async (p) => (p.includes("gone") ? null : false) } });
  assert.deepEqual(dropped, []);
});

test("frontmatter is last-key-wins, and an unquoted # truncates the value", async () => {
  // parseYamlMap overwrites on a repeated key and strips an inline " #"
  // comment. Everything formatSkillMd writes is quoted when it needs to be, so
  // this only bites a HAND-WRITTEN SKILL.md — which is exactly what a user
  // editing one on the desk produces.
  const handWritten = [
    "---",
    "# a whole-line comment is skipped",
    "name: Draft",
    "name: Draft v2",
    "description: Use when the mail is #urgent",
    "unknown-key: ignored",
    "---",
    "body",
    "",
  ].join("\n");
  const parsed = parseSkillMd(handWritten);
  assert.equal(parsed.name, "Draft v2", "the second name wins");
  assert.equal(parsed.description, "Use when the mail is", "everything after the inline # is gone");
  // Written by formatSkillMd the same description is quoted and survives.
  assert.equal(parseSkillMd(formatSkillMd({ name: "Draft", description: "Use when the mail is #urgent" })).description, "Use when the mail is #urgent");
});

test("a CRLF or BOM SKILL.md parses, and CRLF stays in the body", async () => {
  // A skill authored on Windows, or served through an editor that adds a BOM.
  const crlf = parseSkillMd("﻿---\r\nname: Windows\r\ndescription: Use when the file has CRLF.\r\n---\r\n\r\nline one\r\nline two\r\n");
  assert.equal(crlf.name, "Windows");
  assert.equal(crlf.description, "Use when the file has CRLF.");
  assert.equal(crlf.body, "line one\r\nline two\r\n");
  // Round-tripping it normalises the frontmatter but leaves the body's CRLFs.
  assert.equal(parseSkillMd(formatSkillMd(crlf)).body, crlf.body);
});

// ---------------------------------------------------------------------------
// Listing shapes, and which mentions actually fire
// ---------------------------------------------------------------------------

test("listSkills returns one skill twice when the listing spells its id two ways", async () => {
  // The dedupe is `new Set(await listIds(reader))` on the RAW entries, and the
  // lowercasing happens afterwards in assertSkillId. A desk listing that shows
  // both `Alpha` and `alpha` (or a reader that returns a path and a bare id for
  // the same skill) therefore reads one file twice and offers the model the
  // same recipe two or three times over.
  const md = formatSkillMd({ name: "Alpha", description: "Use when listing.", body: "A\n" });
  const listed = await listSkills({
    reader: { list: async () => ["Alpha", "alpha", "ALPHA"], read: async (p) => (p === skillMdPath("alpha") ? md : null) },
  });
  assert.deepEqual(listed.map((s) => s.id), ["alpha", "alpha", "alpha"]);
});

test("a listing is only read as an array or an entries/ids/files bag", async () => {
  const md = formatSkillMd({ name: "Keep", description: "Use when keeping.", body: "b\n" });
  const read = async (p) => (p === skillMdPath("keep") ? md : null);
  for (const listing of [["keep"], [`${WORKFLOWS_DIR}/keep/SKILL.md`], ["keep/"], ["keep/SKILL.md"], { entries: ["keep"] }, { ids: ["keep"] }, { files: ["keep"] }]) {
    const out = await listSkills({ reader: { readdir: async () => listing, readFile: read } });
    assert.deepEqual(out.map((s) => s.id), ["keep"], JSON.stringify(listing));
  }
  // A desk reader that shells out to `ls` hands back TEXT, and asIds has no arm
  // for a string — so the catalogue comes back empty instead of erroring, and
  // the model is told this desk has no skills.
  for (const listing of ["keep", "keep\nother\n", null, "", 0]) {
    assert.deepEqual(await listSkills({ reader: { readdir: async () => listing, readFile: read } }), [], JSON.stringify(listing));
  }
});

test("a later skill's NAME shadows an earlier skill's ID", async () => {
  // byToken is filled id-then-name for each skill in turn, so a skill merely
  // NAMED "Notes" overwrites the entry for the skill whose id IS "notes".
  // `/notes` then injects the wrong recipe, and the one the user named is
  // unreachable by its own id.
  const skills = [{ id: "notes", name: "Notes archive" }, { id: "meeting-notes", name: "Notes" }];
  assert.deepEqual(findSkillMentions("run /notes", skills), [{ id: "meeting-notes", name: "Notes" }]);
  // Reverse the list and the other one wins — the winner is list order, not
  // whether the token was an id or a name.
  assert.deepEqual(findSkillMentions("run /notes", [...skills].reverse()), [{ id: "notes", name: "Notes archive" }]);
});

test("a path or a glob in ordinary prose counts as a mention", async () => {
  // The token only needs a non-word character in front of it, so anything a
  // user pastes that contains `/<id>` after a quote, bracket, tilde or star
  // silently injects that skill's whole recipe into the turn.
  const skills = [{ id: "notes", name: "Notes" }];
  for (const text of ["~/notes", 'open "/notes" please', "(/notes)", "**/notes**", "look at /notes now", "@notes"]) {
    assert.deepEqual(findSkillMentions(text, skills).map((s) => s.id), ["notes"], text);
  }
  // A word character in front is not a mention...
  for (const text of ["x/notes", "dan@notes", "footnotes"]) {
    assert.deepEqual(findSkillMentions(text, skills), [], text);
  }
  // ...and a URL escapes only by accident: the regex consumes the separator of
  // the PREVIOUS segment, so `//x.com` is matched and `/notes` is never reached.
  assert.deepEqual(findSkillMentions("https://x.com/notes", skills), []);
  assert.deepEqual(findSkillMentions("https://x.com//notes", skills).map((s) => s.id), ["notes"]);
  // Each skill fires once however many times it is named.
  assert.deepEqual(findSkillMentions("/notes and /notes and @notes", skills).map((s) => s.id), ["notes"]);
});
