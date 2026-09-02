// Stage 1: the group-channel router — broadcast visibility, targeted wake.
import assert from "node:assert/strict";
import { routeChannelMessage, channelKeywordsFor, mentionedMemberIds } from "../server/teams.mjs";

const members = [
  { id: "chief", name: "Job Hunter Lead", teamRole: "chief" },
  { id: "scout", name: "FDE Scout", teamRole: "worker", channelKeywords: ["sourcing", "roles"] },
  { id: "closer", name: "App Closer", teamRole: "worker", channelKeywords: ["apply", "submit"] },
  { id: "ops", name: "Pipeline Ops", teamRole: "worker", channelKeywords: ["tracker", "pipeline"] },
];
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "-", e.message); } }

t("@mention wakes exactly the named member, not the author", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "@App Closer submit OpenRouter FDE now", members });
  assert.deepEqual(r.wake, ["closer"]);
  assert.deepEqual(r.mentioned, ["closer"]);
});

t("@role wakes the member with that role", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "@worker heads up", members });
  assert.deepEqual(r.wake.sort(), ["closer", "ops", "scout"]);
});

t("a keyword wakes the subscribed member even without an @mention", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "who owns the tracker this week?", members });
  assert.deepEqual(r.wake, ["ops"]);
  assert.deepEqual(r.keyworded, ["ops"]);
});

t("mention + keyword union, deduped, author excluded", () => {
  const r = routeChannelMessage({ authorId: "scout", text: "@Pipeline Ops the sourcing batch is on file", members });
  // ops is @mentioned; scout owns 'sourcing' keyword but is the author → excluded
  assert.deepEqual(r.wake, ["ops"]);
});

t("no mention, no keyword → nobody is woken (visible-only broadcast)", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "morning everyone", members });
  assert.deepEqual(r.wake, []);
});

t("a member on HOLD does not wake on their keyword or mention", () => {
  const held = members.map((m) => (m.id === "closer" ? { ...m, channelState: "hold" } : m));
  const r = routeChannelMessage({ authorId: "chief", text: "@App Closer apply now", members: held });
  assert.deepEqual(r.wake, [], "held member stays parked");
});

t("keyword matching is whole-word (does not fire on a substring)", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "the pipelines are fine", members }); // 'pipeline' kw vs 'pipelines'
  // whole-word: 'pipelines' should NOT match 'pipeline'
  assert.equal(r.wake.includes("ops"), false);
  const r2 = routeChannelMessage({ authorId: "chief", text: "check the pipeline.", members });
  assert.equal(r2.wake.includes("ops"), true, "trailing punctuation still matches");
});

t("channelKeywordsFor lowercases and dedupes", () => {
  assert.deepEqual(channelKeywordsFor({ id: "x", channelKeywords: ["Apply", "apply", " SUBMIT "] }).sort(), ["apply", "submit"]);
  assert.deepEqual(channelKeywordsFor({ id: "x" }), []);
});

t("name prefix @mention still works (existing behavior preserved)", () => {
  assert.deepEqual(mentionedMemberIds("@FDE hello", members), ["scout"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
