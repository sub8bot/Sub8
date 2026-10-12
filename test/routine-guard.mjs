/**
 * Standing routine guards.
 *
 * 1. A chat message must never become a routine's brief. On 2026-10-12 a long
 *    "new standing orders" message reached runTurn's chat schedule capture,
 *    which called upsertRoutine with the whole message as the instruction and
 *    replaced the bot's X loop brief with the message text. The package tests
 *    pin captureChatSchedule; this pins that runTurn goes through it, and that
 *    upsert_routine reports a replaced brief and can put the old one back.
 * 2. message_teammate's missing-id error names its real parameter (`bot_id`),
 *    not the server's legacy `toId`.
 * 3. The desk automations mirror drops folders of routines that no longer
 *    exist, and only files it wrote.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-routine-guard-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;
const botId = "00000000-0000-4000-8000-0000000000a1";
process.env.SUB8BOT_BOT_ID = botId;

const store = await import("@sub8/store");
const routines = await import("@sub8/automations");
const memory = await import("../server/memory.mjs");
const { callTool } = await import("../server/mcp-sub8.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));

/* --- 1a. runTurn's chat capture goes through the guarded helper --- */
{
  const agentSrc = readFileSync(path.join(here, "..", "server", "agent.mjs"), "utf8");
  assert.ok(/routines\.captureChatSchedule\(bot, userText/.test(agentSrc), "runTurn must capture chat cadences through captureChatSchedule");
  assert.ok(!/instruction:\s*userText/.test(agentSrc), "a user message must never be passed as a routine instruction");
}

/* --- 1b. upsert_routine reports a replaced brief; restore_previous puts it back --- */
const BRIEF = [
  "X ENGAGEMENT LOOP. Run silently.",
  "1) NOTIFICATIONS. Like every new reply that is not already liked.",
  "2) TIMELINE. Like 8-10 posts in lane per pass, cap 12.",
  "3) LOG. Append one line to the monthly log.",
].join("\n");
const SHORTER = "X ENGAGEMENT LOOP, rebuilt. Like replies, then like 8-10 timeline posts every pass, then log one line.";

await store.writeJsonAtomic(store.botsPath, [
  {
    id: botId,
    name: "Personal",
    messages: [],
    routines: [{ id: "loop", name: "X engagement loop", groupKey: "general", instruction: BRIEF, enabled: true, intervalMs: 30 * 60_000, lastRunAt: 0, createdAt: 1 }],
  },
]);
const loopOf = async () => (await store.getBot(botId)).routines.find((r) => r.id === "loop");

{
  const out = await callTool("upsert_routine", { id: "loop", instruction: SHORTER, interval_minutes: 30 });
  assert.equal(out.isError, undefined, out.content[0].text);
  assert.match(out.content[0].text, new RegExp(`brief was replaced \\(${BRIEF.length} -> ${SHORTER.length} chars\\)`));
  assert.match(out.content[0].text, /restore_previous=true/);
  const loop = await loopOf();
  assert.equal(loop.instruction, SHORTER);
  assert.equal(loop.instructionHistory.length, 1);
  assert.equal(loop.instructionHistory[0].instruction, BRIEF);

  const listed = JSON.parse((await callTool("list_routines", {})).content[0].text);
  assert.equal(listed[0].instructionHistory, undefined, "the listing does not repeat old briefs in full");
  assert.equal(listed[0].previousInstructions[0].chars, BRIEF.length);

  const restored = await callTool("upsert_routine", { id: "loop", instruction: "", restore_previous: true });
  assert.equal(restored.isError, undefined, restored.content[0].text);
  assert.match(restored.content[0].text, /Restored the earlier brief/);
  const back = await loopOf();
  assert.equal(back.instruction, BRIEF);
  assert.equal(back.instructionHistory.at(-1).instruction, SHORTER, "the restore can itself be undone");

  const noId = await callTool("upsert_routine", { instruction: "", restore_previous: true });
  assert.equal(noId.isError, true);
  assert.match(noId.content[0].text, /`id`/);

  // Re-sending the same brief is not a replacement.
  const same = await callTool("upsert_routine", { id: "loop", instruction: BRIEF });
  assert.doesNotMatch(same.content[0].text, /replaced/);
}

/* --- 2. message_teammate / send_message errors name the real parameters --- */
{
  const wrong = await callTool("message_teammate", { toId: "00000000-0000-4000-8000-0000000000b2", content: "hello" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /`bot_id`/);
  assert.match(wrong.content[0].text, /got toId, content/);
  assert.doesNotMatch(wrong.content[0].text, /toId and content required/);

  const empty = await callTool("message_teammate", { bot_id: "00000000-0000-4000-8000-0000000000b2" });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /`content`/);

  const blank = await callTool("send_message", { text: "hi" });
  assert.equal(blank.isError, true);
  assert.match(blank.content[0].text, /`content`/);

  // The schema really is bot_id + content, so the errors above match it.
  const { TOOLS } = await import("../server/mcp-sub8.mjs");
  assert.deepEqual(TOOLS.find((t) => t.name === "message_teammate").inputSchema.required, ["bot_id", "content"]);

  // The server's legacy branch answers a tool hop with the tool's names too.
  const indexSrc = readFileSync(path.join(here, "..", "server", "index.mjs"), "utf8");
  assert.ok(/error: "message_teammate needs `bot_id`/.test(indexSrc), "team-dispatch names bot_id for a tool hop");
}

/* --- 3. the automations mirror drops what it wrote for routines that are gone --- */
function fakeDesk(files) {
  const has = (p) => files.has(p);
  return {
    files,
    async mkdirpInContainer() {},
    async readFileFromContainer(_c, p) {
      return files.get(p) ?? "";
    },
    async writeFileToContainer(_c, p, text) {
      files.set(p, text);
    },
    async listDirInContainer(_c, dir) {
      const names = new Set();
      for (const p of files.keys()) if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split("/")[0]);
      return [...names];
    },
    async removeFileInContainer(_c, p) {
      files.delete(p);
    },
    async rmdirInContainer(_c, dir) {
      if ([...files.keys()].some((p) => p.startsWith(`${dir}/`))) throw new Error("ENOTEMPTY");
    },
    has,
  };
}

{
  const bot = {
    id: botId,
    name: "Personal",
    routines: [{ id: "loop", name: "X engagement loop (@example)", instruction: BRIEF, intervalMs: 1800000 }],
  };
  const root = `${memory.agentRoot(bot)}/automations`;
  const liveDir = `${root}/${memory.slug(bot.routines[0].name)}`;
  const mirror = (r) => `${JSON.stringify(routines.automationJson(r), null, 2)}\n`;
  const desk = fakeDesk(
    new Map([
      // the live routine: kept
      [`${liveDir}/automation.json`, mirror(bot.routines[0])],
      [`${liveDir}/runs.jsonl`, '{"n":1,"event":"fired"}\n'],
      // the routine's old name (renamed from "General"): a stale mirror, removed whole
      [`${root}/general/automation.json`, mirror({ name: "General", instruction: "hourly check", intervalMs: 3600000, createdAt: 1 })],
      [`${root}/general/runs.jsonl`, '{"n":1,"ts":1,"event":"fired"}\n'],
      // the seed shape ensureLayout writes: also ours
      [`${root}/old-seed/automation.json`, JSON.stringify({ id: "gone", name: "Old seed", cadence: "Every hour", instruction: "x" })],
      // a stale mirror with a user's note beside it: the mirror goes, the note and folder stay
      [`${root}/with-notes/automation.json`, mirror({ name: "With notes", instruction: "y" })],
      [`${root}/with-notes/notes.md`, "my notes"],
      // run history with a hand-written line: kept
      [`${root}/edited-runs/automation.json`, mirror({ name: "Edited runs", instruction: "z" })],
      [`${root}/edited-runs/runs.jsonl`, '{"event":"fired"}\nremember to retry this one\n'],
      // not the mirror's: an automation.json with foreign keys, and a folder with none
      [`${root}/mine/automation.json`, JSON.stringify({ name: "Mine", prompt: "p", owner: "dan" })],
      [`${root}/scratch/todo.txt`, "keep"],
      // not JSON at all
      [`${root}/broken/automation.json`, "{nope"],
    ]),
  );

  const removed = await memory.pruneAutomations(bot, { io: desk });
  assert.deepEqual(removed.sort(), [
    `${root}/edited-runs/automation.json`,
    `${root}/general/automation.json`,
    `${root}/old-seed/automation.json`,
    `${root}/with-notes/automation.json`,
  ]);
  assert.ok(desk.has(`${liveDir}/automation.json`) && desk.has(`${liveDir}/runs.jsonl`), "the live routine's mirror stays");
  assert.ok(!desk.has(`${root}/general/runs.jsonl`), "run records of a removed routine go with it");
  assert.ok(desk.has(`${root}/with-notes/notes.md`), "a user file in a stale folder stays");
  assert.ok(desk.has(`${root}/edited-runs/runs.jsonl`), "a runs.jsonl with non-record lines stays");
  assert.ok(desk.has(`${root}/mine/automation.json`), "an automation.json with foreign keys is not the mirror's");
  assert.ok(desk.has(`${root}/scratch/todo.txt`));
  assert.ok(desk.has(`${root}/broken/automation.json`));

  // No routines: nothing is pruned (restoreDeskAutomations rebuilds from these
  // files), unless the caller says the list is empty on purpose.
  const emptyDesk = fakeDesk(new Map([[`${liveDir}/automation.json`, mirror(bot.routines[0])]]));
  assert.deepEqual(await memory.pruneAutomations({ ...bot, routines: [] }, { io: emptyDesk }), []);
  assert.ok(emptyDesk.has(`${liveDir}/automation.json`));
  assert.deepEqual(await memory.pruneAutomations({ ...bot, routines: [] }, { io: emptyDesk, allowEmpty: true }), [`${liveDir}/automation.json`]);

  // An io without list/remove (an older backend) is a no-op, not a throw.
  const { listDirInContainer, removeFileInContainer, ...bare } = fakeDesk(new Map());
  assert.deepEqual(await memory.pruneAutomations(bot, { io: bare }), []);

  // The delete paths prune with allowEmpty.
  for (const file of ["mcp-sub8.mjs", "agent.mjs", "index.mjs"]) {
    const src = readFileSync(path.join(here, "..", "server", file), "utf8");
    assert.ok(/pruneAutomations\([^)]*\{ allowEmpty: true \}\)/.test(src), `${file} delete path prunes the mirror`);
  }
}

await fs.rm(tmp, { recursive: true, force: true });
console.log("ok routine-guard");
