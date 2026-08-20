import assert from "node:assert/strict";
import {
  applyStepUpdate,
  isMetaStepLabel,
  jobProgress,
  matchStepForAssignment,
  maybeFinalizeSummary,
  newJob,
  taskTabName,
  uniqueMemberName,
} from "../server/teams.mjs";

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

assert.equal(isMetaStepLabel("Summary"), true);
assert.equal(isMetaStepLabel("San Jose shops"), false);
assert.equal(taskTabName("San Jose shops"), "San Jose shops");
assert.ok(taskTabName("Find 5 well-rated flower shops in San Jose, CA (Google Maps). For each: name").toLowerCase().includes("flower"));
assert.equal(
  uniqueMemberName("San Jose shops", [{ id: "x", name: "San Jose shops" }, { id: "p", name: "pizza-scout" }], "p"),
  "San Jose shops 2",
);

const flowers = newJob({
  title: "Flower shops",
  steps: [
    { label: "San Francisco shops" },
    { label: "San Jose shops" },
    { label: "Milpitas shops" },
    { label: "Compile list" },
  ],
});
assert.equal(matchStepForAssignment(flowers, "Find 5 well-rated flower shops in San Jose, CA (Google Maps)")?.label, "San Jose shops");
assert.equal(matchStepForAssignment(flowers, "Find 5 well-rated flower shops in Milpitas, CA")?.label, "Milpitas shops");
assert.equal(matchStepForAssignment(flowers, "please compile the list")?.label, undefined);

r = applyStepUpdate(flowers, { label: "San Jose shops", botId: "pizza-scout", status: "running" });
assert.equal(r.step.botId, "pizza-scout");

console.log("ok jobs");
