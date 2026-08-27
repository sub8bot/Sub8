/**
 * `jobs` is a module-level Map shared by every bot in the process — one server
 * runs them all — and awaitShell(id?) used to pick the newest RUNNING job
 * across the WHOLE map when no id was given.
 *
 * The tool schema makes `id` optional and its description ("Wait on a
 * background shell") invites the bare call, so bot A calling await_shell with
 * no id blocked on teammate B's command and was handed back B's botId, command
 * and full output — which attachToBot then persisted onto A's row.
 *
 * listShells(botId) has always filtered and startShell has always required a
 * botId; awaitShell was the odd one out.
 *
 * Also pinned here: backgroundShells is capped. Each entry carries a command's
 * whole output and the list is persisted on the bot row, so unbounded growth
 * cost every store write — a routine running `shell` every 5 minutes adds ~288
 * entries a day.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startShell, awaitShell, attachToBot, resetForTest } from "../dist/index.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("a bare await_shell never returns another bot's job", async () => {
  resetForTest();
  // B's job is the newest running one in the shared map.
  await startShell({
    botId: "bot-B",
    command: "secret-command --token hunter2",
    blockUntilMs: 0,
    run: async () => {
      await settle(50);
      return { ok: true, output: "B's private output" };
    },
  });

  const got = await awaitShell(undefined, "bot-A");
  assert.equal(got, null, "bot A was handed bot B's job");
});

test("a bare await_shell still returns the caller's own job", async () => {
  resetForTest();
  await startShell({
    botId: "bot-A",
    command: "mine",
    blockUntilMs: 0,
    run: async () => ({ ok: true, output: "A's output" }),
  });
  await startShell({
    botId: "bot-B",
    command: "theirs",
    blockUntilMs: 0,
    run: async () => ({ ok: true, output: "B's output" }),
  });

  const got = await awaitShell(undefined, "bot-A");
  assert.ok(got, "bot A lost access to its own job");
  assert.equal(got.botId, "bot-A");
  assert.equal(got.command, "mine");
});

// Guessing an id must not work either.
test("an explicit id belonging to another bot is refused", async () => {
  resetForTest();
  const started = await startShell({
    botId: "bot-B",
    command: "theirs",
    blockUntilMs: 0,
    run: async () => ({ ok: true, output: "B's output" }),
  });
  assert.equal(await awaitShell(started.id, "bot-A"), null, "bot A awaited bot B's job by id");
  const own = await awaitShell(started.id, "bot-B");
  assert.equal(own?.id, started.id, "the owner can still await it");
});

// No botId keeps the old cross-bot behaviour, which is what an internal caller
// that legitimately has no bot context gets.
test("omitting botId is unscoped, as before", async () => {
  resetForTest();
  const started = await startShell({
    botId: "bot-B",
    command: "theirs",
    blockUntilMs: 0,
    run: async () => ({ ok: true, output: "out" }),
  });
  assert.equal((await awaitShell(started.id))?.id, started.id);
});

test("backgroundShells is capped, newest kept", async () => {
  resetForTest();
  const bot = { id: "bot-A", backgroundShells: [] };
  for (let i = 0; i < 60; i++) {
    attachToBot(bot, { id: `job-${i}`, botId: "bot-A", command: `c${i}`, status: "done", output: "x".repeat(500) });
  }
  assert.ok(bot.backgroundShells.length <= 20, `grew to ${bot.backgroundShells.length}`);
  assert.equal(bot.backgroundShells.at(-1).id, "job-59", "the newest must survive");
  assert.equal(
    bot.backgroundShells.some((j) => j.id === "job-0"),
    false,
    "the oldest must be dropped",
  );
});

test("re-attaching the same job id still replaces rather than duplicates", async () => {
  resetForTest();
  const bot = { id: "bot-A", backgroundShells: [] };
  const job = { id: "job-x", botId: "bot-A", command: "c", status: "running", output: "" };
  attachToBot(bot, job);
  attachToBot(bot, { ...job, status: "done", output: "finished" });
  assert.equal(bot.backgroundShells.length, 1);
  assert.equal(bot.backgroundShells[0].status, "done");
});
