/**
 * Startup repair for team membership. A lead that created a teammate mid-turn
 * had its teamId/teamRole wiped by the end-of-turn save, leaving teams.json and
 * bots.json disagreeing. repairMembership fills the gaps and never removes.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-teams-repair-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("@sub8/store");
const teams = await import("../server/teams.mjs");

// Pure planner first.
{
  const rows = [
    { id: "t1", chiefId: "lead", memberIds: ["lead", "poster"] },
    { id: "t2", chiefId: "x", memberIds: ["x"] },
  ];
  const bots = [
    { id: "lead", teamId: "", teamRole: "" },
    { id: "poster", teamId: "t1", teamRole: "worker" },
    { id: "x", teamId: "t2", teamRole: "chief" },
    { id: "stray", teamId: "t2", teamRole: "worker" },
    { id: "elsewhere", teamId: "t2", teamRole: "worker" },
  ];
  const plan = teams.planMembershipRepair(rows, bots);
  assert.deepEqual(plan.bots.get("lead"), { teamId: "t1", teamRole: "chief" });
  assert.equal(plan.bots.has("poster"), false, "a consistent worker is untouched");
  assert.equal(plan.bots.has("x"), false);
  assert.deepEqual(plan.teams.get("t2"), ["stray", "elsewhere"], "bots naming a team join its memberIds");
  assert.equal(plan.teams.has("t1"), false);

  // A chief whose row names another live team is not pulled back.
  const p2 = teams.planMembershipRepair(
    [{ id: "a", chiefId: "c", memberIds: ["w"] }, { id: "b", chiefId: "z", memberIds: ["z", "c"] }],
    [{ id: "c", teamId: "b", teamRole: "worker" }, { id: "w", teamId: "a", teamRole: "worker" }, { id: "z", teamId: "b", teamRole: "chief" }],
  );
  assert.equal(p2.bots.has("c"), false);
  assert.equal(p2.teams.has("a"), false, "the chief is not added to a team it left");

  // A dangling teamId is treated as empty.
  const p3 = teams.planMembershipRepair([{ id: "t", chiefId: "c", memberIds: ["c"] }], [{ id: "c", teamId: "gone", teamRole: "" }]);
  assert.deepEqual(p3.bots.get("c"), { teamId: "t", teamRole: "chief" });

  // Nothing to do on consistent data.
  const p4 = teams.planMembershipRepair([{ id: "t", chiefId: "c", memberIds: ["c", "w"] }], [{ id: "c", teamId: "t", teamRole: "chief" }, { id: "w", teamId: "t", teamRole: "worker" }]);
  assert.equal(p4.bots.size + p4.teams.size, 0);
}

// On disk: reproduce the live shape (team row lists the lead; lead row empty).
const lead = store.newBot({ name: "Personal" });
lead.messages = [{ id: "m1", role: "user", content: "keep me", ts: 1 }];
lead.routines = [{ id: "r1", name: "X loop", enabled: true, updatedAt: 1 }];
await store.upsertBot(lead);
const team = await teams.ensureTeamForBot(lead);
const { bot: poster } = await teams.addMember(team, { name: "Poster", job: "post" });
await store.patchBot(lead.id, (b) => {
  b.teamId = "";
  b.teamRole = "";
});
const before = await store.getBot(lead.id);
assert.equal(before.teamId, "");

const fixed = await teams.repairMembership();
assert.deepEqual(fixed.bots, [lead.id]);
assert.deepEqual(fixed.teams, []);
const after = await store.getBot(lead.id);
assert.equal(after.teamId, team.id);
assert.equal(after.teamRole, "chief");
assert.equal(after.name, "Personal");
assert.equal(after.messages.some((m) => m.id === "m1"), true, "messages survive");
assert.equal(after.routines.length, 1, "routines survive");
const p = await store.getBot(poster.id);
assert.equal(p.teamId, team.id);
assert.equal(p.teamRole, "worker");
const row = await teams.getTeam(team.id);
assert.deepEqual([...row.memberIds].sort(), [lead.id, poster.id].sort());

// A second run is a no-op.
assert.deepEqual(await teams.repairMembership(), { bots: [], teams: [] });

// The root cause: the end-of-turn save copied the start-of-turn snapshot over
// the row, team fields included. It must keep the row's live team fields.
const index = await fs.readFile(new URL("../server/index.mts", import.meta.url), "utf8");
assert.match(index, /Object\.assign\(live, bot, \{ messages: merged, routines, vm, teamId, teamRole \}\)/);

await fs.rm(tmp, { recursive: true, force: true });
console.log("ok teams-repair");
