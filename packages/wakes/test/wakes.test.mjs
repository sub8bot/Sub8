import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// dataRoot() reads the env on every call, but load() runs at import time — so
// the tmp dir has to be in place before the module is pulled in.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wakes-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const {
  enqueueWake,
  listWakes,
  takeWake,
  takeWakeOfType,
  takeWakeById,
  subscribeWakes,
  turnPromptForWake,
  AUTO_DRAIN_WAKE_TYPES,
  resetForTest,
  WAKE_TYPES,
  flushWakes,
} = await import("../dist/index.js");

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

test("WAKE_TYPES covers peer, channel, completions, routine, shell", () => {
  assert.deepEqual([...WAKE_TYPES], [
    "peer",
    "channel",
    "subagent-complete",
    "code-agent-complete",
    "routine",
    "shell",
    "box-help-released",
  ]);
});

test("enqueue / list / take are FIFO per bot", () => {
  resetForTest();
  const a = uid(1);
  const b = uid(2);
  enqueueWake({ type: "peer", botId: a, payload: { n: 1 } });
  enqueueWake({ type: "routine", botId: a, payload: { n: 2 } });
  enqueueWake({ type: "peer", botId: b, payload: { n: 3 } });
  enqueueWake({ type: "subagent-complete", botId: a, payload: { n: 4 } });

  const listed = listWakes(a);
  assert.equal(listed.length, 3);
  assert.deepEqual(
    listed.map((w) => w.payload.n),
    [1, 2, 4],
  );
  assert.equal(listWakes(a).length, 3, "listWakes does not dequeue");

  const first = takeWake(a);
  assert.equal(first.payload.n, 1);
  assert.equal(first.type, "peer");
  assert.equal(first.user, false);
  assert.equal(takeWake(a).payload.n, 2);
  assert.equal(takeWake(a).payload.n, 4);
  assert.equal(takeWake(a), null);
  assert.equal(listWakes(a).length, 0);

  const other = takeWake(b);
  assert.equal(other.payload.n, 3);
  assert.equal(takeWake(b), null);
});

test("unknown type and missing botId throw", () => {
  resetForTest();
  assert.throws(() => enqueueWake({ type: "user", botId: uid(1) }), /unknown wake type/);
  assert.throws(() => enqueueWake({ type: "peer" }), /botId required/);
  assert.throws(() => listWakes(""), /botId required/);
  assert.throws(() => takeWake(""), /botId required/);
});

test("completion and routine types enqueue", () => {
  resetForTest();
  const bot = uid(12);
  enqueueWake({ type: "code-agent-complete", botId: bot, payload: { id: "ca-1" } });
  enqueueWake({ type: "routine", botId: bot, payload: { slug: "morning" } });
  enqueueWake({ type: "shell", botId: bot, payload: { id: "sh-1" } });
  enqueueWake({ type: "box-help-released", botId: bot, payload: {} });
  assert.equal(takeWake(bot).type, "code-agent-complete");
  assert.equal(takeWake(bot).type, "routine");
  assert.equal(takeWake(bot).type, "shell");
  assert.equal(takeWake(bot).type, "box-help-released");
});

test("priority peer is taken before automations", () => {
  resetForTest();
  const bot = uid(13);
  enqueueWake({ type: "routine", botId: bot, payload: { n: 1 } });
  enqueueWake({ type: "peer", botId: bot, payload: { n: 2 }, priority: true });
  enqueueWake({ type: "peer", botId: bot, payload: { n: 3 } });
  assert.equal(takeWake(bot).payload.n, 2);
  assert.equal(takeWake(bot).payload.n, 3);
  assert.equal(takeWake(bot).payload.n, 1);
});

test("takeWakeOfType does not steal a peer wake", () => {
  resetForTest();
  const bot = uid(15);
  enqueueWake({ type: "peer", botId: bot, payload: { n: 1 } });
  enqueueWake({ type: "shell", botId: bot, payload: { id: "sh" } });
  const sh = takeWakeOfType(bot, "shell");
  assert.equal(sh.type, "shell");
  assert.equal(sh.payload.id, "sh");
  assert.equal(takeWake(bot).type, "peer");
  assert.equal(takeWakeOfType(bot, "shell"), null);
});

// server/teammate.mjs builds this payload; the prompt has to carry the whole
// note through, not a 240-char preview of it.
test("a peer wake becomes a turn prompt with the sender and the note", () => {
  resetForTest();
  const from = uid(20);
  const to = uid(21);
  const body = "assign this desk job: ".padEnd(500, "x");
  enqueueWake({ type: "peer", botId: to, payload: { fromId: from, content: body } });
  const wake = takeWake(to);
  assert.equal(wake.payload.content.length, 500);
  assert.match(turnPromptForWake(wake), /assign this desk job/);
  assert.match(turnPromptForWake(wake), new RegExp(`^${from} sent a note:`));
});

test("box-help-released prompt tells the parent to continue", () => {
  assert.match(
    turnPromptForWake({ type: "box-help-released", payload: {} }),
    /released Take control.*Screenshot/i,
  );
});

test("subscribeWakes fires and takeWakeById consumes one wake", () => {
  resetForTest();
  const bot = uid(22);
  const seen = [];
  const stop = subscribeWakes((w) => seen.push(w));
  const a = enqueueWake({ type: "peer", botId: bot, payload: { n: 1 } });
  enqueueWake({ type: "channel", botId: bot, payload: { n: 2 } });
  assert.equal(seen.length, 2);
  assert.deepEqual([...AUTO_DRAIN_WAKE_TYPES], ["peer", "channel", "shell", "box-help-released"]);
  assert.equal(takeWakeById(bot, a.id).payload.n, 1);
  assert.equal(listWakes(bot).length, 1);
  stop();
});

test("wakes survive a reload from disk", async () => {
  resetForTest();
  const bot = uid(14);
  enqueueWake({ type: "peer", botId: bot, payload: { n: 9 } });
  await flushWakes();
  const raw = JSON.parse(await fs.readFile(path.join(tmp, "wakes.json"), "utf8"));
  assert.equal(raw.queues[bot][0].payload.n, 9);
});

// persist() is fire-and-forget, so a write can still land in tmp after the last
// assertion and race this rm. Retry instead of flaking.
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
