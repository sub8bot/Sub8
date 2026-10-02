import assert from "node:assert/strict";
import {
  activityLabel,
  applyChatBusy,
  chatNoticeKind,
  chatRepeatKey,
  collapseRepeats,
  formatElapsed,
  isTurnClosingAssistant,
  liveBusyLabel,
  usageLimitInfo,
  workingRowState,
} from "../web/chat-activity.mjs";

assert.equal(activityLabel({ summary: "Opened Chrome", action: "open" }), "Opened Chrome");
assert.equal(activityLabel({ summary: "Looked at the screen", action: "screenshot" }), "Looked at the screen");
assert.equal(
  activityLabel({ summary: "Working via grok-build", name: "computer", action: "screenshot" }),
  "Starting on the computer",
);
assert.equal(
  activityLabel({ summary: "Working on the computer", name: "computer", action: "screenshot" }),
  "Starting on the computer",
);
assert.equal(activityLabel({ summary: "Working", name: "computer", action: "open" }), "Opened Chrome");
assert.notEqual(activityLabel({ name: "computer", action: "click" }), "Working");

assert.equal(liveBusyLabel({ busy: false, messages: [{ summary: "Opened Chrome", role: "activity" }] }), null);
assert.equal(liveBusyLabel({ busy: true, messages: [] }), "Starting…");
assert.equal(
  liveBusyLabel({
    busy: true,
    messages: [
      { role: "activity", kind: "tool", summary: "Opened Chrome", action: "open" },
      { role: "assistant", content: "Created mediaone on this desk to post." },
    ],
  }),
  "Opened Chrome",
);
assert.equal(
  liveBusyLabel({
    busy: true,
    messages: [{ role: "activity", kind: "tool", summary: "Opened Chrome", action: "open" }],
    liveTool: { name: "browser", action: "click" },
  }),
  "Browser click",
);

assert.equal(isTurnClosingAssistant({ role: "assistant", content: "Two worker bots are on this desk now." }), true);
assert.equal(
  isTurnClosingAssistant({
    role: "assistant",
    content: "Created mediaone on this desk to Post mixed images. They’re in the sidebar on this team.",
  }),
  false,
);
assert.equal(
  isTurnClosingAssistant({
    role: "assistant",
    content: "Created mediatwo to post mixed images. They’re on this desk — switch to their tab to watch them.",
  }),
  false,
);
assert.equal(
  isTurnClosingAssistant({
    role: "assistant",
    content: "Still working on my computer. I'll keep going and pick this up in a moment.",
  }),
  false,
);

const bot = { busy: false };
applyChatBusy(bot, { type: "send" });
assert.equal(bot.busy, true);

applyChatBusy(bot, {
  type: "tool",
  name: "computer",
  args: { action: "screenshot" },
});
assert.equal(bot.busy, true);
assert.equal(activityLabel(bot.liveTool), "Looked at the screen");

applyChatBusy(bot, {
  type: "message",
  msg: {
    role: "assistant",
    content: "Created mediaone on this desk to Post mixed images. They’re in the sidebar on this team.",
  },
});
assert.equal(bot.busy, true);

applyChatBusy(bot, {
  type: "message",
  msg: { role: "assistant", content: "Two worker bots are on this desk now." },
});
assert.equal(bot.busy, false);
assert.equal(bot.liveTool, null);

applyChatBusy(bot, { type: "tool", name: "computer", args: { action: "screenshot" } });
assert.equal(bot.busy, true, "a tool that lands after the reply can still be this turn");
assert.equal(activityLabel(bot.liveTool), "Looked at the screen");

applyChatBusy(bot, { type: "bot", busy: false });
assert.equal(bot.busy, false);
applyChatBusy(bot, { type: "tool", name: "computer", args: { action: "open" } });
assert.equal(bot.busy, false, "late tool after the server idles must not resurrect Working");

applyChatBusy(bot, { type: "send" });
applyChatBusy(bot, { type: "bot", busy: false });
assert.equal(bot.busy, false);

