import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-teammate-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const {
  chiefReportLlm,
  chiefReportStored,
  isFollowUpDispatch,
  storedChiefToWorker,
  wrapWorkerDispatch,
  sendToAgent,
  sendToAgentContent,
  SEND_TO_AGENT_MAX,
  messageTeammate,
} = await import("../server/teammate.mjs");
const { listWakes, takeWake, resetForTest } = await import("@sub8/wakes");
const channels = await import("@sub8/store/channels");

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const first = wrapWorkerDispatch({ who: "Flight Checker", role: "chief", text: "Start now: DC -> SFO." });
// Facts only: the contract lives in the team system prompt. An instruction
// inside the message got acknowledged back ("Got it, I'll…") instead of followed.
assert.equal(first, "Flight Checker (your lead): Start now: DC -> SFO.");
assert.doesNotMatch(first, /update_task|message_teammate|__SILENT__|__DESK__|final message/);

assert.equal(storedChiefToWorker("Flight Checker", "Heads up: THB"), "Flight Checker: Heads up: THB");

assert.equal(isFollowUpDispatch([]), false);
assert.equal(isFollowUpDispatch([{ role: "user", content: "hello" }]), false);
assert.equal(
  isFollowUpDispatch([{ role: "user", speakerRole: "chief", content: "Flight Checker: Start now" }]),
  true,
);

const stored = chiefReportStored("Leg3 DC-BKK", "$470 Qatar");
assert.equal(stored, "Leg3 DC-BKK replies: $470 Qatar");
assert.doesNotMatch(stored, /teammate report/);
assert.doesNotMatch(stored, /upsert_routine/);

// The lead gets the facts — the user's ask, what it handed out, the replies —
// and nothing else: the principle lives in the system prompt.
const llm = chiefReportLlm("Leg3 DC-BKK", "$470 Qatar", { userAsk: "find the cheapest DC-BKK", handed: ["Leg3 DC-BKK: DC-BKK fares", "Leg1: DC-SFO fares"] });
assert.equal(llm, 'Teammate report (this is not the user speaking):\nThe user asked you: "find the cheapest DC-BKK"\nYou handed out:\n- Leg3 DC-BKK: DC-BKK fares\n- Leg1: DC-SFO fares\nLeg3 DC-BKK replies: $470 Qatar\n(Nothing to add → call the nothing_to_add tool; do not write its name.)');
assert.doesNotMatch(llm, /__SILENT__|list_tasks|Summary|only if you add/);

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

await test("peer wake is not the user", async () => {
  resetForTest();
  const from = uid(1);
  const to = uid(2);
  const ack = await sendToAgent(from, to, "check the fare");
  assert.equal(ack.ok, true);
  assert.equal(ack.type, "peer");
  assert.equal(ack.queued, 1);
  assert.equal(ack.reply, undefined);

  const queued = listWakes(to);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, "peer");
  assert.equal(queued[0].user, false);
  assert.equal(queued[0].botId, to);
  assert.equal(queued[0].payload.fromId, from);
  assert.equal(queued[0].payload.content, "check the fare");
  assert.equal(listWakes(from).length, 0);

  const taken = takeWake(to);
  assert.equal(taken.type, "peer");
  assert.equal(taken.user, false);
  assert.equal(takeWake(to), null);
});

await test("channel fan-in wakes members except sender", async () => {
  resetForTest();
  const a = uid(11);
  const b = uid(12);
  const c = uid(13);
  const outsider = uid(14);
  const ch = await channels.createChannel({ name: "Ops", memberIds: [a, b, c] });

  const ack = await sendToAgent(a, ch.id, "standup now");
  assert.equal(ack.ok, true);
  assert.equal(ack.type, "channel");
  assert.equal(ack.queued, 2);
  assert.equal(ack.channelId, ch.id);

  assert.equal(listWakes(a).length, 0, "sender must not be woken");
  assert.equal(listWakes(outsider).length, 0, "non-member must not be woken");

  const wb = listWakes(b);
  const wc = listWakes(c);
  assert.equal(wb.length, 1);
  assert.equal(wc.length, 1);
  assert.equal(wb[0].type, "channel");
  assert.equal(wb[0].user, false);
  assert.equal(wb[0].payload.fromId, a);
  assert.equal(wb[0].payload.channelId, ch.id);
  assert.equal(wb[0].payload.content, "standup now");
  assert.equal(wc[0].type, "channel");
  assert.equal(wc[0].payload.fromId, a);
});

await test("SendToAgent keeps a long assignment", async () => {
  resetForTest();
  const from = uid(31);
  const to = uid(32);
  const body = "full brief: ".padEnd(400, "y");
  assert.equal(sendToAgentContent(body).length, 400);
  assert.equal(sendToAgentContent("x".repeat(SEND_TO_AGENT_MAX + 50)).length, SEND_TO_AGENT_MAX);
  const ack = await sendToAgent(from, to, body);
  assert.equal(ack.ok, true);
  assert.equal(takeWake(to).payload.content, body);
});

await test("sendToAgent returns without waiting (no poll)", async () => {
  resetForTest();
  const from = uid(21);
  const to = uid(22);
  const hung = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("sendToAgent polled/waited for a reply")), 250);
  });
  const t0 = Date.now();
  const ack = await Promise.race([sendToAgent(from, to, "ping"), hung]);
  const ms = Date.now() - t0;
  assert.ok(ms < 250, `sendToAgent took ${ms}ms`);
  assert.equal(ack.ok, true);
  assert.equal(ack.type, "peer");
  assert.equal("reply" in ack, false);
  assert.equal(listWakes(to).length, 1);
  assert.equal(takeWake(to).payload.content, "ping");
});

await test("messageTeammate is sendToAgent", async () => {
  resetForTest();
  assert.equal(messageTeammate, sendToAgent);
  const ack = await messageTeammate(uid(31), uid(32), "one line");
  assert.equal(ack.type, "peer");
  assert.equal(listWakes(uid(32))[0].user, false);
});

// @sub8/wakes persists fire-and-forget (`persist().catch(() => {})`), so a write
// can land in tmp after the last assertion and race this rm — rmdir then fails
// ENOTEMPTY and the whole suite exits 1. Retry instead of flaking (~1 run in 3).
for (let i = 0; ; i++) {
  try {
    await fs.rm(tmp, { recursive: true, force: true });
    break;
  } catch (err) {
    if (i >= 9) throw err;
    await new Promise((r) => setTimeout(r, 50));
  }
}
console.log("ok teammate");

// Several teammates answered: the lead gets them together, once.
{
  const { chiefReportLlm: rep } = await import("../server/teammate.mjs");
  const both = rep("", "", { replies: [{ name: "Nova", text: "hello" }, { name: "Pixel", text: "42" }], userAsk: "ask nova to say hello and pixel a number" });
  assert.match(both, /Nova replies: hello/);
  assert.match(both, /Pixel replies: 42/);
  assert.doesNotMatch(both, /only if you add/);
}
