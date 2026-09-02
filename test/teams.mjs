import assert from "node:assert/strict";
import { conversationId, mentionedMemberIds, wantsCloseTeammates, idsToClose, isGenericWorkerName, jobProgress, newJob, isSoloTeam, workerIdsOnDesk } from "../server/teams.mjs";

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

const deskChief = { id: "c1", teamId: "", vm: { computerId: "desk" } };
const mediaone = { id: "m1", teamId: "other", teamRole: "worker", vm: { computerId: "desk" } };
const mediathree = { id: "m3", teamId: "", teamRole: "", vm: { computerId: "desk" } };
const elsewhere = { id: "x", teamRole: "worker", vm: { computerId: "other-desk" } };
assert.deepEqual(
  workerIdsOnDesk(deskChief, [deskChief, mediaone, mediathree, elsewhere], [
    { id: "other", chiefId: "c1", memberIds: ["c1", "m1"], computerId: "desk" },
  ]).sort(),
  ["m1", "m3"],
);
assert.deepEqual(
  idsToClose(null, "c1", { all_workers: true }, ["m1", "m3"]).ids.sort(),
  ["m1", "m3"],
);
assert.deepEqual(idsToClose(null, "c1", { bot_id: "m1" }, ["m1", "m3"]).ids, ["m1"]);

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

// A model that passes a teammate's NAME (or an id prefix) instead of the UUID
// still reaches them — "bot not found" was the lead telling the user its team
// was unreachable.
{
  const teams = await import("../server/teams.mjs");
  const members = [
    { id: "aa9dbae1-11ea-49fb-8f11-332e1302b316", name: "Bot" },
    { id: "46c894f9-bba3-4488-bf5d-7be93cc3f7e2", name: "Nova" },
    { id: "3f5f3a1a-0000-4000-8000-000000000000", name: "Pixel" },
  ];
  assert.equal(teams.resolveTeammate("46c894f9-bba3-4488-bf5d-7be93cc3f7e2", members)?.name, "Nova", "exact id");
  assert.equal(teams.resolveTeammate("pixel", members)?.name, "Pixel", "name, case-insensitive");
  assert.equal(teams.resolveTeammate(" Nova ", members)?.name, "Nova", "name, trimmed");
  assert.equal(teams.resolveTeammate("3f5f3a1a", members)?.name, "Pixel", "id prefix");
  assert.equal(teams.resolveTeammate("nobody", members), null, "unknown");
  assert.equal(teams.resolveTeammate("", members), null, "empty");
  console.log("PASS resolveTeammate accepts id, name, or id prefix");
}

// The lead re-issuing the exact same handoff while the worker is still on it
// is a retry: suppressed. Once the worker answers, the same text is new work.
{
  const teams = await import("../server/teams.mjs");
  const id = "t-dup";
  await teams.saveTeam({ id, name: "dup", memberIds: ["c", "w"], chiefId: "c" });
  await teams.appendMessage(id, { role: "assistant", speakerId: "c", speakerName: "C", speakerRole: "chief", toId: "w", toName: "W", content: "Say a random number" });
  assert.equal(await teams.isDuplicateHandoff(id, "c", "w", "Say a random number"), true, "same text, no reply yet → duplicate");
  assert.equal(await teams.isDuplicateHandoff(id, "c", "w", "Say hello"), false, "different text → not a duplicate");
  await teams.appendMessage(id, { role: "assistant", speakerId: "w", speakerName: "W", speakerRole: "worker", content: "42" });
  assert.equal(await teams.isDuplicateHandoff(id, "c", "w", "Say a random number"), false, "worker answered → the same text is new work");
  console.log("PASS isDuplicateHandoff suppresses only an in-flight exact repeat");
}
