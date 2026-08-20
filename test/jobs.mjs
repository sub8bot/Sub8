import assert from "node:assert/strict";
import { applyStepUpdate, jobProgress, maybeFinalizeSummary, newJob } from "../server/teams.mjs";

const job = newJob({
  title: "SF food",
  steps: [
    { label: "Pizza", bot_id: "p" },
    { label: "Tacos", bot_id: "t" },
    { label: "Summary", bot_id: "s" },
  ],
});
assert.equal(job.steps.length, 3);
assert.equal(jobProgress(job).pending, 3);
assert.equal(jobProgress(job).complete, false);

let r = applyStepUpdate(job, { botId: "p", status: "running", detail: "searching" });
assert.equal(r.step.status, "running");
r = applyStepUpdate(job, { botId: "p", status: "running", detail: "searching again" });
assert.equal(r.step.loopCount, 1);
r = applyStepUpdate(job, { botId: "p", status: "running" });
assert.equal(r.step.status, "looping");
r = applyStepUpdate(job, { label: "Pizza", status: "done", detail: "Tony's 4.5" });
assert.equal(r.step.status, "done");
assert.equal(r.step.loopCount, 0);
applyStepUpdate(job, { botId: "t", status: "done", detail: "El Patron 4.6" });
const fin = maybeFinalizeSummary(job);
assert.equal(fin.finalized, true);
assert.equal(jobProgress(job).complete, true);
assert.equal(jobProgress(job).done, 3);

const early = newJob({ title: "wait", steps: [{ label: "Pizza", bot_id: "p" }, { label: "Summary", bot_id: "s" }] });
assert.equal(maybeFinalizeSummary(early).finalized, false);
applyStepUpdate(early, { label: "Pizza", status: "done" });
assert.equal(maybeFinalizeSummary(early).finalized, true);

console.log("ok jobs");
