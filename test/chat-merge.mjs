import assert from "node:assert/strict";
import { mergeCloudMessages, mergeCloudDraft, isTransientChatStatus } from "../web/chat-merge.mjs";

const kept = mergeCloudMessages(
  [{ id: "u1", role: "user", content: "hi", ts: 1 }],
  [],
);
assert.equal(kept.length, 1);
assert.equal(kept[0].content, "hi");

const union = mergeCloudMessages(
  [{ id: "u1", role: "user", content: "hi", ts: 1 }],
  [
    { id: "u1", role: "user", content: "hi", ts: 1 },
    { id: "a1", role: "assistant", content: "hello", ts: 2 },
  ],
);
assert.deepEqual(
  union.map((m) => m.id),
  ["u1", "a1"],
);

const failed = mergeCloudDraft(
  { bots: [{ id: "cloud-cmp_a", messages: [{ id: "u1", content: "keep me", ts: 1 }] }] },
  { bots: [{ id: "cloud-cmp_a", messagesFailed: true, messages: [] }] },
);
assert.equal(failed.bots[0].messages[0].content, "keep me");

assert.equal(isTransientChatStatus({ kind: "status", content: "desk brain starting" }), true);
assert.equal(isTransientChatStatus({ role: "assistant", content: "desk brain starting" }), true);
assert.equal(isTransientChatStatus({ role: "assistant", content: "PONG" }), false);

console.log("ok chat-merge");