// A step from the previous turn is not what the bot is doing now.
assert.equal(
  liveBusyLabel({
    busy: true,
    messages: [
      { role: "activity", kind: "tool", summary: "Opened Chrome", action: "open" },
      { role: "assistant", content: "Done." },
      { role: "user", content: "hi" },
    ],
  }),
  "Starting…",
);

// Usage limits, as the harnesses word them.
assert.deepEqual(usageLimitInfo("You've hit your weekly limit · resets Oct 3, 4pm (UTC)"), { scope: "weekly", reset: "Oct 3, 4pm (UTC)" });
assert.deepEqual(usageLimitInfo("You've hit your limit · resets 5pm"), { scope: "", reset: "5pm" });
assert.equal(usageLimitInfo("Claude AI usage limit reached. Your limit will reset at 9pm.")?.reset, "9pm");
assert.ok(usageLimitInfo("Rate limit exceeded"));
assert.equal(usageLimitInfo("I checked the rate limit docs and the bill looks fine."), null);
assert.equal(usageLimitInfo("Here is the summary you asked for."), null);

const limit = (id, ts) => ({ id, ts, role: "assistant", content: "You've hit your weekly limit · resets Oct 3, 4pm (UTC)" });
assert.equal(chatNoticeKind(limit("a", 1)), "limit");
assert.equal(chatNoticeKind({ role: "assistant", content: "Error: harness exited with code 1" }), "error");
assert.equal(chatNoticeKind({ role: "assistant", content: "Stopped." }), "system");
assert.equal(chatNoticeKind({ role: "assistant", content: "Hello! How can I help?" }), null);
assert.equal(chatNoticeKind({ role: "user", content: "Error: my code fails" }), null, "user text is never a notice");
assert.equal(chatNoticeKind({ role: "assistant", kind: "choices", content: "Error?" }), null);

// Near-identical notices share a key; plain replies only when exact; users never.
assert.equal(chatRepeatKey(limit("a", 1)), chatRepeatKey({ ...limit("b", 2), content: "You've hit your weekly limit · resets Oct 4, 5pm (UTC)" }));
assert.equal(chatRepeatKey({ role: "user", content: "hi" }), "");
assert.notEqual(chatRepeatKey({ role: "assistant", content: "No change." }), chatRepeatKey({ role: "assistant", content: "No change!" }));

const rows = [
  { id: "u", role: "user", content: "watch the bill", ts: 0 },
  ...Array.from({ length: 23 }, (_, i) => limit(`l${i}`, 1000 + i)),
  { id: "e1", role: "assistant", content: "Error: harness exited with code 1", ts: 3000 },
  { id: "t1", role: "activity", kind: "tool", summary: "Looked at the screen", ts: 3001 },
  { id: "e2", role: "assistant", content: "Error: harness exited with code 1", ts: 3002 },
  { id: "r", role: "assistant", content: "Back online.", ts: 4000 },
];
const runs = collapseRepeats(rows);
assert.equal(runs.length, 4);
assert.equal(runs[1].items.length, 23);
assert.equal(runs[1].first.id, "l0");
assert.equal(runs[1].last.id, "l22");
assert.equal(runs[2].items.length, 2, "an activity row between two identical errors folds into the run");
assert.deepEqual(runs[2].skipped.map((m) => m.id), ["t1"]);
assert.equal(runs[3].first.id, "r");
// An activity row that is not followed by the same notice stays in the transcript.
const tailRuns = collapseRepeats([limit("x", 1), { id: "t", role: "activity", kind: "tool", ts: 2 }]);
assert.equal(tailRuns.length, 2);

assert.equal(formatElapsed(3_400), "3s");
assert.equal(formatElapsed(65_000), "1:05");
assert.equal(formatElapsed(3_729_000), "1:02:09");
assert.deepEqual(workingRowState("Starting…", 1_000), { text: "Starting…", clock: "", stalled: false });
assert.deepEqual(workingRowState("Starting…", 12_000), { text: "Starting…", clock: "12s", stalled: false });
assert.deepEqual(workingRowState("Starting…", 52_000), { text: "Still starting…", clock: "52s", stalled: true });
assert.equal(workingRowState("Reading a page", 90_000).stalled, false, "a turn that is doing steps is not stalled");

console.log("ok chat-activity");
