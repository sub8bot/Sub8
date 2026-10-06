/**
 * A turn that was running when Sub8 quit or crashed used to vanish: turn state
 * is in memory only, so on restart the bot showed idle and the user's message
 * had no reply. server/interrupted.mts keeps a per-bot marker on disk while a
 * turn runs; boot settles whatever is left. These tests drive that boot path
 * with leftover markers.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-interrupted-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const it = await import("../server/interrupted.mjs");

const results = [];
async function test(name, fn) {
  try {
    await fs.rm(it.inflightPath(), { force: true });
    await fn();
    results.push({ name, ok: true });
    console.log("ok  " + name);
  } catch (err) {
    results.push({ name, ok: false });
    console.error("FAIL " + name);
    console.error(err);
  }
}

const NOW = 1_800_000_000_000;

function marker(over = {}) {
  return {
    botId: "b1",
    turnId: "t1",
    messageIds: ["u1"],
    startedAt: NOW - 60_000,
    source: "user",
    text: "book the flight",
    hidden: false,
    replyTo: null,
    autoRetries: 0,
    ...over,
  };
}

/** A fake server: bots in memory, notices and re-runs recorded. */
function fakeDeps(bots, { ready = true } = {}) {
  const notices = [];
  const reruns = [];
  return {
    notices,
    reruns,
    deps: {
      getBot: async (id) => bots[id] || null,
      deskReady: async () => ready,
      appendNotice: async (botId, row) => {
        notices.push({ botId, row });
        bots[botId]?.messages.push(row);
      },
      rerun: (m) => reruns.push(m),
      now: () => NOW,
    },
  };
}

function userRow(id, content, ts) {
  return { id, role: "user", content, ts };
}

await test("a turn writes a marker and its own end clears it, a stale end does not", async () => {
  await it.markTurnStart(marker());
  let f = await it.readInflight();
  assert.equal(f.turns.b1.turnId, "t1");
  await it.clearTurn("b1", "t0-older");
  f = await it.readInflight();
  assert.ok(f.turns.b1, "an older turn's finally must not clear the newer marker");
  await it.clearTurn("b1", "t1");
  f = await it.readInflight();
  assert.equal(f.turns.b1, undefined);
  const left = (await fs.readdir(tmp)).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));
  assert.deepEqual(left, [], "atomic write leaves no temp or lock files");
});

await test("leftover marker whose reply is already in the transcript is just cleared", async () => {
  await it.markTurnStart(marker());
  const bots = {
    b1: {
      id: "b1",
      name: "Ada",
      messages: [
        userRow("u1", "book the flight", NOW - 60_000),
        { id: "x1", role: "assistant", kind: "tool", content: "browser", ts: NOW - 50_000 },
        { id: "a1", role: "assistant", content: "Booked. Confirmation ABC123.", ts: NOW - 40_000 },
      ],
    },
  };
  const { deps, notices, reruns } = fakeDeps(bots);
  const out = await it.recoverInterrupted(deps);
  assert.deepEqual(out.map((r) => r.action), ["clear"]);
  assert.equal(notices.length, 0);
  assert.equal(reruns.length, 0);
  assert.deepEqual((await it.readInflight()).turns, {});
});

await test("recent user turn cut off mid-work is re-run once, with a notice", async () => {
  await it.markTurnStart(marker());
  const bots = {
    b1: {
      id: "b1",
      name: "Ada",
      messages: [
        userRow("u1", "book the flight", NOW - 60_000),
        { id: "x1", role: "assistant", kind: "tool", content: "browser", ts: NOW - 50_000 },
        // typed into the running turn (a nudge, held only in memory)
        userRow("u2", "aisle seat please", NOW - 30_000),
      ],
    },
  };
  const { deps, notices, reruns } = fakeDeps(bots);
  const out = await it.recoverInterrupted(deps);
  assert.deepEqual(out.map((r) => r.action), ["retry"]);
  assert.equal(notices.length, 1);
  assert.match(notices[0].row.content, /^Sub8 restarted while this was running\. It did not finish/);
  assert.doesNotMatch(notices[0].row.content, /[–—]/, "no em or en dashes");
  assert.equal(notices[0].row.kind, "notice");
  assert.equal(notices[0].row.interrupted.retry, false, "an automatic re-run offers no button");
  assert.equal(reruns.length, 1);
  assert.equal(reruns[0].autoRetries, 1);
  assert.equal(reruns[0].text, "book the flight\naisle seat please", "the nudge rides along");
});

await test("the re-run crashing too gets a notice with Retry, never a second automatic run", async () => {
  // The re-run's own marker carries autoRetries: 1.
  await it.markTurnStart(marker({ turnId: "t2", startedAt: NOW - 20_000, autoRetries: 1 }));
  const bots = { b1: { id: "b1", name: "Ada", messages: [userRow("u1", "book the flight", NOW - 60_000)] } };
  const { deps, notices, reruns } = fakeDeps(bots);
  const out = await it.recoverInterrupted(deps);
  assert.deepEqual(out.map((r) => r.action), ["notice"]);
  assert.equal(reruns.length, 0);
  assert.equal(notices[0].row.interrupted.retry, true);
  assert.match(notices[0].row.content, /Press Retry/);
  // Retry is backed by a stashed entry, usable exactly once.
  const id = notices[0].row.id;
  const first = await it.takeInterrupted(id, "b1");
  assert.equal(first?.kind, "turn");
  assert.equal(first?.text, "book the flight");
  assert.equal(await it.takeInterrupted(id, "b1"), null, "a second press finds nothing");
  // And a later boot has nothing left to recover.
  const again = await it.recoverInterrupted(deps);
  assert.deepEqual(again, []);
});

