import assert from "node:assert/strict";
import { conversationId, mentionedMemberIds, wantsCloseTeammates, idsToClose, isGenericWorkerName, jobProgress, newJob, isSoloTeam } from "../server/teams.mjs";

assert.equal(conversationId("abc"), "team-abc");

assert.equal(isGenericWorkerName(""), true);
assert.equal(isGenericWorkerName("Worker"), true);
assert.equal(isGenericWorkerName("Worker 2"), true);
assert.equal(isGenericWorkerName("Worker on CycleProbe's team"), true);
assert.equal(isGenericWorkerName("ExampleScout"), false);
assert.equal(isGenericWorkerName("OctoScout"), false);

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

assert.equal(wantsCloseTeammates("close all bots"), true);
assert.equal(wantsCloseTeammates("please delete the other teammates"), true);
assert.equal(wantsCloseTeammates("find cheap tacos"), false);

const team = { chiefId: "c1", memberIds: ["c1", "w1", "w2"] };
assert.deepEqual(idsToClose(team, "c1", { all_workers: true }).ids.sort(), ["w1", "w2"]);
assert.deepEqual(idsToClose(team, "c1", { bot_id: "all" }).ids.sort(), ["w1", "w2"]);
assert.deepEqual(idsToClose(team, "c1", { bot_id: "w1" }).ids, ["w1"]);
assert.match(idsToClose(team, "c1", { bot_id: "c1" }).error || "", /cannot delete yourself/);
assert.equal(idsToClose(team, "c1", { bot_id: "nope" }).error, "that Bot is not on your team");
assert.match(idsToClose(team, "c1", {}).error || "", /bot_id required/);

const finished = newJob({
  title: "Sub bots",
  steps: [
    { label: "keys", status: "done" },
    { label: "Report back", status: "done", detail: "compiled" },
  ],
});
assert.equal(jobProgress(finished).complete, true);
assert.equal(jobProgress(finished).done, 2);
assert.equal(jobProgress(newJob({ title: "open", steps: [{ label: "a", status: "running" }] })).complete, false);

assert.equal(isSoloTeam({ chiefId: "c1", memberIds: ["c1"] }), true);
assert.equal(isSoloTeam({ chiefId: "c1", memberIds: ["c1", "w1"] }), false);
assert.equal(isSoloTeam({ chiefId: "c1", memberIds: ["c1", "w1"] }, [{ id: "c1" }]), true);

console.log("ok teams");
