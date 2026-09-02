// The team-channel router: everyone sees a message; only the teammates the
// sender ADDRESSED are woken — named in the tool's `to` list, or @mentioned in
// the text (the human's addressing syntax). No keyword matching: the sender
// says who it wants; the model does the thinking, the router does the plumbing.
import assert from "node:assert/strict";
import { routeChannelMessage, mentionedMemberIds, resolveTeammate } from "../server/teams.mjs";

const members = [
  { id: "chief", name: "Job Hunter Lead", teamRole: "chief" },
  { id: "scout", name: "FDE Scout", teamRole: "worker" },
  { id: "closer", name: "App Closer", teamRole: "worker" },
  { id: "ops", name: "Pipeline Ops", teamRole: "worker" },
];
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "-", e.message); } }

t("`to` (names or ids) wakes exactly those members, not the author", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "sourcing batch is ready", members, to: ["App Closer", "ops"] });
  assert.deepEqual(r.wake.sort(), ["closer", "ops"]);
});

t("@mention in the text wakes the named member", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "@App Closer submit OpenRouter FDE now", members });
  assert.deepEqual(r.wake, ["closer"]);
  assert.deepEqual(r.mentioned, ["closer"]);
});

t("@role wakes every member with that role", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "@worker heads up", members });
  assert.deepEqual(r.wake.sort(), ["closer", "ops", "scout"]);
});

t("`to` and @mentions union, deduped, author excluded", () => {
  const r = routeChannelMessage({ authorId: "scout", text: "@Pipeline Ops the batch is on file", members, to: ["FDE Scout", "Pipeline Ops"] });
  assert.deepEqual(r.wake, ["ops"], "scout addressed itself → excluded; ops once");
});

t("a message that names nobody wakes nobody — a keyword in the text is NOT an address", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "who owns the tracker and the pipeline this week?", members });
  assert.deepEqual(r.wake, []);
  assert.deepEqual(routeChannelMessage({ authorId: "chief", text: "morning everyone", members }).wake, []);
});

t("a member on HOLD does not wake, addressed either way", () => {
  const held = members.map((m) => (m.id === "closer" ? { ...m, channelState: "hold" } : m));
  assert.deepEqual(routeChannelMessage({ authorId: "chief", text: "@App Closer apply now", members: held }).wake, []);
  assert.deepEqual(routeChannelMessage({ authorId: "chief", text: "apply now", members: held, to: ["closer"] }).wake, []);
});

t("an unknown name in `to` is ignored, not an error", () => {
  const r = routeChannelMessage({ authorId: "chief", text: "hi", members, to: ["Nobody", "FDE Scout"] });
  assert.deepEqual(r.wake, ["scout"]);
});

t("name-prefix @mention still resolves", () => {
  assert.deepEqual(mentionedMemberIds("@FDE hello", members), ["scout"]);
});

t("resolveTeammate: exact id, name (any case), id prefix", () => {
  assert.equal(resolveTeammate("ops", members)?.name, "Pipeline Ops");
  assert.equal(resolveTeammate("app closer", members)?.id, "closer");
  assert.equal(resolveTeammate("nobody", members), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
