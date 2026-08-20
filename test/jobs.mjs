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
  upsertJobStep,
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

const auto = upsertJobStep(null, {
  botId: "w1",
  label: "DC→SFO",
  content: "one-way DC to SFO",
  chiefId: "c1",
  title: "check flights",
});
assert.equal(auto.title, "check flights");
assert.equal(auto.steps.map((s) => s.label).join(","), "DC→SFO,Summary");
assert.equal(auto.steps[0].botId, "w1");
const grown = upsertJobStep(auto, { botId: "w2", label: "DC→BKK", content: "DC to Bangkok", chiefId: "c1" });
assert.equal(grown.steps.map((s) => s.label).join(","), "DC→SFO,DC→BKK,Summary");

const own = upsertJobStep(grown, { botId: "c1", label: "SF→DC", status: "running", chiefId: "c1" });
assert.equal(own.steps.map((s) => s.label).join(","), "DC→SFO,DC→BKK,SF→DC,Summary");
assert.equal(own.steps.find((s) => s.label === "SF→DC").botId, "c1");
assert.equal(own.steps.find((s) => s.label === "Summary").botId, "c1");

const loopJob = newJob({
  title: "x",
  steps: [
    { label: "A", bot_id: "w" },
    { label: "Summary", bot_id: "c" },
  ],
});
applyStepUpdate(loopJob, { botId: "w", status: "running" });
applyStepUpdate(loopJob, { botId: "w", detail: "still going" });
assert.equal(loopJob.steps[0].status, "running");
assert.equal(loopJob.steps[0].loopCount || 0, 0);
applyStepUpdate(loopJob, { botId: "w", status: "running", detail: "again" });
assert.equal(loopJob.steps[0].loopCount, 1);

const dual = newJob({
  title: "flights",
  steps: [
    { label: "SF→DC", bot_id: "c" },
    { label: "Summary", bot_id: "c" },
  ],
});
applyStepUpdate(dual, { label: "SF→DC", botId: "c", status: "done", detail: "$240 Frontier" });
assert.equal(dual.steps.find((s) => s.label === "SF→DC").botId, "c");
assert.equal(dual.steps.find((s) => s.label === "Summary").botId, "c");

console.log("ok jobs");
