/**
 * Mid-task steering on a cloud desk (server/desk-harness/steer-live.mts +
 * runTurn in server/desk-harness/harness.mts).
 *
 * A chat line sent while a cloud bot works reaches the desk as POST /steer. A
 * Claude turn gets it in its live stream-json session; a Grok Build turn is
 * interrupted and resumed in the same session with it. Anything the turn could
 * not take goes back to the caller as delivered:false (the Worker queues it),
 * and a line that was taken but whose resume then failed leaves on the done
 * event as `undelivered`. Fake CLI children only: no claude, no grok, no desk.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-desk-steer-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const { runTurn } = await import("../server/desk-harness/harness.mjs");
const { openLiveTurn, closeLiveTurn, steerLiveTurn, liveTurns } = await import("../server/desk-harness/steer-live.mjs");

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
  } finally {
    liveTurns.clear();
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeChild extends EventEmitter {
  constructor(spec) {
    super();
    this.spec = spec;
    this.args = spec.args;
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
  }
  line(obj) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  exit(code = 0) {
    this.killed = true;
    setImmediate(() => this.emit("close", code));
  }
  inputLines() {
    return this.input.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

/** A spawner that records children; `withSession` writes grok's session file like the CLI does. */
function fakeSpawner({ withSession = false } = {}) {
  const children = [];
  const spawnGrok = (spec) => {
    const c = new FakeChild(spec);
    children.push(c);
    if (withSession) {
      const i = spec.args.indexOf("--session-id");
      const id = i > -1 ? spec.args[i + 1] : "";
      if (id) {
        fsSync.mkdirSync(path.join(spec.home, "sessions"), { recursive: true });
        fsSync.writeFileSync(path.join(spec.home, "sessions", `${id}.json`), "{}");
      }
    }
    return c;
  };
  return { children, spawnGrok };
}

/** Start a turn the way server.mts does: a live record, then runTurn wired to it. */
function startTurn(body, spawner, extra = {}) {
  const live = openLiveTurn(body.botId, Number(body.display || 1), { debounceMs: 20, maxWaitMs: 60 });
  const events = [];
  let closed = null;
  const done = runTurn(body, (e) => events.push(e), {
    spawnGrok: spawner.spawnGrok,
    steering: live.inbox.hooks,
    undelivered: () => (closed ??= closeLiveTurn(live)),
    interruptGraceMs: 200,
    ...extra,
  });
  return { live, events, done };
}

const grokChunk = (text) => ({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });

await test("claude: the prompt goes in on stdin and a steer is written into the live session", async () => {
  const spawner = fakeSpawner();
  const { events, done } = startTurn({ botId: "cloud-c1-kb", display: 2, content: "count slowly from 1 to 30", provider: "claude", model: { id: "claude-sonnet-4-5", apiKey: "sk-test" } }, spawner);
  await wait(40);
  const c = spawner.children[0];
  assert.ok(c, "claude spawned");
  assert.ok(c.args.includes("--input-format"), "stream-json input");
  assert.equal(c.args[c.args.indexOf("--input-format") + 1], "stream-json");
  assert.ok(!c.args.some((a) => /count slowly/.test(a)), "the prompt is not on argv");
  assert.match(c.inputLines()[0].message.content[0].text, /count slowly from 1 to 30/);
  assert.equal(c.stdinEnded, false, "stdin stays open for the turn");

  const steered = await steerLiveTurn({ botId: "cloud-c1-kb", display: 2, messages: [{ id: "u1", text: "stop at 10 and say done" }] }, { waitMs: 2000 });
  assert.equal(steered.delivered, true);
  const lines = c.inputLines();
  assert.equal(lines.length, 2);
  assert.match(lines[1].message.content[0].text, /stop at 10 and say done/);
  assert.ok(lines[1].uuid, "the steer line carries a uuid");

  // Claude reports the queued line, then runs it, then ends the turn.
  c.line({ type: "command_lifecycle", command_uuid: lines[1].uuid, state: "queued" });
  c.line({ type: "command_lifecycle", command_uuid: lines[1].uuid, state: "completed" });
  c.line({ type: "assistant", message: { content: [{ type: "text", text: "Stopped at 10. done" }] } });
  c.line({ type: "result", result: "Stopped at 10. done" });
  await wait(20);
  assert.equal(c.stdinEnded, true, "a result with nothing queued closes stdin");
  c.exit(0);
  const text = await done;
  assert.match(text, /Stopped at 10/);
  const doneEvt = events.find((e) => e.type === "done");
  assert.equal(doneEvt.undelivered, undefined, "nothing left over");
});

await test("claude: a steer after the session closed is handed back, not kept", async () => {
  const spawner = fakeSpawner();
  const { events, done } = startTurn({ botId: "kb", display: 1, content: "hi", provider: "claude", model: { id: "claude-sonnet-4-5", apiKey: "sk-test" } }, spawner);
  await wait(40);
  const c = spawner.children[0];
  c.line({ type: "result", result: "hello" });
  await wait(10);
  const steered = await steerLiveTurn({ botId: "kb", display: 1, messages: ["one more thing"] }, { waitMs: 2000 });
  assert.equal(steered.delivered, false);
  assert.equal(steered.reason, "not-steerable");
  c.exit(0);
  await done;
  assert.equal(events.find((e) => e.type === "done").undelivered, undefined, "the Worker queues it; the desk must not hand it back twice");
});

