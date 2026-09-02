/**
 * patchTeamStep was a read-modify-write with the lock taken separately for each
 * half: getTeam, then saveTeam spreading the caller's whole stale `job` over the
 * row. Turns are serialised per bot but NOT across bots, and every bot runs in
 * one process, so two workers reporting in overlapping turns is ordinary — and
 * the update that loses leaves its step forever `pending`. That is not a
 * cosmetic loss: maybeFinalizeSummary can then never fire, so the job never
 * completes, and jobProgress().complete never becomes true.
 *
 * Second bug in the same call: with a worker owning TWO steps and no label or
 * step id to disambiguate, upsertJobStep fell through and CREATED a step —
 * labelled "Task", since there was nothing to name it from — on every update.
 * They accumulated without bound, each one `running`, so the job could never
 * complete; and patchTeamStep reported back a DIFFERENT step (the first the bot
 * owned), so the model saw a plausible answer and never noticed.
 *
 * Isolated data dir: teams.mts binds its paths at import.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-teams-conc-"));
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
// Distinct, unrelated words: matchStepForAssignment fuzzy-matches on a hint, so
// near-identical labels collapse into ONE step and the setup silently builds
// the wrong fixture.
const WORDS = ["flights", "hotel", "visa", "insurance", "currency", "packing", "transfers", "vaccines"];
async function teamWithSteps(owners) {
  const id = `t${++n}`;
  await teams.saveTeam({ id, name: `team${n}`, memberIds: ["chief", ...owners], chiefId: "chief" });
  // Jobs come from the chief's set_job; a worker's update_task only moves a
  // step in a job that already exists (it no longer seeds one).
  await teams.setTeamJob(id, {
    title: `team${n}`,
    steps: owners.map((botId, i) => ({ label: WORDS[i], bot_id: botId, status: "pending" })),
  });
  const built = await teams.getTeam(id);
  const mine = (built.job?.steps || []).filter((s) => owners.includes(s.botId));
  assert.equal(mine.length, owners.length, `fixture is wrong: ${labels(built).join(", ")}`);
  return id;
}
const labels = (team) => (team.job?.steps || []).map((s) => `${s.label}:${s.status}`);

await test("two workers reporting at once both stick", async () => {
  const id = await teamWithSteps(["alpha", "beta"]);
  // Overlapping turns: the two calls interleave around their awaits.
  await Promise.all([
    teams.patchTeamStep(id, { botId: "alpha", label: WORDS[0], status: "done" }),
    teams.patchTeamStep(id, { botId: "beta", label: WORDS[1], status: "done" }),
  ]);
  const team = await teams.getTeam(id);
  const steps = team.job.steps.filter((s) => s.botId === "alpha" || s.botId === "beta");
  assert.equal(steps.length, 2, `expected 2 worker steps, got ${labels(team).join(", ")}`);
  for (const s of steps) {
    assert.equal(s.status, "done", `${s.botId}'s update was lost: ${labels(team).join(", ")}`);
  }
});

await test("many concurrent updates all land", async () => {
  const owners = Array.from({ length: 6 }, (_, i) => `w${i}`);
  const id = await teamWithSteps(owners);
  await Promise.all(
    owners.map((botId, i) => teams.patchTeamStep(id, { botId, label: WORDS[i], status: "done" })),
  );
  const team = await teams.getTeam(id);
  const done = (team.job.steps || []).filter((s) => s.status === "done").length;
  assert.equal(done, owners.length, `only ${done}/${owners.length} landed: ${labels(team).join(", ")}`);
});

// The unlabelled-update case.
// Seed the two steps through setTeamJob, the way a chief's set_job does.
// Building them with two patchTeamStep calls does NOT work — and that is
// correct: with one owned step, a second differently-worded label is absorbed
// into it rather than inventing a step. My first version of this test built its
// fixture through exactly the bug it was meant to pin.
async function twoStepWorker(id, stepLabels) {
  await teams.saveTeam({ id, name: "two-step", memberIds: ["chief", "w"], chiefId: "chief" });
  await teams.setTeamJob(id, {
    title: "trip",
    steps: [
      ...stepLabels.map((label) => ({ label, bot_id: "w", status: "pending" })),
      { label: "Summary", bot_id: "chief" },
    ],
  });
  const team = await teams.getTeam(id);
  const built = team.job.steps.filter((st) => st.botId === "w");
  assert.equal(built.length, stepLabels.length, `fixture is wrong: ${labels(team).join(", ")}`);
}

await test("an unlabelled update from a two-step worker does not invent steps", async () => {
  const id = `t${++n}`;
  await twoStepWorker(id, ["find flights", "book hotel"]);
  const before = (await teams.getTeam(id)).job.steps.length;

  for (let i = 0; i < 4; i++) {
    await teams.patchTeamStep(id, { botId: "w", status: "running", detail: `tick ${i}` });
  }

  const team = await teams.getTeam(id);
  assert.equal(
    team.job.steps.length,
    before,
    `${team.job.steps.length - before} step(s) were invented: ${labels(team).join(", ")}`,
  );
  assert.equal(
    (team.job.steps || []).some((s) => s.label === "Task"),
    false,
    `a junk "Task" step was created: ${labels(team).join(", ")}`,
  );
});

// KNOWN LIMIT, recorded rather than asserted: I could not build a state where
// ONE worker owns TWO steps. setTeamJob binds bot_id to a single step (the
// second comes back botId:null), and patchTeamStep folds a second label into
// the worker's existing step via the owned-length-1 rule above. So
// pickOwnedStep's "more than one owned, nothing to disambiguate" branch appears
// to be unreachable through the public API, and the junk-"Task" symptom it was
// added for may not be either. It is left in place because it is harmless and
// the reachability question is not settled -- but it is NOT covered by a test,
// and this comment exists so that is visible rather than assumed.

await fs.rm(tmp, { recursive: true, force: true });


// The regression the review caught: narrowing the fallback to "no label given"
// removed the original single-owned-step rule, so a worker rewording its own
// label invented a second step and left the first pending forever. The stored
// label is rewritten by taskTabName ("Find flights" -> "flights"), so a worker
// has no way to know the stored spelling without list_tasks.
await test("a one-step worker rewording its label updates that step, not a new one", async () => {
  const id = `t${++n}`;
  await teams.saveTeam({ id, name: "one-step", memberIds: ["chief", "w"], chiefId: "chief" });
  await teams.setTeamJob(id, { title: "one-step", steps: [{ label: "Compare travel insurance", bot_id: "w", status: "pending" }] });
  const before = (await teams.getTeam(id)).job.steps.length;

  await teams.patchTeamStep(id, { botId: "w", label: "done comparing insurance quotes", status: "done" });

  const team = await teams.getTeam(id);
  assert.equal(team.job.steps.length, before, `a step was invented: ${labels(team).join(", ")}`);
  const mine = team.job.steps.filter((st) => st.botId === "w");
  assert.equal(mine.length, 1, `worker owns ${mine.length} steps: ${labels(team).join(", ")}`);
  assert.equal(mine[0].status, "done", "the worker's own step was left behind");
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : `ok teams-concurrency (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
