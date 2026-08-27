import test from "node:test";
import assert from "node:assert/strict";
import {
  countToolsSinceSendMessage,
  needsAckReminder,
  needsDeliveryReminder,
  reminderFor,
} from "../dist/index.js";

const tools = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    role: "activity",
    kind: "tool",
    name: "shell",
    ts: i,
  }));

test("a turn that opens with tools gets the ack nudge, an acked turn does not", () => {
  assert.equal(countToolsSinceSendMessage([]), 0);
  assert.equal(needsAckReminder([{ role: "user", content: "hi" }, ...tools(1)]), true);
  assert.equal(
    needsAckReminder([
      { role: "user", content: "hi" },
      { role: "assistant", content: "On it." },
      ...tools(2),
    ]),
    false,
  );
});

test("silence past SEND_THRESHOLD earns the delivery nudge", () => {
  assert.equal(needsDeliveryReminder([{ role: "user", content: "hi" }, ...tools(7)]), true);
  assert.equal(needsDeliveryReminder([{ role: "user", content: "hi" }, ...tools(2)]), false);
  assert.equal(reminderFor([{ role: "user", content: "hi" }, ...tools(1)])?.kind, "ack");
  assert.equal(reminderFor([{ role: "user", content: "hi" }, ...tools(8)])?.kind, "delivery");
  assert.equal(reminderFor([], { hidden: true }), null);
});
