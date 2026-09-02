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

const first = wrapWorkerDispatch({
  who: "Flight Checker",
  role: "chief",
  text: "Start now: DC -> SFO.",
  followUp: false,
});
// Message-centric: the worker does the thing and ANSWERS; the system delivers
// its reply to the lead and the channel. No update_task/message_teammate
// ceremony is demanded — that is how "say hello" got "Ready for assignment".
assert.match(first, /asked you to do this/);
assert.match(first, /your final message must BE the answer itself/);
assert.match(first, /do NOT take a screenshot/);
assert.match(first, /delivered to Flight Checker and shown in the team channel automatically/);
assert.doesNotMatch(first, /update_task status=running/);
assert.doesNotMatch(first, /message_teammate Flight Checker ONE short line/);
assert.match(first, /DC -> SFO/);

const note = wrapWorkerDispatch({
  who: "Flight Checker",
  role: "chief",
  text: "Heads up: add &curr=USD",
  followUp: true,
});
assert.match(note, /sent a follow-up/);
assert.match(note, /Do not restart work you already finished/);
assert.doesNotMatch(note, /update_task status=running/);
assert.match(note, /&curr=USD/);

assert.equal(storedChiefToWorker("Flight Checker", "Heads up: THB"), "Flight Checker: Heads up: THB");
assert.doesNotMatch(storedChiefToWorker("Flight Checker", "Start now"), /asked you to do this/);

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

// The user already sees the worker's reply in the channel. The lead speaks only
// to combine several replies or take a next step — never to repeat, never to
// compile a job list unless one is tracked, never to mention a job's absence.
const llm = chiefReportLlm("Leg3 DC-BKK", "$470 Qatar");
assert.match(llm, /Leg3 DC-BKK replies: \$470 Qatar/);
assert.match(llm, /can already see Leg3 DC-BKK's reply in the team channel/);
assert.match(llm, /do not repeat it back/);
assert.match(llm, /Nothing left .*__SILENT__/);
assert.match(llm, /It is dropped; the user never sees it/);
assert.match(llm, /ONE short combined line/);
assert.match(llm, /never mention whether a job exists/);
assert.doesNotMatch(llm, /EVERY non-Summary step/);
assert.doesNotMatch(llm, /Compile from those details/);
assert.doesNotMatch(llm, /update_task Summary done/);

const follow = chiefReportLlm("example", "PONG DISPLAY=:2", { followUp: true });
assert.match(follow, /example replies: PONG DISPLAY=:2/);
assert.match(follow, /Follow-up from example/);
assert.match(follow, /do not repeat example's words back/);
assert.doesNotMatch(follow, /Compile from those details/);
assert.doesNotMatch(follow, /EVERY non-Summary step/);

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

// The lead's "nothing to add" token: only the sentinel, tolerant of markdown/case.
{
  const { isSilentReply, SILENT, chiefReportLlm: rep } = await import("../server/teammate.mjs");
  for (const yes of [SILENT, "  __SILENT__ ", "**SILENT**", "silent", "`__silent__`"]) assert.equal(isSilentReply(yes), true, JSON.stringify(yes));
  for (const no of ["", "Standing by.", "Nova is ready. Waiting for your ask.", "silent mode on", "42"]) assert.equal(isSilentReply(no), false, JSON.stringify(no));
  // The report is self-contained: what the user asked and what the lead handed over.
  const ctx = rep("Pixel", "42857", { asked: "Say a random number", userAsk: "ask pixel to say a random number" });
  assert.match(ctx, /The user asked you: "ask pixel to say a random number"/);
  assert.match(ctx, /You handed Pixel: "Say a random number"/);
}

// Several teammates answered: the lead gets them together, once.
{
  const { chiefReportLlm: rep } = await import("../server/teammate.mjs");
  const both = rep("", "", { replies: [{ name: "Nova", text: "hello" }, { name: "Pixel", text: "42" }], userAsk: "ask nova to say hello and pixel a number" });
  assert.match(both, /Nova replies: hello/);
  assert.match(both, /Pixel replies: 42/);
  assert.match(both, /can already see your teammates's reply|can already see your teammates/);
}
