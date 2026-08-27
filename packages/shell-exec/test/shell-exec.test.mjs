import test from "node:test";
import assert from "node:assert/strict";
import { startShell, awaitShell, resetForTest, listShells, setOnCompleteWake } from "../dist/index.js";

resetForTest();

test("a shell that finishes inside blockUntilMs comes back done", async () => {
  const job = await startShell({
    botId: "b1",
    command: "echo hi",
    blockUntilMs: 5_000,
    run: async () => ({ ok: true, output: "hi\n" }),
  });
  assert.equal(job.status, "done");
  assert.match(job.output, /hi/);
  assert.equal(job.background, undefined);
});

test("blockUntilMs 0 returns running and awaitShell picks it up later", async () => {
  let released;
  const gate = new Promise((r) => {
    released = r;
  });
  const job = await startShell({
    botId: "b1",
    command: "sleep 9",
    blockUntilMs: 0,
    run: async () => {
      await gate;
      return { ok: true, output: "later" };
    },
  });
  assert.equal(job.background, true);
  assert.equal(job.status, "running");
  released();
  const done = await awaitShell(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.output, "later");
  assert.equal(listShells("b1").length, 2);
});

test("only a backgrounded job wakes the parent when it finishes", async () => {
  const wakes = [];
  setOnCompleteWake((w) => wakes.push(w));
  const job = await startShell({
    botId: "b1",
    command: "echo done",
    blockUntilMs: 5_000,
    run: async () => ({ ok: true, output: "sync" }),
  });
  assert.equal(job.status, "done");
  assert.equal(wakes.length, 0, "in-turn wait does not wake");
  let go;
  const gate = new Promise((r) => {
    go = r;
  });
  const bg = await startShell({
    botId: "b1",
    command: "sleep",
    blockUntilMs: 0,
    run: async () => {
      await gate;
      return { ok: true, output: "bg-done" };
    },
  });
  assert.equal(bg.background, true);
  assert.equal(wakes.length, 0);
  go();
  const done = await awaitShell(bg.id);
  assert.equal(done.status, "done");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].type, "shell");
  assert.equal(wakes[0].botId, "b1");
  assert.equal(wakes[0].payload.id, bg.id);
  setOnCompleteWake(null);
});