await test("an old user turn or an unavailable desk gets the notice, not a re-run", async () => {
  await it.markTurnStart(marker({ startedAt: NOW - 11 * 60_000 }));
  const bots = { b1: { id: "b1", name: "Ada", messages: [] } };
  let f = fakeDeps(bots);
  assert.deepEqual((await it.recoverInterrupted(f.deps)).map((r) => r.action), ["notice"]);
  assert.equal(f.reruns.length, 0);

  await it.markTurnStart(marker());
  f = fakeDeps(bots, { ready: false });
  assert.deepEqual((await it.recoverInterrupted(f.deps)).map((r) => r.action), ["notice"]);
  assert.equal(f.reruns.length, 0);
});

await test("routine turns are never re-run automatically", async () => {
  await it.markTurnStart(marker({ source: "routine", hidden: true, messageIds: [], routineNames: ["Inbox sweep"], startedAt: NOW - 5_000 }));
  const bots = { b1: { id: "b1", name: "Ada", messages: [] } };
  const { deps, notices, reruns } = fakeDeps(bots);
  const out = await it.recoverInterrupted(deps);
  assert.deepEqual(out.map((r) => r.action), ["notice"]);
  assert.equal(reruns.length, 0);
  assert.match(notices[0].row.content, /routine "Inbox sweep" was running\. It did not finish\. The next scheduled run/);
  assert.equal(notices[0].row.interrupted.source, "routine");
  assert.equal(it.planRecovery(marker({ source: "routine" }), { messages: [], deskReady: true, now: NOW }), "notice");
  assert.equal(it.planRecovery(marker({ source: "wake" }), { messages: [], deskReady: true, now: NOW }), "notice");
});

await test("a teammate cut off mid-task: notice on the worker and on the waiting lead", async () => {
  await it.markTurnStart(marker({ botId: "w1", source: "wake", replyTo: "lead1", text: "[from Lead] fetch prices" }));
  const bots = { w1: { id: "w1", name: "Pixel", messages: [] }, lead1: { id: "lead1", name: "Lead", messages: [] } };
  const { deps, notices, reruns } = fakeDeps(bots);
  await it.recoverInterrupted(deps);
  assert.equal(reruns.length, 0);
  assert.deepEqual(notices.map((n) => n.botId), ["w1", "lead1"]);
  assert.equal(notices[0].row.interrupted.retry, true);
  assert.match(notices[1].row.content, /Sub8 restarted while Pixel was working on your request/);
  assert.equal(notices[1].row.interrupted.retry, false);
});

await test("a deleted bot's marker is dropped quietly", async () => {
  await it.markTurnStart(marker({ botId: "gone" }));
  const { deps, notices } = fakeDeps({});
  assert.deepEqual((await it.recoverInterrupted(deps)).map((r) => r.action), ["clear"]);
  assert.equal(notices.length, 0);
});

await test("hasReply: a tool step or the setup wait line after the start is not a reply", () => {
  const m = { botId: "b1", startedAt: 100 };
  assert.equal(it.hasReply([{ role: "assistant", content: "old answer", ts: 50 }], m), false);
  assert.equal(it.hasReply([{ role: "assistant", content: "ok", ts: 150 }, { role: "assistant", kind: "think", content: "...", ts: 160 }], m), false);
  assert.equal(it.hasReply([{ id: "a123wait", role: "assistant", content: "Chrome is not ready yet.", ts: 150 }], m), false);
  assert.equal(it.hasReply([{ role: "assistant", kind: "choices", content: "Pick one", ts: 150 }], m), true);
  assert.equal(it.hasReply([{ role: "assistant", content: "report", speakerId: "w9", ts: 150 }], m), false);
});

await test("background Tasks a restart ended: parent gets a notice with Retry, once", async () => {
  const tasks = path.join(tmp, "tasks.json");
  await fs.writeFile(
    tasks,
    JSON.stringify([
      { id: "s1", botId: "b1", type: "executor", status: "running", prompt: "summarise the PDF", createdAt: NOW - 1000 },
      { id: "s2", botId: "b1", type: "executor", status: "done", prompt: "x", createdAt: NOW - 1000 },
    ]),
  );
  const bots = { b1: { id: "b1", name: "Ada", messages: [] } };
  const { deps, notices } = fakeDeps(bots);
  const out = await it.recoverInterruptedTasks(tasks, deps);
  assert.equal(out.length, 1);
  assert.match(notices[0].row.content, /background task was running \(executor: summarise the PDF\)\. It did not finish/);
  assert.equal(notices[0].row.interrupted.source, "task");
  const entry = await it.takeInterrupted(notices[0].row.id, "b1");
  assert.equal(entry?.kind, "subagent");
  assert.equal(entry?.prompt, "summarise the PDF");
  const rows = JSON.parse(await fs.readFile(tasks, "utf8"));
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[1].status, "done");
  assert.equal((await it.recoverInterruptedTasks(tasks, deps)).length, 0, "a second boot reports nothing");
});

await fs.rm(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} interrupted tests passed`);
process.exit(failed.length ? 1 : 0);