await test("grok: a steer interrupts the run and resumes the same session with it", async () => {
  const spawner = fakeSpawner({ withSession: true });
  const { events, done } = startTurn({ botId: "kb", display: 3, content: "count", provider: "xai", model: { id: "grok-4.6", apiKey: "xai-test" } }, spawner);
  await wait(40);
  const first = spawner.children[0];
  const sid = first.args[first.args.indexOf("--session-id") + 1];
  first.stdout.write(`${JSON.stringify(grokChunk("1 2 3"))}\n`);
  const pending = steerLiveTurn({ botId: "kb", display: 3, messages: [{ id: "u9", text: "stop at 10 and say done" }] }, { waitMs: 2000 });
  const steered = await pending;
  assert.equal(steered.delivered, true);
  assert.deepEqual(first.signals, ["SIGINT"], "interrupted, not killed");
  first.exit(130);
  await wait(20);
  const second = spawner.children[1];
  assert.ok(second, "resumed");
  assert.equal(second.args[second.args.indexOf("--resume") + 1], sid, "same session");
  assert.ok(!second.args.includes("--session-id"));
  assert.match(second.args[second.args.indexOf("-p") + 1], /stop at 10 and say done/);
  second.stdout.write(`${JSON.stringify(grokChunk("Stopped at 10. done"))}\n`);
  second.exit(0);
  const text = await done;
  assert.match(text, /Stopped at 10/);
  assert.equal(events.find((e) => e.type === "done").undelivered, undefined);
});

await test("grok: a resume that fails puts the line on the done event as undelivered", async () => {
  const spawner = fakeSpawner({ withSession: true });
  const { events, done } = startTurn({ botId: "kb", display: 3, content: "count", provider: "xai", model: { id: "grok-4.6", apiKey: "xai-test" } }, spawner);
  await wait(40);
  const first = spawner.children[0];
  first.stdout.write(`${JSON.stringify(grokChunk("Counting 1 2 3"))}\n`);
  assert.equal((await steerLiveTurn({ botId: "kb", display: 3, messages: ["stop at 10"] }, { waitMs: 2000 })).delivered, true);
  first.exit(130);
  await wait(20);
  spawner.children[1].exit(1);
  const text = await done;
  assert.match(text, /Counting 1 2 3/, "keeps what it said before the line");
  assert.deepEqual(events.find((e) => e.type === "done").undelivered, ["stop at 10"]);
});

await test("grok: no session on disk yet means the line is handed back to queue", async () => {
  const spawner = fakeSpawner({ withSession: false });
  const { events, done } = startTurn({ botId: "kb", display: 1, content: "count", provider: "xai", model: { id: "grok-4.6", apiKey: "xai-test" } }, spawner);
  await wait(40);
  const steered = await steerLiveTurn({ botId: "kb", display: 1, messages: ["stop"] }, { waitMs: 2000 });
  assert.equal(steered.delivered, false);
  assert.equal(steered.reason, "not-steerable");
  assert.deepEqual(spawner.children[0].signals, []);
  spawner.children[0].stdout.write(`${JSON.stringify(grokChunk("done"))}\n`);
  spawner.children[0].exit(0);
  await done;
  assert.equal(events.find((e) => e.type === "done").undelivered, undefined);
});

await test("steer with no turn, or another bot's turn on that display, is not delivered", async () => {
  assert.equal((await steerLiveTurn({ botId: "kb", display: 1, messages: ["x"] })).reason, "no-turn");
  openLiveTurn("lead", 1);
  const other = await steerLiveTurn({ botId: "kb", display: 1, messages: ["x"] });
  assert.equal(other.delivered, false);
  assert.equal(other.reason, "other-bot");
  assert.equal((await steerLiveTurn({ botId: "kb", display: 1, messages: [] })).reason, "empty");
});

await test("a turn that never takes the line times out and the line is taken back", async () => {
  // No harness attached yet (still preparing the turn): the inbox holds it.
  const live = openLiveTurn("kb", 2, { debounceMs: 10, maxWaitMs: 20 });
  const steered = await steerLiveTurn({ botId: "kb", display: 2, messages: [{ id: "m1", text: "late" }] }, { waitMs: 50 });
  assert.equal(steered.delivered, false);
  assert.equal(steered.reason, "timeout");
  assert.equal(live.inbox.nudges.length, 0, "taken back out");
  assert.deepEqual(closeLiveTurn(live), [], "the turn does not hand it back a second time");
});

await test("a caller still waiting when the turn ends hears turn-ended", async () => {
  const live = openLiveTurn("kb", 2, { debounceMs: 10, maxWaitMs: 20 });
  const pending = steerLiveTurn({ botId: "kb", display: 2, messages: [{ id: "m2", text: "late" }] }, { waitMs: 2000 });
  await wait(5);
  assert.deepEqual(closeLiveTurn(live), []);
  const r = await pending;
  assert.equal(r.delivered, false);
  assert.equal(r.reason, "turn-ended");
});

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} desk steering tests passed`);
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(failed ? 1 : 0);
