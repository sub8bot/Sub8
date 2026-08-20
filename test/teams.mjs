import assert from "node:assert/strict";
import { conversationId, mentionedMemberIds } from "../server/teams.mjs";

assert.equal(conversationId("abc"), "team-abc");

const msg = {
  role: "assistant",
  speakerId: "b1",
  speakerName: "Chief",
  speakerRole: "chief",
  content: "Search Maps for pizza and send_message the top place.",
};
assert.equal(msg.speakerRole, "chief");
assert.match(msg.content, /send_message/);

assert.deepEqual(
  mentionedMemberIds("hey @Worker open this", [
    { id: "c", name: "Chief", teamRole: "chief" },
    { id: "w", name: "Worker", teamRole: "worker" },
  ]),
  ["w"],
);
assert.deepEqual(
  mentionedMemberIds("@chief and @worker both", [
    { id: "c", name: "Chief", role: "chief" },
    { id: "w", name: "Worker", role: "worker" },
  ]).sort(),
  ["c", "w"],
);

console.log("ok teams");
