/**
 * Two parallel create_teammate calls used to each saveTeam when the chief had
 * no teamId. Aika ended up chief of two teams named the same thing; one worker
 * sat in Unassigned. ensureTeamForBot + addMember must share one team.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-teams-create-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("@sub8/store");
const teams = await import("../server/teams.mjs");

const chief = store.newBot({ name: "AikaBotto", harness: { provider: "grok-build" } });
chief.vm = { ...(chief.vm || {}), computerId: "desk-1" };
await store.upsertBot(chief);

const [a, b] = await Promise.all([teams.ensureTeamForBot(chief), teams.ensureTeamForBot(chief)]);
assert.equal(a.id, b.id, "parallel ensureTeamForBot must return the same team");
assert.equal((await teams.listTeams()).length, 1, "must not spawn a second AikaBotto's team");

chief.teamId = "";
await store.upsertBot(chief);
const reused = await teams.ensureTeamForBot(chief);
assert.equal(reused.id, a.id, "a chief with empty teamId still joins their existing desk team");

const team = await teams.getTeam(a.id);
const [one, two] = await Promise.all([
  teams.addMember(team, { name: "mediaone", job: "post mixed stills" }),
  teams.addMember(team, { name: "mediatwo", job: "post different stills" }),
]);
assert.notEqual(one.bot.id, two.bot.id);
const live = await teams.getTeam(a.id);
assert.equal(
  (live.memberIds || []).includes(one.bot.id) && (live.memberIds || []).includes(two.bot.id),
  true,
  `both workers must stay on the team, got ${JSON.stringify(live.memberIds)}`,
);
assert.equal((await teams.listTeams()).length, 1);

await teams.saveTeam({
  name: "AikaBotto's team",
  chiefId: chief.id,
  memberIds: [chief.id, "stray-worker"],
  computerId: "desk-1",
});
assert.equal((await teams.listTeams()).length, 2);
const merged = await teams.ensureTeamForBot(chief);
assert.equal((await teams.listTeams()).length, 1, "duplicate chief teams on the same desk collapse");
assert.equal(merged.memberIds.includes("stray-worker"), true);
assert.equal(merged.memberIds.includes(one.bot.id), true);
assert.equal(merged.memberIds.includes(two.bot.id), true);

console.log("ok teams-create");
