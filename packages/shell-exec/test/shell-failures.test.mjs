/**
 * The happy paths live in shell-exec.test.mjs. This file is the other half: the
 * ways a desk shell goes wrong. Every command the model writes reaches
 * `vm.shell` through `startShell`, so what this module does to a command string,
 * and what it does with a refusal, a non-zero exit or a job that outruns its
 * block window, is what the caller ends up telling the model happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  attachToBot,
  awaitShell,
  getShell,
  listShells,
  resetForTest,
  setOnCompleteWake,
  startShell,
} from "../dist/index.js";

const VIEW_KEYS = ["id", "botId", "command", "status", "output", "startedAt", "finishedAt"];
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a blank botId or command is refused before any job exists", async () => {
  resetForTest();
  const ran = [];
  const run = (c) => {
    ran.push(c);
    return { ok: true, output: "" };
  };
  for (const args of [
    { botId: "", command: "ls", run },
    { botId: "   ", command: "ls", run },
    { botId: null, command: "ls", run },
    { command: "ls", run },
  ]) {
    await assert.rejects(() => startShell(args), /botId required/);
  }
  for (const args of [
    { botId: "b1", command: "", run },
    { botId: "b1", command: "   ", run },
    { botId: "b1", command: "\n\t ", run },
    { botId: "b1", command: null, run },
    { botId: "b1", run },
  ]) {
    await assert.rejects(() => startShell(args), /command required/);
  }
  // A refused call must not leave a phantom job the model can await, and must
  // never reach the runner — a whitespace command would run the display prelude
  // on its own inside the box.
  assert.deepEqual(ran, []);
  assert.deepEqual(listShells(), []);
});

test("the command reaches the runner byte-for-byte, minus the outer trim", async () => {
  resetForTest();
  const seen = [];
  // Quoting is the box's job (vm.shell hands this to `bash -lc`). This module
  // must not re-quote, escape or split it: a command that changes shape between
  // the model and bash runs something the model did not ask for.
  const raw = `  echo "a  b" 'c$d' \\; && printf '%s\\n' $HOME | grep -v "x y"  `;
  await startShell({
    botId: "b1",
    command: raw,
    blockUntilMs: 5_000,
    run: (c) => {
      seen.push(c);
      return { ok: true, output: "" };
    },
  });
  assert.equal(seen[0], raw.trim());
  assert.equal(getShell(listShells("b1")[0].id).command, raw.trim());

  // Inner newlines are preserved; only the ends are trimmed.
  const heredoc = "cat <<'EOF'\nline 1\n  line 2\nEOF";
  await startShell({
    botId: "b1",
    command: `\n${heredoc}\n`,
    blockUntilMs: 5_000,
    run: (c) => {
      seen.push(c);
      return { ok: true, output: "" };
    },
  });
  assert.equal(seen[1], heredoc);
});

test("a runner that refuses the command lands as failed, with the refusal as the output", async () => {
  resetForTest();
  // This is how server/isolation.mjs surfaces a blocked command: assertVmShell
  // throws inside vm.shell, i.e. inside the injected runner.
  const blocked = "shell blocked: host paths are not visible to the bot.";
  const job = await startShell({
    botId: "b1",
    command: "cat /Users/someone/.ssh/id_rsa",
    blockUntilMs: 5_000,
    run: () => {
      throw new Error(blocked);
    },
  });
  assert.equal(job.status, "failed");
  assert.equal(job.output, blocked);
  assert.ok(job.finishedAt > 0, "a refused job is finished, not left open");

  // Backgrounded, the refusal is not visible at call time — the caller gets
  // running/background and only learns it was blocked on the await. Anything
  // that reports on `background` alone reports a refusal as a launch.
  const bg = await startShell({
    botId: "b1",
    command: "xdotool key Return",
    blockUntilMs: 0,
    run: () => {
      throw new Error("shell blocked: do not click or type from the shell.");
    },
  });
  assert.equal(bg.background, true);
  assert.equal(bg.status, "running");
  const settled = await awaitShell(bg.id);
  assert.equal(settled.status, "failed");
  assert.match(settled.output, /do not click or type/);
});

test("a non-zero exit is failed and keeps what the runner said", async () => {
  resetForTest();
  const nonZero = await startShell({
    botId: "b1",
    command: "false",
    blockUntilMs: 5_000,
    run: () => ({ ok: false, output: "bash: nope: command not found" }),
  });
  assert.equal(nonZero.status, "failed");
  assert.equal(nonZero.output, "bash: nope: command not found");

  // `text` is the fallback field, used when the runner has no `output`.
  const stderrOnly = await startShell({
    botId: "b1",
    command: "false",
    blockUntilMs: 5_000,
    run: () => ({ ok: false, text: "permission denied" }),
  });
  assert.equal(stderrOnly.status, "failed");
  assert.equal(stderrOnly.output, "permission denied");

  // An explicitly empty `output` wins over `text` (?? only falls through on
  // null/undefined), so a runner must put the whole message in one field.
  const split = await startShell({
    botId: "b1",
    command: "false",
    blockUntilMs: 5_000,
    run: () => ({ ok: false, output: "", text: "bash: nope: command not found" }),
  });
  assert.equal(split.status, "failed");
  assert.equal(split.output, "");

  // Only ok === false fails. A runner that resolves with nothing is "done".
  const empty = await startShell({ botId: "b1", command: "true", blockUntilMs: 5_000, run: () => undefined });
  assert.equal(empty.status, "done");
  assert.equal(empty.output, "");
});

test("a job that outruns blockUntilMs comes back running, and wakes when it finally lands", async () => {
  resetForTest();
  const wakes = [];
  setOnCompleteWake((w) => wakes.push(w));
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const job = await startShell({
    botId: "b1",
    command: "sleep 60",
    blockUntilMs: 25,
    run: async () => {
      await gate;
      return { ok: true, output: "eventually" };
    },
  });
  assert.equal(job.status, "running");
  assert.equal(job.output, "");
  // NOTE: the timeout path does not set `background`. A caller that branches on
  // `background` alone sees this as a finished job with no output.
  assert.equal(job.background, undefined);
  assert.equal(wakes.length, 0);
  release();
  const done = await awaitShell(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.output, "eventually");
  assert.equal(wakes.length, 1, "outrunning the block window still wakes the parent");
  assert.equal(wakes[0].payload.id, job.id);
  setOnCompleteWake(null);
});

test("a blockUntilMs that is not a positive finite number backgrounds instead of blocking", async () => {
  resetForTest();
  // The tool schema lets the model pass block_until_ms through as-is
  // (`Number(args.block_until_ms)`), so garbage has to background rather than
  // wait forever on a command that never returns.
  const never = () => new Promise(() => {});
  for (const blockUntilMs of [0, "0", -1, Number.NaN, "abc", Infinity, -Infinity, null]) {
    const job = await startShell({ botId: "b1", command: "sleep 999", blockUntilMs, run: never });
    assert.equal(job.background, true, `blockUntilMs=${String(blockUntilMs)} must background`);
    assert.equal(job.status, "running");
  }
  // undefined means "not supplied", which is the 30s default, not background.
  const defaulted = await startShell({
    botId: "b1",
    command: "echo hi",
    blockUntilMs: undefined,
    run: () => ({ ok: true, output: "hi" }),
  });
  assert.equal(defaulted.status, "done");
  assert.equal(defaulted.background, undefined);
});

test("a finished shell does not hold the process open for the rest of its block window", () => {
  // Regression: the block-window timer was left running after the race, so a
  // host process that ran one 5ms shell could not exit for another 30 seconds —
  // the default window. Measured in a child process because that is the damage:
  // the event loop stays busy long after the job is done.
  const storeUrl = JSON.stringify(path.join(pkg, "dist", "index.js"));
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { startShell } from ${storeUrl};
const job = await startShell({ botId: "b1", command: "echo hi", run: () => ({ ok: true, output: "hi" }) });
console.log(job.status);`,
    ],
    { encoding: "utf8", cwd: pkg },
  );
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "done");
  assert.ok(ms < 10_000, `child should exit as soon as the shell is done, took ${ms}ms`);
});

test("a wake handler that throws does not take the job down with it", async () => {
  resetForTest();
  setOnCompleteWake(() => {
    throw new Error("wake queue is full");
  });
  const job = await startShell({
    botId: "b1",
    command: "echo hi",
    blockUntilMs: 0,
    run: () => ({ ok: true, output: "hi" }),
  });
  const done = await awaitShell(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.output, "hi");

  // Anything that is not a function clears the hook rather than being called.
  setOnCompleteWake("not a function");
  const after = await startShell({
    botId: "b1",
    command: "echo again",
    blockUntilMs: 0,
    run: () => ({ ok: true, output: "again" }),
  });
  assert.equal((await awaitShell(after.id)).status, "done");
  setOnCompleteWake(null);
});

test("the view handed out carries no promise and no wake flag", async () => {
  resetForTest();
  const job = await startShell({
    botId: "b1",
    command: "echo hi",
    blockUntilMs: 5_000,
    run: () => ({ ok: true, output: "hi" }),
  });
  // These views are JSON.stringify'd straight into a tool result and stored on
  // the bot row, so an internal field here would be serialised to the model.
  for (const view of [job, getShell(job.id), listShells("b1")[0]]) {
    assert.deepEqual(Object.keys(view).filter((k) => k !== "background"), VIEW_KEYS);
    assert.equal("promise" in view, false);
    assert.equal("wakeOnComplete" in view, false);
    assert.ok(JSON.stringify(view).length > 0);
  }
});

test("listShells is scoped to one bot, and a padded botId is the same bot", async () => {
  resetForTest();
  const run = () => ({ ok: true, output: "" });
  await startShell({ botId: "b1", command: "echo 1", blockUntilMs: 5_000, run });
  await startShell({ botId: "  b1  ", command: "echo 2", blockUntilMs: 5_000, run });
  await startShell({ botId: "b2", command: "echo 3", blockUntilMs: 5_000, run });
  assert.equal(listShells("b1").length, 2, "a padded id must not open a second desk");
  assert.equal(listShells("b2").length, 1);
  assert.equal(listShells("  b1  ").length, 0, "the filter is not trimmed — callers pass bot.id");
  assert.equal(listShells().length, 3);
  assert.equal(listShells("nobody").length, 0);
});

test("awaitShell falls back to the newest job, and an unknown id is null not a hang", async () => {
  resetForTest();
  assert.equal(await awaitShell("no-such-id"), null);
  assert.equal(await awaitShell(), null, "nothing to await is null, not a hang");

  await startShell({ botId: "b1", command: "echo old", blockUntilMs: 5_000, run: () => ({ ok: true, output: "old" }) });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const bg = await startShell({
    botId: "b1",
    command: "sleep 9",
    blockUntilMs: 0,
    run: async () => {
      await gate;
      return { ok: true, output: "newest" };
    },
  });
  release();
  const picked = await awaitShell();
  assert.equal(picked.id, bg.id, "a running job wins over a finished one");
  assert.equal(picked.output, "newest");

  // With nothing running, the last job recorded is the one that comes back.
  const last = await startShell({
    botId: "b2",
    command: "echo last",
    blockUntilMs: 5_000,
    run: () => ({ ok: true, output: "last" }),
  });
  assert.equal((await awaitShell()).id, last.id);
});

test("attachToBot replaces the row for a job instead of stacking copies", async () => {
  resetForTest();
  const bot = {};
  const job = await startShell({
    botId: "b1",
    command: "sleep 9",
    blockUntilMs: 0,
    run: () => ({ ok: true, output: "done" }),
  });
  attachToBot(bot, job);
  assert.equal(bot.backgroundShells.length, 1);
  assert.equal(bot.backgroundShells[0].status, "running");

  const settled = await awaitShell(job.id);
  attachToBot(bot, settled);
  assert.equal(bot.backgroundShells.length, 1, "the same job id must not be appended twice");
  assert.equal(bot.backgroundShells[0].status, "done");
  assert.equal("promise" in bot.backgroundShells[0], false);

  const other = await startShell({
    botId: "b1",
    command: "echo other",
    blockUntilMs: 5_000,
    run: () => ({ ok: true, output: "other" }),
  });
  attachToBot(bot, other);
  assert.equal(bot.backgroundShells.length, 2);

  // No bot row (a wake that outlived the turn) is a pass-through, not a throw.
  assert.equal(attachToBot(null, settled), settled);
  assert.equal(attachToBot(undefined, settled), settled);
});
