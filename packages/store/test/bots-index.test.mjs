/**
 * bots.json is the INDEX; conversations/<id>.json owns the transcript.
 *
 * Every message used to be written to BOTH. On the real data dir that meant
 * bots.json was 7.7 MB for six bots — one row alone 6.3 MB across 16,519
 * messages — duplicated byte for byte under conversations/. Every store
 * operation re-read, re-parsed and rewrote the whole file inside the global
 * mutex. Measured on a copy of that data: loadBots() 45.9ms -> 21.3ms, and
 * bots.json 7,741,015 -> 13,953 bytes.
 *
 * The risk this trades against is losing the transcript, so these pin that the
 * messages are still there afterwards, that a legacy bots.json still loads, and
 * that saveBots — whose rows come from the caller, not from disk — flushes the
 * transcript before the index drops it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-bots-index-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("../dist/index.js");
const botsPath = path.join(tmp, "bots.json");
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const readIndex = async () => JSON.parse(await fs.readFile(botsPath, "utf8"));
const msg = (i) => ({ id: `m${i}`, role: "assistant", content: `body-${i}-XYZZY`, ts: 1000 + i });

test("appended messages live in the conversation file, not in the index", async () => {
  const id = uid(1);
  await store.upsertBot({ id, name: "Indexed", messages: [] });
  for (let i = 0; i < 20; i++) {
    await store.patchBot(id, (b) => {
      b.messages = b.messages || [];
      b.messages.push(msg(i));
    });
  }

  // The transcript is intact through the normal read path.
  const bot = await store.getBot(id);
  assert.equal(bot.messages.length, 20, "messages were lost");
  assert.equal(bot.messages.at(-1).content, "body-19-XYZZY");

  // And none of it is in the index.
  const raw = await fs.readFile(botsPath, "utf8");
  assert.equal(raw.includes("XYZZY"), false, "message bodies are still duplicated into bots.json");
  const rows = await readIndex();
  assert.deepEqual(rows.find((r) => r.id === id).messages, [], "the index row still carries messages");

  // The conversation file is where they are.
  const conv = JSON.parse(await fs.readFile(path.join(tmp, "conversations", `${id}.json`), "utf8"));
  assert.equal(conv.length, 20);
});

test("the index stays small as the transcript grows", async () => {
  const id = uid(2);
  await store.upsertBot({ id, name: "Grower", messages: [] });
  const at = async () => (await fs.stat(botsPath)).size;
  const before = await at();
  for (let i = 0; i < 200; i++) {
    await store.patchBot(id, (b) => {
      b.messages = b.messages || [];
      b.messages.push({ ...msg(i), content: "x".repeat(200) });
    });
  }
  const after = await at();
  assert.ok(after - before < 2000, `index grew ${after - before} bytes for 200 messages (40KB of content)`);
  assert.equal((await store.getBot(id)).messages.length, 200, "and the transcript is all there");
});

// A bots.json written before the split still carries its messages inline, with
// no conversation file beside it. It must still load, and migrate on write.
test("a legacy index with inline messages still loads, then migrates", async () => {
  const id = uid(3);
  await fs.writeFile(
    botsPath,
    JSON.stringify([{ id, name: "Legacy", messages: [msg(1), msg(2)], harness: { provider: "grok-build" } }], null, 2),
  );
  await fs.rm(path.join(tmp, "conversations", `${id}.json`), { force: true });

  const bot = await store.getBot(id);
  assert.equal(bot.messages.length, 2, "a legacy row lost its messages");
  assert.equal(bot.messages[0].content, "body-1-XYZZY");

  await store.patchBot(id, (b) => b.messages.push(msg(3)));
  const raw = await fs.readFile(botsPath, "utf8");
  assert.equal(raw.includes("XYZZY"), false, "the legacy row was not migrated out of the index");
  assert.equal((await store.getBot(id)).messages.length, 3);
});

// saveBots takes rows from the caller rather than from disk, so it is the one
// writer that has to flush the transcript itself.
test("saveBots flushes the transcript before the index drops it", async () => {
  const id = uid(4);
  await store.saveBots([{ id, name: "Direct", messages: [msg(7), msg(8)], harness: { provider: "grok-build" } }]);
  const raw = await fs.readFile(botsPath, "utf8");
  assert.equal(raw.includes("XYZZY"), false, "saveBots left message bodies in the index");
  const bot = await store.getBot(id);
  assert.equal(bot.messages.length, 2, "saveBots dropped the transcript instead of saving it");
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
