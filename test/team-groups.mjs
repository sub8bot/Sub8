/**
 * The rail grouped by bot.teamId while the tab strip read team.memberIds, so a
 * lead whose own row lost its team fields showed "Team | Personal | Poster"
 * tabs above two loose avatars under Unassigned, and the Team tab's banner read
 * "the lead" because no member carried the chief role.
 */
import assert from "node:assert/strict";
import { leadOf, reconcileTeamFields, teamIdFor, teamRoleFor } from "../web/team-groups.mjs";

const team = { id: "t1", chiefId: "lead", memberIds: ["lead", "poster"] };
const other = { id: "t2", chiefId: "x", memberIds: ["x", "y"] };

// The live shape: the lead row has no team fields, the worker row does.
const bots = [
  { id: "lead", teamId: "", teamRole: "" },
  { id: "poster", teamId: "t1", teamRole: "worker" },
  { id: "loose", teamId: "", teamRole: "" },
];
assert.equal(reconcileTeamFields(bots, [team]), 1);
assert.deepEqual(bots[0], { id: "lead", teamId: "t1", teamRole: "chief" });
assert.deepEqual(bots[1], { id: "poster", teamId: "t1", teamRole: "worker" });
assert.deepEqual(bots[2], { id: "loose", teamId: "", teamRole: "" }, "a bot no team lists stays loose");
assert.equal(reconcileTeamFields(bots, [team]), 0, "idempotent");

// Rail grouping by teamId now sees both members of the team.
const grouped = bots.filter((b) => b.teamId === "t1").map((b) => b.id);
assert.deepEqual(grouped, ["lead", "poster"]);

// A member listed only in memberIds with no role gets worker.
const w = [{ id: "poster" }];
reconcileTeamFields(w, [team]);
assert.deepEqual(w[0], { id: "poster", teamId: "t1", teamRole: "worker" });

// A bot that already names another live team keeps it.
const moved = [{ id: "lead", teamId: "t2", teamRole: "worker" }];
assert.equal(reconcileTeamFields(moved, [team, other]), 0);
assert.equal(moved[0].teamId, "t2");

// A dangling teamId is replaced by the team that lists the bot.
assert.equal(teamIdFor({ id: "poster", teamId: "gone" }, [team]), "t1");
// No team rows yet (first paint): nothing changes.
const early = [{ id: "lead", teamId: "", teamRole: "" }];
assert.equal(reconcileTeamFields(early, []), 0);

// Roles: an explicit role wins, otherwise chiefId decides.
assert.equal(teamRoleFor({ id: "lead" }, team), "chief");
assert.equal(teamRoleFor({ id: "poster" }, team), "worker");
assert.equal(teamRoleFor({ id: "lead", teamRole: "worker" }, team), "worker");
assert.equal(teamRoleFor({ id: "z" }, null), "");

// The lead is found by chiefId even with no role on the row, so the banner
// names them instead of saying "the lead".
const members = [{ id: "poster", teamRole: "worker", name: "Poster" }, { id: "lead", teamRole: "", name: "Personal" }];
assert.equal(leadOf(team, members)?.name, "Personal");
assert.equal(leadOf({ id: "t", chiefId: null }, [{ id: "a", teamRole: "chief", name: "A" }])?.name, "A");
assert.equal(leadOf(null, members), undefined);

console.log("ok team-groups");
