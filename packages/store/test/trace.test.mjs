/**
 * server/trace.mjs had no test of its own. The contract worth pinning is that
 * tracing NEVER breaks the thing it is tracing: `write` swallows everything,
 * and `span` records the failure and then rethrows the original error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-trace-"));
process.env.SUB8BOT_DATA = tmp;

// The traces dir binds at import, so SUB8BOT_DATA has to be set first.
const trace = await import("../dist/trace.js");

const bot = { id: "11111111-1111-4111-8111-111111111111", vm: { container: "localbot-abc" } };

test("write stamps the bot and container, and read returns the tail newest-last", async () => {
  for (let i = 0; i < 3; i += 1) await trace.write(bot, { op: "screenshot", n: i });
  const rows = await trace.read(bot.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.n), [0, 1, 2]);
  assert.equal(rows[0].botId, bot.id);
  assert.equal(rows[0].container, "localbot-abc");
  assert.ok(rows[0].ts > 0);
  assert.equal((await trace.read(bot.id, 2)).length, 2);
});

test("read of a bot that never traced is empty, not a throw", async () => {
  assert.deepEqual(await trace.read("22222222-2222-4222-8222-222222222222"), []);
});

test("write never throws, even with no bot at all", async () => {
  await trace.write(null, { op: "nothing" });
  await trace.write(undefined, { op: "nothing" });
});

test("span records ok:true and hands back the result", async () => {
  const out = await trace.span(bot, "shell", "exec", "ls", async () => "done");
  assert.equal(out, "done");
  const last = (await trace.read(bot.id)).at(-1);
  assert.equal(last.ok, true);
  assert.equal(last.tunnel, "shell");
  assert.equal(last.op, "exec");
  assert.equal(last.detail, "ls");
  assert.ok(last.ms >= 0);
});

test("span records the failure and rethrows the original error", async () => {
  await assert.rejects(
    () =>
      trace.span(bot, "computer", "click", { x: 1 }, async () => {
        throw new Error("desk is down");
      }),
    /desk is down/,
  );
  const last = (await trace.read(bot.id)).at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.error, "desk is down");
  assert.equal(last.op, "click");
});

test.after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
