import assert from "node:assert/strict";
import {
  chiefReportLlm,
  chiefReportStored,
  isFollowUpDispatch,
  storedChiefToWorker,
  wrapWorkerDispatch,
} from "../server/teammate.mjs";

const first = wrapWorkerDispatch({
  who: "Flight Checker",
  role: "chief",
  text: "Start now: DC -> SFO.",
  followUp: false,
});
assert.match(first, /assigned you this/);
assert.match(first, /update_task status=running/);
assert.match(first, /DC -> SFO/);

const note = wrapWorkerDispatch({
  who: "Flight Checker",
  role: "chief",
  text: "Heads up: add &curr=USD",
  followUp: true,
});
assert.match(note, /sent a note/);
assert.match(note, /Do not restart the search/);
assert.doesNotMatch(note, /update_task status=running/);
assert.match(note, /&curr=USD/);

assert.equal(storedChiefToWorker("Flight Checker", "Heads up: THB"), "Flight Checker: Heads up: THB");
assert.doesNotMatch(storedChiefToWorker("Flight Checker", "Start now"), /assigned you this/);

assert.equal(isFollowUpDispatch([]), false);
assert.equal(isFollowUpDispatch([{ role: "user", content: "hello" }]), false);
assert.equal(
  isFollowUpDispatch([{ role: "user", speakerRole: "chief", content: "Flight Checker: Start now" }]),
  true,
);

const stored = chiefReportStored("Leg3 DC-BKK", "$470 Qatar");
assert.equal(stored, "Leg3 DC-BKK replies: $470 Qatar");
assert.doesNotMatch(stored, /teammate report/);
assert.doesNotMatch(stored, /upsert_routine/);

const llm = chiefReportLlm("Leg3 DC-BKK", "$470 Qatar");
assert.match(llm, /Leg3 DC-BKK replies: \$470 Qatar/);
assert.match(llm, /teammate report/);
assert.match(llm, /EVERY non-Summary step/);
assert.match(llm, /including any you did yourself/);

console.log("ok teammate");
