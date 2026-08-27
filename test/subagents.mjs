import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-subagents-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const {
  spawn,
  list,
  get,
  stop,
  message,
  completeForTest,
  toolsForType,
  SUBAGENT_TOOL_ALLOWLIST,
  resetForTest,
  takeWakes,
  setTurnRunner,
  defaultHarnessTurn,
} = await import("../server/subagents.mjs");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log("ok  " + name);
    })
    .catch((err) => {
      console.error("not ok " + name);
      throw err;
    });
}

resetForTest();

await test("spawn executor returns running and has no send_message", async () => {
  resetForTest();
  const job = await spawn({ botId: "bot-a", type: "executor", prompt: "Summarize /config/workspace/notes.md" });
  assert.equal(job.status, "running");
  assert.ok(job.id);
  assert.equal(job.type, "executor");
  assert.equal(job.parentBotId, "bot-a");
  assert.equal("send_message" in job, false);
  assert.ok(Array.isArray(job.tools));
  assert.ok(!job.tools.includes("send_message"));
  assert.ok(!job.tools.includes("SendMessage"));
  assert.deepEqual(job.tools, SUBAGENT_TOOL_ALLOWLIST.executor);
});

await test("executor tool allowlist has no send_message", () => {
  const tools = toolsForType("executor");
  assert.ok(!tools.includes("send_message"));
  assert.ok(!tools.includes("SendMessage"));
  for (const [type, allow] of Object.entries(SUBAGENT_TOOL_ALLOWLIST)) {
    assert.ok(!allow.includes("send_message"), `${type} allowlist`);
    assert.equal(Object.hasOwn(allow, "send_message"), false);
  }
});

await test("list / get / stop", async () => {
  resetForTest();
  const a = await spawn({ botId: "bot-a", type: "executor", prompt: "task a" });
  const b = await spawn({ botId: "bot-b", type: "executor", prompt: "task b" });
  const all = await list();
  assert.equal(all.length, 2);
  const mine = await list("bot-a");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, a.id);
  const got = await get(b.id);
  assert.equal(got.id, b.id);
  assert.equal(got.status, "running");
  const stopped = await stop(a.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal((await get(a.id)).status, "cancelled");
  assert.equal((await get("missing")), null);
});

await test("message steers a running worker", async () => {
  resetForTest();
  const job = await spawn({ botId: "bot-a", type: "executor", prompt: "work" });
  const next = await message(job.id, "also count md files");
  assert.equal(next.status, "running");
  assert.equal(next.id, job.id);
});

await test("completeForTest wakes parent with result", async () => {
  resetForTest();
  const job = await spawn({ botId: "parent-1", type: "executor", prompt: "count files" });
  const wake = completeForTest(job.id, { files: 3 });
  assert.deepEqual(wake, {
    type: "subagent-complete",
    parentBotId: "parent-1",
    id: job.id,
    result: { files: 3 },
  });
  assert.equal((await get(job.id)).status, "done");
  assert.deepEqual((await get(job.id)).result, { files: 3 });
  const queued = takeWakes();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, "subagent-complete");
});

await test("two computerUse subagents for the same bot throws", async () => {
  resetForTest();
  const first = await spawn({ botId: "desk-1", type: "computerUse", prompt: "click the login button" });
  assert.equal(first.status, "running");
  await assert.rejects(
    () => spawn({ botId: "desk-1", type: "computerUse", prompt: "click something else" }),
    /at most one running per bot/,
  );
  const other = await spawn({ botId: "desk-2", type: "computerUse", prompt: "other desk" });
  assert.equal(other.status, "running");
  await stop(first.id);
  const again = await spawn({ botId: "desk-1", type: "computerUse", prompt: "slot free again" });
  assert.equal(again.status, "running");
});

await test("two executors on the same bot are allowed", async () => {
  resetForTest();
  const a = await spawn({ botId: "bot-a", type: "executor", prompt: "job one" });
  const b = await spawn({ botId: "bot-a", type: "executor", prompt: "job two" });
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  assert.notEqual(a.id, b.id);
});

await test("stop does not fire a complete wake", async () => {
  resetForTest();
  const job = await spawn({ botId: "bot-a", type: "executor", prompt: "abort me" });
  await stop(job.id);
  assert.equal(takeWakes().length, 0);
});

