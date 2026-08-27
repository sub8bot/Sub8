import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// dataRoot() reads the env on every call, but load() runs at import time — so
// the tmp dir has to be in place before the module is pulled in.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wake-queue-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);

const {
  enqueueWake,
  flushWakes,
  listQueuedBotIds,
  listWakes,
  resetForTest,
  subscribeWakes,
  takeMatchingWake,
  takeWake,
  takeWakeById,
  takeWakeOfType,
  turnPromptForWake,
} = await import(dist);

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Read the durable ledger back in a fresh process — a real restart, not a re-read. */
async function reload(dataDir) {
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const w = await import(${JSON.stringify(dist)});
       const out = {};
       for (const id of w.listQueuedBotIds()) out[id] = w.listWakes(id);
       process.stdout.write(JSON.stringify(out));`,
    ],
    { env: { ...process.env, SUB8BOT_DATA: dataDir, OCTOBOT_DATA: dataDir } },
  );
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Queue identity. Two notes for the same bot are two turns, not one.
// ---------------------------------------------------------------------------

test("a second wake queues behind the first, it never replaces it", () => {
  resetForTest();
  const bot = uid(1);
  const a = enqueueWake({ type: "peer", botId: bot, payload: { content: "one" } });
  const b = enqueueWake({ type: "peer", botId: bot, payload: { content: "one" } });
  assert.notEqual(a.id, b.id, "each wake gets its own id even with an identical payload");
  assert.equal(listWakes(bot).length, 2, "identical wakes are not de-duplicated");
  assert.equal(takeWake(bot).id, a.id);
  assert.equal(takeWake(bot).id, b.id);
  assert.equal(takeWake(bot), null);
});

test("the payload is copied in on enqueue and out on read", () => {
  resetForTest();
  const bot = uid(2);
  const payload = { content: "as sent" };
  enqueueWake({ type: "peer", botId: bot, payload });
  payload.content = "mutated after the fact";
  assert.equal(listWakes(bot)[0].payload.content, "as sent");

  const listed = listWakes(bot);
  listed[0].payload.content = "tampered by a reader";
  assert.equal(takeWake(bot).payload.content, "as sent", "listWakes hands out copies, not the ledger");
});

test("a payload that is not a plain object becomes an empty one", () => {
  resetForTest();
  const bot = uid(3);
  assert.deepEqual(enqueueWake({ type: "peer", botId: bot, payload: ["a", "b"] }).payload, {});
  assert.deepEqual(enqueueWake({ type: "peer", botId: bot, payload: "hello" }).payload, {});
  assert.deepEqual(enqueueWake({ type: "peer", botId: bot }).payload, {});
  assert.equal(turnPromptForWake(listWakes(bot)[0]), "A teammate sent a note:");
});

// ---------------------------------------------------------------------------
// Lanes. The order a bot wakes up in is the order the operator experiences.
// ---------------------------------------------------------------------------

test("a user wake outranks a priority peer wake, which outranks everything else", () => {
  resetForTest();
  const bot = uid(4);
  enqueueWake({ type: "routine", botId: bot, payload: { n: 1 } });
  enqueueWake({ type: "peer", botId: bot, payload: { n: 2 }, priority: true });
  enqueueWake({ type: "channel", botId: bot, payload: { n: 3 }, user: true });
  enqueueWake({ type: "peer", botId: bot, payload: { n: 4 } });
  assert.deepEqual([takeWake(bot), takeWake(bot), takeWake(bot), takeWake(bot)].map((w) => w.payload.n), [3, 2, 4, 1]);
});

test("inside one lane the order is arrival order, not id or payload order", () => {
  resetForTest();
  const bot = uid(5);
  for (const n of [3, 1, 2]) enqueueWake({ type: "routine", botId: bot, payload: { n } });
  assert.deepEqual([takeWake(bot), takeWake(bot), takeWake(bot)].map((w) => w.payload.n), [3, 1, 2]);
});

test("priority only lifts a peer wake, not any other type", () => {
  // laneOf checks `type === "peer" && priority`; a priority routine stays in
  // the automation lane, so a shell completion cannot jump a teammate's note.
  resetForTest();
  const bot = uid(6);
  enqueueWake({ type: "shell", botId: bot, payload: { n: 1 }, priority: true });
  enqueueWake({ type: "channel", botId: bot, payload: { n: 2 } });
  assert.equal(takeWake(bot).payload.n, 2);
  assert.equal(takeWake(bot).payload.n, 1);
});

// ---------------------------------------------------------------------------
// Cancel / clear. Taking one bot's wake must never touch another's.
// ---------------------------------------------------------------------------

test("every take is scoped to one bot, and a wrong bot id clears nothing", () => {
  resetForTest();
  const a = uid(7);
  const b = uid(8);
  const wakeA = enqueueWake({ type: "peer", botId: a, payload: { n: 1 } });
  enqueueWake({ type: "shell", botId: b, payload: { id: "sh" } });

  assert.equal(takeWakeById(b, wakeA.id), null, "b cannot consume a's wake by id");
  assert.equal(takeWakeOfType(b, "peer"), null, "b has no peer wake to take");
  assert.equal(takeMatchingWake(b, (w) => w.payload.n === 1), null);
  assert.equal(listWakes(a).length, 1, "a's queue is untouched by every miss above");
  assert.equal(listWakes(b).length, 1);

  assert.equal(takeWakeById(a, wakeA.id).id, wakeA.id);
  assert.equal(listWakes(a).length, 0);
  assert.equal(listWakes(b).length, 1, "draining a is not draining b");
});

test("a drained bot drops out of listQueuedBotIds", () => {
  // The host iterates listQueuedBotIds to decide who to pump; a bot that is
  // left behind after its last wake is a bot that gets polled forever.
  resetForTest();
  const a = uid(9);
  const b = uid(10);
  enqueueWake({ type: "peer", botId: a, payload: {} });
  enqueueWake({ type: "peer", botId: b, payload: {} });
  assert.deepEqual(listQueuedBotIds().sort(), [a, b].sort());
  takeWake(a);
  assert.deepEqual(listQueuedBotIds(), [b]);
  takeWake(b);
  assert.deepEqual(listQueuedBotIds(), []);
});

test("takeMatchingWake removes exactly the wake the predicate picked", () => {
  resetForTest();
  const bot = uid(11);
  enqueueWake({ type: "shell", botId: bot, payload: { id: "sh-1" } });
  enqueueWake({ type: "shell", botId: bot, payload: { id: "sh-2" } });
  enqueueWake({ type: "shell", botId: bot, payload: { id: "sh-3" } });
  assert.equal(takeMatchingWake(bot, (w) => w.payload.id === "sh-2").payload.id, "sh-2");
  assert.deepEqual(listWakes(bot).map((w) => w.payload.id), ["sh-1", "sh-3"]);
  assert.equal(takeMatchingWake(bot, (w) => w.payload.id === "sh-2"), null);
  assert.equal(takeMatchingWake(bot, "not a function"), null);
});

test("a wake for a bot that no longer exists is queued and stays queued", () => {
  // The queue knows nothing about the bot table, so deleting a bot leaves its
  // wakes behind forever. Nothing in this package prunes them.
  resetForTest();
  const ghost = uid(12);
  enqueueWake({ type: "peer", botId: ghost, payload: { content: "hello?" } });
  assert.deepEqual(listQueuedBotIds(), [ghost]);
  assert.equal(listWakes(ghost).length, 1);
  assert.equal(takeWake(ghost).payload.content, "hello?", "and it is still deliverable if the id comes back");
});

// ---------------------------------------------------------------------------
// Listeners.
// ---------------------------------------------------------------------------

test("a throwing listener neither drops the wake nor blocks the next listener", () => {
  resetForTest();
  const bot = uid(13);
  const seen = [];
  subscribeWakes(() => {
    throw new Error("listener blew up");
  });
  const stop = subscribeWakes((w) => seen.push(w.payload.n));
  assert.doesNotThrow(() => enqueueWake({ type: "peer", botId: bot, payload: { n: 1 } }));
  assert.deepEqual(seen, [1]);
  assert.equal(listWakes(bot).length, 1, "the ledger still has it");

  stop();
  enqueueWake({ type: "peer", botId: bot, payload: { n: 2 } });
  assert.deepEqual(seen, [1], "unsubscribing actually stops delivery");
  assert.equal(listWakes(bot).length, 2);
});

test("a listener sees a copy, so it cannot edit the queued wake", () => {
  resetForTest();
  const bot = uid(14);
  subscribeWakes((w) => {
    w.payload.content = "rewritten by a listener";
  });
  enqueueWake({ type: "peer", botId: bot, payload: { content: "original" } });
  assert.equal(takeWake(bot).payload.content, "original");
});

// ---------------------------------------------------------------------------
// Durability. A wake exists so a restart cannot lose it.
// ---------------------------------------------------------------------------

test("wakes written by one process are readable by the next one", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wake-reload-"));
  process.env.SUB8BOT_DATA = dir;
  process.env.OCTOBOT_DATA = dir;
  try {
    resetForTest();
    const bot = uid(15);
    enqueueWake({ type: "peer", botId: bot, payload: { content: "survive me", fromId: uid(16) } });
    enqueueWake({ type: "code-agent-complete", botId: bot, payload: { id: "ca-1", prUrl: "https://pr" } });
    await flushWakes();

    const after = await reload(dir);
    assert.deepEqual(Object.keys(after), [bot]);
    assert.deepEqual(after[bot].map((w) => w.type), ["peer", "code-agent-complete"]);
    assert.equal(after[bot][0].payload.content, "survive me");
    assert.match(turnPromptForWake(after[bot][1]), /In-box code agent ca-1 finished\. PR: https:\/\/pr/);

    // And taking one is durable too: the next process must not see it again.
    takeWake(bot);
    await flushWakes();
    const drained = await reload(dir);
    assert.deepEqual(drained[bot].map((w) => w.type), ["code-agent-complete"]);
  } finally {
    process.env.SUB8BOT_DATA = tmp;
    process.env.OCTOBOT_DATA = tmp;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a ledger written by an older build still loads", async () => {
  // wakes.json used to be a bare { botId: [...] } map before the { queues: ... }
  // wrapper. An upgrade must not silently drop the wakes already on disk.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wake-legacy-"));
  try {
    const bot = uid(17);
    const row = { id: "w1", type: "peer", botId: bot, payload: { content: "old" }, user: false, priority: false, createdAt: 1 };
    await fs.writeFile(path.join(dir, "wakes.json"), JSON.stringify({ [bot]: [row] }));
    const legacy = await reload(dir);
    assert.deepEqual(legacy[bot], [row]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt ledger starts empty instead of taking the process down", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wake-corrupt-"));
  try {
    await fs.writeFile(path.join(dir, "wakes.json"), "{ this is not json");
    assert.deepEqual(await reload(dir), {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Turn prompts. What the parent actually reads.
// ---------------------------------------------------------------------------

test("a subagent result is capped so one wake cannot eat the whole turn", () => {
  const huge = { blob: "y".repeat(50_000) };
  const prompt = turnPromptForWake({ type: "subagent-complete", payload: { id: "t1", result: huge } });
  assert.ok(prompt.startsWith("Task t1 finished."));
  assert.equal(prompt.length, "Task t1 finished. ".length + 1500);

  // null is not "no result": JSON.stringify(null) is dropped by the `!= null` test.
  assert.equal(turnPromptForWake({ type: "subagent-complete", payload: { id: "t2", result: null } }), "Task t2 finished.");
  assert.equal(turnPromptForWake({ type: "subagent-complete", payload: { id: "t3", result: 0 } }), "Task t3 finished. 0");
});

test("an unknown wake type falls back to its content rather than an empty prompt", () => {
  assert.equal(turnPromptForWake({ type: "mystery", payload: { content: "still say something" } }), "still say something");
  assert.equal(turnPromptForWake({ type: "mystery", payload: {} }), "mystery fired");
  assert.equal(turnPromptForWake(null), "wake fired");
});

after(async () => {
  await flushWakes();
  for (let i = 0; ; i++) {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
      break;
    } catch (err) {
      if (i >= 9) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});
