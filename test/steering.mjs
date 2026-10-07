/**
 * Mid-turn steering (server/steer.mts + driveCli in server/host-cli.mts).
 *
 * A chat line sent while a bot works used to wait for the whole task to end on
 * every CLI harness. Now Claude Code gets it in its live session (stream-json
 * stdin), Grok Build is interrupted and resumed with it, and anything that
 * cannot be steered queues it for right after the turn, with a delivery state
 * the UI shows. These tests drive both with fake CLI children.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-steering-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const { TurnInbox, steerPrompt } = await import("../server/steer.mjs");
const hostCli = await import("../server/host-cli.mjs");

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeChild extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.signals = [];
    this.input = "";
    this.stdinEnded = false;
    this.stdin.on("data", (d) => (this.input += d.toString()));
    this.stdin.on("finish", () => (this.stdinEnded = true));
  }
  kill(sig = "SIGTERM") {
    this.signals.push(sig);
    return true;
  }
  line(obj) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  exit(code = 0) {
    this.killed = true;
    this.stdout.end();
    setImmediate(() => this.emit("close", code));
  }
  inputLines() {
    return this.input.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

function fakeSpawner() {
  const children = [];
  const spawnFn = (bin, args) => {
    const c = new FakeChild(args);
    children.push(c);
    return c;
  };
  return { children, spawnFn };
}

function inboxWithLog(opts = {}) {
  const log = [];
  const inbox = new TurnInbox({ debounceMs: 30, maxWaitMs: 200, onDelivery: (ids, state) => log.push({ ids, state }), ...opts });
  return { inbox, log };
}

// --- TurnInbox ------------------------------------------------------------

await test("lines sent within the debounce window are delivered together", async () => {
  const { inbox, log } = inboxWithLog();
  const batches = [];
  inbox.attach((texts) => {
    batches.push(texts);
    return true;
  });
  inbox.push({ text: "one", messageId: "u1" });
  await wait(10);
  inbox.push({ text: "two", messageId: "u2" });
  await wait(10);
  inbox.push({ text: "three", messageId: "u3" });
  await wait(80);
  assert.deepEqual(batches, [["one", "two", "three"]]);
  assert.deepEqual(log, [{ ids: ["u1", "u2", "u3"], state: "delivered" }]);
  assert.deepEqual(inbox.drain(), []);
});

await test("a harness that cannot be steered queues the line and never drops it", async () => {
  const { inbox, log } = inboxWithLog();
  inbox.unsupported();
  inbox.push({ text: "hello", messageId: "u1" });
  assert.deepEqual(log, [{ ids: ["u1"], state: "queued" }]);
  const left = inbox.drain();
  assert.deepEqual(left.map((n) => n.text), ["hello"]);
});

await test("a steer that fails falls back to queued, and the line survives to the drain", async () => {
  const { inbox, log } = inboxWithLog();
  inbox.attach(() => false);
  inbox.push({ text: "x", messageId: "u9" });
  await wait(60);
  assert.deepEqual(log, [{ ids: ["u9"], state: "queued" }]);
  // Later lines queue at once instead of trying the dead session again.
  inbox.push({ text: "y", messageId: "u10" });
  assert.deepEqual(log.at(-1), { ids: ["u10"], state: "queued" });
  assert.deepEqual(inbox.drain().map((n) => n.text), ["x", "y"]);
});

await test("lines that arrive before the harness attaches go in as soon as it does", async () => {
  const { inbox } = inboxWithLog();
  inbox.push({ text: "early", messageId: "u1" });
  const got = [];
  inbox.attach((texts) => {
    got.push(...texts);
    return true;
  });
  await wait(60);
  assert.deepEqual(got, ["early"]);
});

await test("the API tool loop pull marks lines delivered", async () => {
  const { inbox, log } = inboxWithLog();
  inbox.push({ text: "a", messageId: "u1" });
  assert.deepEqual(inbox.pull(), ["a"]);
  assert.deepEqual(log, [{ ids: ["u1"], state: "delivered" }]);
});

await test("a detached session queues what is still waiting", async () => {
  const { inbox, log } = inboxWithLog({ debounceMs: 1000 });
  inbox.attach(() => true);
  inbox.push({ text: "late", messageId: "u1" });
  inbox.detach();
  assert.deepEqual(log, [{ ids: ["u1"], state: "queued" }]);
  assert.deepEqual(inbox.drain().map((n) => n.text), ["late"]);
});

// --- Claude Code: live stream-json input -----------------------------------

await test("claude: a nudge is written into the live session, one turn, one reply", async () => {
  const { children, spawnFn } = fakeSpawner();
  const { inbox, log } = inboxWithLog();
  const done = hostCli.driveCli({
    provider: "claude",
    bin: "claude",
    args: ["-p", "--input-format", "stream-json"],
    firstInput: hostCli.claudeUserLine("do the long task"),
    steering: inbox.hooks,
    spawnFn,
  });
  const c = children[0];
  await wait(5);
  assert.equal(c.inputLines()[0].message.content[0].text, "do the long task");
  c.line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
  inbox.push({ text: "use the blue one instead", messageId: "u2" });
  await wait(60);
  const lines = c.inputLines();
  assert.equal(lines.length, 2, "the nudge went into stdin");
  assert.equal(lines[1].type, "user");
  assert.match(lines[1].message.content[0].text, /use the blue one instead/);
  assert.match(lines[1].message.content[0].text, /continue the task/);
  assert.ok(lines[1].uuid, "stamped so the lifecycle can be tracked");
  assert.deepEqual(log, [{ ids: ["u2"], state: "delivered" }]);
  assert.equal(c.stdinEnded, false, "stdin stays open while the turn runs");
  c.line({ type: "command_lifecycle", command_uuid: lines[1].uuid, state: "queued" });
  c.line({ type: "command_lifecycle", command_uuid: lines[1].uuid, state: "started" });
  c.line({ type: "assistant", message: { content: [{ type: "text", text: "Switched to the blue one. Done." }] } });
  c.line({ type: "command_lifecycle", command_uuid: lines[1].uuid, state: "completed" });
  c.line({ type: "result", subtype: "success", result: "Switched to the blue one. Done." });
  await wait(10);
  assert.equal(c.stdinEnded, true, "result with nothing waiting closes stdin");
  c.exit(0);
  const reply = await done;
  assert.equal(reply, "Switched to the blue one. Done.");
  assert.equal(children.length, 1, "no second process");
});

await test("claude: a result while a nudge is still queued keeps the session open for it", async () => {
  const { children, spawnFn } = fakeSpawner();
  const { inbox } = inboxWithLog();
  const done = hostCli.driveCli({
    provider: "claude",
    bin: "claude",
    args: [],
    firstInput: hostCli.claudeUserLine("task"),
    steering: inbox.hooks,
    spawnFn,
  });
  const c = children[0];
  inbox.push({ text: "and one more thing", messageId: "u3" });
  await wait(60);
  const uuid = c.inputLines()[1].uuid;
  c.line({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
  c.line({ type: "result", subtype: "success", result: "first part done" });
  await wait(10);
  assert.equal(c.stdinEnded, false, "the queued line still has to run");
  c.line({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  c.line({ type: "assistant", message: { content: [{ type: "text", text: "And the other thing is done too." }] } });
  c.line({ type: "result", subtype: "success", result: "And the other thing is done too." });
  await wait(10);
  assert.equal(c.stdinEnded, true);
  c.exit(0);
  assert.equal(await done, "And the other thing is done too.");
  // After stdin closed, a new line is not lost: it queues for the next turn.
  inbox.push({ text: "after", messageId: "u4" });
  assert.deepEqual(inbox.drain().map((n) => n.text), ["after"]);
});

await test("stop resolves once with Stopped. even with a nudge in flight", async () => {
  const { children, spawnFn } = fakeSpawner();
  const { inbox } = inboxWithLog();
  const ac = new AbortController();
  const done = hostCli.driveCli({
    provider: "claude",
    bin: "claude",
    args: [],
    firstInput: hostCli.claudeUserLine("task"),
    steering: inbox.hooks,
    signal: ac.signal,
    spawnFn,
  });
  inbox.push({ text: "x", messageId: "u1" });
  await wait(60);
  ac.abort();
  children[0].exit(143);
  assert.equal(await done, "Stopped.");
  assert.ok(children[0].signals.includes("SIGTERM"));
});

// --- Grok Build: interrupt + resume -----------------------------------------

await test("grok: a nudge interrupts the run and resumes the same session with it", async () => {
  const { children, spawnFn } = fakeSpawner();
  const { inbox, log } = inboxWithLog();
  const args = ["-p", "book the flight", "--output-format", "streaming-json", "--session-id", "sid-1"];
  const done = hostCli.driveCli({
    provider: "grok-build",
    bin: "grok",
    args,
    steering: inbox.hooks,
    canResume: () => true,
    resumeArgs: (texts) => hostCli.grokResumeArgs(args, "sid-1", steerPrompt(texts)),
    spawnFn,
  });
  const first = children[0];
  first.line({ type: "text", data: "Opening the airline site" });
  inbox.push({ text: "make it an aisle seat", messageId: "u5" });
  inbox.push({ text: "and economy", messageId: "u6" });
  await wait(60);
  assert.deepEqual(first.signals, ["SIGINT"], "interrupted, not killed");
  assert.deepEqual(log, [{ ids: ["u5", "u6"], state: "delivered" }]);
  first.exit(130);
  await wait(10);
  assert.equal(children.length, 2, "continued in a second run");
  const second = children[1].args;
  assert.equal(second.at(-2), "--resume");
  assert.equal(second.at(-1), "sid-1");
  assert.ok(!second.includes("--session-id"));
  const prompt = second[second.indexOf("-p") + 1];
  assert.match(prompt, /make it an aisle seat\n\nand economy/);
  children[1].line({ type: "result", result: "Booked an aisle seat in economy." });
  children[1].exit(0);
  assert.equal(await done, "Booked an aisle seat in economy.");
});

await test("grok: no session on disk yet means the line queues instead", async () => {
  const { children, spawnFn } = fakeSpawner();
  const { inbox, log } = inboxWithLog();
  const done = hostCli.driveCli({
    provider: "grok-build",
    bin: "grok",
    args: ["-p", "x", "--session-id", "s"],
    steering: inbox.hooks,
    canResume: () => false,
    resumeArgs: () => [],
    spawnFn,
  });
  inbox.push({ text: "wait", messageId: "u7" });
  await wait(60);
  assert.deepEqual(children[0].signals, []);
  assert.deepEqual(log, [{ ids: ["u7"], state: "queued" }]);
  children[0].line({ type: "result", result: "done" });
  children[0].exit(0);
  assert.equal(await done, "done");
  assert.deepEqual(inbox.drain().map((n) => n.text), ["wait"]);
});

await test("grok: a resume that fails puts the lines back so they run after the turn", async () => {
  const { children, spawnFn } = fakeSpawner();
  const { inbox } = inboxWithLog();
  const args = ["-p", "x", "--session-id", "s"];
  const done = hostCli.driveCli({
    provider: "grok-build",
    bin: "grok",
    args,
    steering: inbox.hooks,
    canResume: () => true,
    resumeArgs: (texts) => hostCli.grokResumeArgs(args, "s", steerPrompt(texts)),
    spawnFn,
  });
  children[0].line({ type: "text", data: "Halfway there with the report" });
  inbox.push({ text: "skip page two", messageId: "u8" });
  await wait(60);
  children[0].exit(130);
  await wait(10);
  children[1].exit(1);
  assert.equal(await done, "Halfway there with the report");
  assert.deepEqual(inbox.drain().map((n) => n.text), ["skip page two"]);
});

await test("codex and other one-shot harnesses report unsupported", async () => {
  const { children, spawnFn } = fakeSpawner();
  const { inbox, log } = inboxWithLog();
  const done = hostCli.driveCli({ provider: "codex", bin: "codex", args: [], steering: inbox.hooks, spawnFn });
  inbox.push({ text: "q", messageId: "u1" });
  assert.deepEqual(log, [{ ids: ["u1"], state: "queued" }]);
  children[0].exit(0);
  await done;
});

await test("grokResumeArgs swaps the prompt and the session flag", () => {
  const out = hostCli.grokResumeArgs(["-p", "old", "--rules", "r", "--session-id", "abc", "-m", "grok"], "abc", "new");
  assert.deepEqual(out, ["-p", "new", "--rules", "r", "-m", "grok", "--resume", "abc"]);
});

await fs.rm(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} steering tests passed`);
process.exit(failed ? 1 : 0);
