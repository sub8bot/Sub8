/**
 * mcp-sub8's shell tool branched on `job.background` alone to decide whether a
 * job was still going. Two paths come back unfinished and only ONE sets that
 * flag — a job that outruns its block window comes back `status:"running"` with
 * `background` undefined. So the caller fell through to
 * `ok: job.status !== "failed"` (true for "running") with an empty output, and
 * rendered it to the model as "(ok)": a command reported as succeeded while it
 * was still executing.
 *
 * Driven with the real @sub8/shell-exec, not a hand-built fixture.
 */
import assert from "node:assert/strict";
import { shellJobUnfinished } from "../server/mcp-sub8.mjs";
import { startShell, awaitShell } from "@sub8/shell-exec";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How mcp-sub8 rendered a finished job, verbatim. Kept here so the test shows
// what the model actually saw rather than describing it.
const renderFinished = (job) => {
  const r = { ok: job.status !== "failed", output: job.output };
  return r.output || (r.ok ? "(ok)" : "(failed)");
};

await test("a job that outruns its block window is NOT reported as finished", async () => {
  const job = await startShell({
    botId: "test-bot",
    command: "slow",
    blockUntilMs: 30,
    run: async () => {
      await sleep(400);
      return { ok: true, output: "finished late" };
    },
  });

  // The trap, straight from the real package.
  assert.equal(job.status, "running");
  assert.equal(job.background, undefined, "the timeout path does not set background");

  // The old branch would have called this finished and told the model "(ok)".
  assert.equal(Boolean(job.background), false);
  assert.equal(renderFinished(job), "(ok)", "this is the wrong answer the model used to get");

  // The fix: the predicate sees it as unfinished, so the caller returns the job
  // (status + id) instead of a success string.
  assert.equal(shellJobUnfinished(job), true);

  // And it really was still running — it lands afterwards.
  const done = await awaitShell(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.output, "finished late");
});

await test("an explicitly backgrounded job is still treated as unfinished", async () => {
  const job = await startShell({
    botId: "test-bot",
    command: "bg",
    blockUntilMs: 0,
    run: async () => {
      await sleep(50);
      return { ok: true, output: "later" };
    },
  });
  assert.equal(job.background, true);
  assert.equal(job.status, "running");
  assert.equal(shellJobUnfinished(job), true);
  await awaitShell(job.id);
});

await test("a job that actually finished is still reported, ok and failed alike", async () => {
  const good = await startShell({
    botId: "test-bot",
    command: "ok",
    blockUntilMs: 5000,
    run: async () => ({ ok: true, output: "" }),
  });
  assert.equal(good.status, "done");
  assert.equal(shellJobUnfinished(good), false, "a finished job must not be withheld");
  assert.equal(renderFinished(good), "(ok)", "an empty output on a DONE job is still (ok)");

  const bad = await startShell({
    botId: "test-bot",
    command: "bad",
    blockUntilMs: 5000,
    run: async () => ({ ok: false, output: "" }),
  });
  assert.equal(bad.status, "failed");
  assert.equal(shellJobUnfinished(bad), false);
  assert.equal(renderFinished(bad), "(failed)");
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok mcp-shell-report");
process.exit(failed.length ? 1 : 0);
