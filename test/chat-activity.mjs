import assert from "node:assert/strict";
import {
  activityLabel,
  applyChatBusy,
  isTurnClosingAssistant,
  liveBusyLabel,
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

console.log("ok chat-activity");