await test("turn runner completes and wakes parent", async () => {
  resetForTest();
  setTurnRunner(async (job) => ({ wrote: job.prompt }));
  const job = await spawn({ botId: "parent-run", type: "executor", prompt: "write hello" });
  for (let i = 0; i < 40; i++) {
    const row = await get(job.id);
    if (row.status === "done") {
      assert.deepEqual(row.result, { wrote: "write hello" });
      assert.equal(takeWakes()[0].type, "subagent-complete");
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("runner did not complete");
});

await test("defaultHarnessTurn posts /turn without send_message", async () => {
  resetForTest();
  const posted = [];
  const result = await defaultHarnessTurn(
    {
      type: "executor",
      botId: "p1",
      prompt: "write /config/workspace/out.txt",
      harnessUrl: "http://task.test",
      harnessToken: "tok",
    },
    {
      runTurn: async ({ url, token, body }) => {
        posted.push({ url, token, body });
        assert.ok(!body.tools.includes("send_message"));
        assert.match(body.system, /Never send_message/);
        return { content: "wrote out.txt" };
      },
    },
  );
  assert.equal(posted[0].url, "http://task.test");
  assert.equal(posted[0].token, "tok");
  assert.equal(result.content, "wrote out.txt");
});

await test("spawn with harnessUrl fails closed when /turn is down", async () => {
  resetForTest();
  const job = await spawn({
    botId: "p2",
    type: "executor",
    prompt: "touch a file",
    harnessUrl: "http://127.0.0.1:9",
  });
  for (let i = 0; i < 40; i++) {
    const row = await get(job.id);
    if (row.status === "failed") {
      assert.match(row.error || "", /harness url|fetch|ECONNREFUSED|failed/i);
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("expected failed task");
});

await test("computerUse on the same desk is display busy", async () => {
  resetForTest();
  await spawn({ botId: "a", type: "computerUse", prompt: "click", computerId: "desk-x" });
  await assert.rejects(
    () => spawn({ botId: "b", type: "computerUse", prompt: "click too", computerId: "desk-x" }),
    /display busy/,
  );
});

await test("check/message/stop are scoped to the caller's own tasks", async () => {
  resetForTest();
  const job = await spawn({ botId: "botA", type: "executor", prompt: "secret work for A" });

  // Bot B holding the id must not read the prompt, steer it, or cancel it.
  assert.equal(await get(job.id, "botB"), null);
  await assert.rejects(() => message(job.id, "do X instead", "botB"), /not found/);
  await assert.rejects(() => stop(job.id, "botB"), /not found/);

  // The owner still can, and an omitted botId stays unscoped for internal callers.
  assert.equal((await get(job.id, "botA")).id, job.id);
  assert.equal((await get(job.id)).id, job.id);
  assert.equal((await stop(job.id, "botA")).status, "cancelled");
});

await test("stop aborts the worker's harness turn, not just its label", async () => {
  resetForTest();
  let seen = null;
  let release = null;
  const held = new Promise((r) => {
    release = r;
  });
  // Stand in for runDeskTurn: capture the signal and block until stopped.
  const runTurn = async ({ signal }) => {
    seen = signal;
    await held;
    return { content: "too late" };
  };
  setTurnRunner((row) => defaultHarnessTurn(row, { runTurn }));
  const job = await spawn({ botId: "a", type: "executor", prompt: "long job", harnessUrl: "http://127.0.0.1:1/x" });
  for (let i = 0; i < 40 && !seen; i += 1) await new Promise((r) => setTimeout(r, 10));

  assert.ok(seen, "the worker's turn was given an abort signal");
  assert.equal(seen.aborted, false);
  await stop(job.id);
  // Hanging up the fetch is what reaches the desk; without it the grok child
  // kept driving the display for up to 20 minutes after a stop_subagent.
  assert.equal(seen.aborted, true, "stop() aborted the in-flight turn");
  release();
  setTurnRunner(null);
});

await test("an aborted desk turn is not reported to the parent as done", async () => {
  resetForTest();
  // What desk-harness answers an abort with: a done event, no error event.
  const runTurn = async () => ({ content: "Stopped." });
  const row = await spawn({
    botId: "a",
    type: "executor",
    prompt: "job",
    harnessUrl: "http://127.0.0.1:1/x",
  });
  setTurnRunner((job) => defaultHarnessTurn(job, { runTurn }));
  const done = await defaultHarnessTurn({ id: row.id, botId: "a", type: "executor", prompt: "job", harnessUrl: "http://127.0.0.1:1/x" }, { runTurn }).then(
    () => "resolved",
    (e) => String(e.message),
  );
  assert.match(done, /stopped/i, "a stopped turn must not resolve as a successful result");
  setTurnRunner(null);
});

await test("teammates on DIFFERENT displays of one desk do not collide", async () => {
  resetForTest();
  // A desk runs several X displays and teammates sit on different ones. Keying
  // the guard on the desk alone would block the normal case: two teammates
  // each running an executor at the same time.
  await spawn({ botId: "a", type: "executor", prompt: "drive", computerId: "desk-z", display: ":1" });
  await spawn({ botId: "b", type: "executor", prompt: "drive too", computerId: "desk-z", display: ":2" });
  assert.equal((await list()).filter((r) => r.status === "running").length, 2);
  // ...but two on the SAME display still collide.
  await assert.rejects(
    () => spawn({ botId: "c", type: "executor", prompt: "third", computerId: "desk-z", display: ":2" }),
    /display busy/,
  );
});

await test("a second computer-driving worker on the same desk is display busy", async () => {
  resetForTest();
  // executor carries `computer` too -- three of them on one desk meant three
  // grok children driving the same X display, past the computerUse guard.
  await spawn({ botId: "a", type: "executor", prompt: "drive", computerId: "desk-y" });
  await assert.rejects(
    () => spawn({ botId: "a", type: "executor", prompt: "drive too", computerId: "desk-y" }),
    /display busy/,
  );
  await assert.rejects(
    () => spawn({ botId: "b", type: "computerUse", prompt: "click", computerId: "desk-y" }),
    /display busy/,
  );
  // A type with no `computer` in its allowlist is not on the display at all.
  await spawn({ botId: "c", type: "browserUse", prompt: "browse", computerId: "desk-y" });
});

await test("two deskless executors on one bot are still allowed", async () => {
  resetForTest();
  await spawn({ botId: "a", type: "executor", prompt: "one" });
  await spawn({ botId: "a", type: "executor", prompt: "two" });
  assert.equal((await list("a")).length, 2);
});

await test("message_subagent says it was not delivered", async () => {
  resetForTest();
  const job = await spawn({ botId: "a", type: "executor", prompt: "job" });
  const out = await message(job.id, "do X instead", "a");
  assert.equal(out.delivered, false);
  assert.match(out.note, /not delivered/i);
});

console.log("ok subagents");
