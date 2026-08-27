/**
 * removeMembers had no coverage, and it carried a branch that could never run:
 * `drop.has(team.chiefId) ? memberIds[0] || null : team.chiefId` — a
 * promote-the-first-member fallback, three lines below a `drop.delete(chiefId)`
 * that makes the condition permanently false.
 *
 * Removing dead code is only safe if the surviving behaviour is pinned, so
 * these pin it — including the consequence nobody had written down: asking to
 * remove the chief is a SILENT no-op, not an error.
 *
 * Isolated data dir: SUB8BOT_DATA is set before @sub8/store is imported, since
 * it binds dataDir once at load. Never touches real bots.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-teams-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const teams = await import("../server/teams.mjs");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

let n = 0;
const freshTeam = async (memberIds, chiefId) =>
  teams.saveTeam({ id: `t${++n}`, name: `team${n}`, memberIds: [...memberIds], chiefId });

await test("removing a worker drops only that worker", async () => {
  const t = await freshTeam(["c", "w1", "w2"], "c");
  const out = await teams.removeMembers(t, ["w1"]);
  assert.deepEqual(out.memberIds, ["c", "w2"]);
  assert.equal(out.chiefId, "c", "the chief is untouched");
});

await test("removing every worker keeps the team and the chief", async () => {
  const t = await freshTeam(["c", "w1", "w2"], "c");
  const out = await teams.removeMembers(t, ["w1", "w2"]);
  assert.deepEqual(out.memberIds, ["c"]);
  assert.equal(out.chiefId, "c");
});

// The consequence of the chief being unremovable. Documented, not endorsed:
// a caller that asks to close the chief gets no error and no change.
await test("KNOWN: asking to remove the chief is a silent no-op", async () => {
  const t = await freshTeam(["c", "w1"], "c");
  const out = await teams.removeMembers(t, ["c"]);
  assert.deepEqual(out.memberIds, ["c", "w1"], "nothing was removed");
  assert.equal(out.chiefId, "c");
});

await test("the chief survives even when named alongside every worker", async () => {
  const t = await freshTeam(["c", "w1", "w2"], "c");
  const out = await teams.removeMembers(t, ["c", "w1", "w2"]);
  assert.deepEqual(out.memberIds, ["c"], "workers go, chief stays");
  assert.equal(out.chiefId, "c", "and is never replaced by a promoted member");
});

await test("a chief-less team can be emptied, and then the team is deleted", async () => {
  const t = await freshTeam(["a", "b"], null);
  const out = await teams.removeMembers(t, ["a", "b"]);
  assert.equal(out, null, "an empty team is removed entirely");
  assert.equal(await teams.getTeam(t.id), null);
});

await test("no-op inputs return the team unchanged", async () => {
  const t = await freshTeam(["c", "w1"], "c");
  for (const ids of [[], null, undefined, [null, undefined, ""]]) {
    const out = await teams.removeMembers(t, ids);
    assert.deepEqual(out.memberIds, ["c", "w1"], `unchanged for ${JSON.stringify(ids)}`);
  }
  assert.equal(await teams.removeMembers(null, ["x"]), null);
});

await fs.rm(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok teams-remove");
process.exit(failed.length ? 1 : 0);
