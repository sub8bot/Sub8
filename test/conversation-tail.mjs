// A long task logs hundreds of step rows. The client window must still carry
// the user's own mid-task message instead of only the newest steps.
import assert from "node:assert/strict";
import { conversationTail } from "../server/agent.mjs";

const steps = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ role: "activity", id: `s${from + i}` }));
const all = [
  { role: "user", id: "u1" },
  { role: "assistant", id: "a1" },
  ...steps(50),
  { role: "user", id: "mid" },
  ...steps(600, 50),
];

const win = conversationTail(all, 120);
assert.ok(win.some((m) => m.id === "mid"), "the mid-task user message stays in the window");
assert.ok(win.some((m) => m.id === "u1"), "earlier real messages within the limit stay too");
assert.ok(win.filter((m) => m.role === "activity").length <= 150, "old step rows are capped");
assert.equal(win.at(-1).id, "s649", "the newest step is kept");

const two = conversationTail(all, 1);
assert.deepEqual(two.filter((m) => m.role !== "activity").map((m) => m.id), ["mid"], "limit counts real messages only");
assert.deepEqual(conversationTail(all, 0), []);
console.log("ok conversation-tail");
