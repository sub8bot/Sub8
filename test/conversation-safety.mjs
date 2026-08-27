/**
 * Two proven data-loss paths in the transcript store.
 *
 * 1. appendMessage did load -> push -> replace with nothing serialising it, so
 *    two turns on one team overlapping (a chief plus its workers, the normal
 *    case) lost a message outright — deterministically in-process, and far
 *    worse across processes since mcp-sub8 runs as a separate one.
 * 2. loadConversation collapsed EVERY read failure into [], and the write path
 *    then persisted that []. One unreadable read erased the whole transcript:
 *    measured 400 messages -> 0 bytes.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-convo-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("../packages/store/dist/index.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("ok  " + name);
  } catch (err) {
    results.push({ name, ok: false });
    console.error("FAIL " + name);
    console.error(err);
  }
}

await test("concurrent appends do not lose messages", async () => {
  const id = "team-concurrent";
  const n = 25;
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      store.appendConversation(id, [{ id: `m${i}`, role: "user", content: `msg ${i}`, ts: 1000 + i }]),
    ),
  );
  const rows = await store.loadConversation(id);
  assert.equal(rows.length, n, `expected ${n} messages, got ${rows.length}`);
  const ids = new Set(rows.map((r) => r.id));
  for (let i = 0; i < n; i += 1) assert.ok(ids.has(`m${i}`), `lost m${i}`);
});

await test("an unreadable transcript is never overwritten with an empty one", async () => {
  const id = "bot-unreadable";
  const original = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, role: "user", content: `m${i}`, ts: i }));
  await store.saveConversation(id, original);
  const file = store.conversationPath(id);
  const before = (await fs.stat(file)).size;
  assert.ok(before > 500, "seeded a real transcript");

  // Stand in for the real failures: EACCES on a desk, or a transcript past
  // V8's string cap. Either way the parse fails and the rows are NOT gone.
  await fs.writeFile(file, "{ this is not json", "utf8");

  await assert.rejects(() => store.saveConversation(id, [{ id: "new", role: "user", content: "hi", ts: 99 }]), /unreadable/);
  await assert.rejects(() => store.appendConversation(id, [{ id: "new2", role: "user", content: "hi", ts: 100 }]), /unreadable/);

  // The damaged file is left exactly as it was for recovery, not truncated.
  assert.equal(await fs.readFile(file, "utf8"), "{ this is not json");
});

await test("a missing transcript is still just an empty one", async () => {
  const rows = await store.loadConversation("bot-never-existed");
  assert.deepEqual(rows, []);
  // ...and writing to it works, so ENOENT is not confused with a failure.
  const saved = await store.saveConversation("bot-never-existed", [{ id: "a", role: "user", content: "x", ts: 1 }]);
  assert.equal(saved.length, 1);
});

await test("getBot returns the same rows as loadBots while reading one transcript", async () => {
  // getBot went through loadBots, which parses EVERY bot's transcript -- 22 ms
  // per call against a 7 MB one, on every route that touches a bot and on the
  // 5s/15s timers. It now reads only the bot it was asked for, so this pins
  // that the narrowing did not change what comes back.
  const ids = ["scoped-a", "scoped-b"];
  for (const [n, id] of ids.entries()) {
    await store.upsertBot({ id, name: `Bot ${id}`, messages: [] });
    await store.saveConversation(
      id,
      Array.from({ length: 3 + n }, (_, i) => ({ id: `${id}-m${i}`, role: "user", content: `hi ${i}`, ts: i })),
    );
  }
  const all = await store.loadBots();
  for (const id of ids) {
    const viaAll = all.find((b) => b.id === id);
    const viaOne = await store.getBot(id);
    assert.ok(viaOne, `${id} still resolves`);
    assert.equal(viaOne.name, viaAll.name);
    assert.deepEqual(
      (viaOne.messages || []).map((m) => m.id),
      (viaAll.messages || []).map((m) => m.id),
      `${id} must carry its full transcript`,
    );
  }
  // A row that does not exist is still null, not an index-only stub.
  assert.equal(await store.getBot("no-such-bot"), null);

  // The narrowing itself is invisible to a correctness assertion -- loading
  // every transcript returns exactly the same rows, just slower -- and a
  // timing assertion would be flaky. So pin the mechanism.
  const src = await fs.readFile(new URL("../packages/store/src/store.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /loadBotsUnlocked\(want\)/,
    "getBot must ask for one transcript; loading all of them costs 22 ms a call",
  );
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok conversation-safety");
process.exit(failed.length ? 1 : 0);
