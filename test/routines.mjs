import assert from "node:assert/strict";
import { overlappingRoutine, upsertRoutine } from "../server/routines.mjs";

const bot = { routines: [] };
const first = upsertRoutine(bot, {
  name: "X",
  instruction: "Check x.com notifications every 15 minutes and post once.",
  intervalMs: 15 * 60_000,
  groupKey: "x-inbox",
});
assert.equal(first.merged, false);
assert.equal(bot.routines.length, 1);

const overlap = overlappingRoutine(bot, { groupKey: "x-inbox", intervalMs: 20 * 60_000 });
assert.equal(overlap.id, first.routine.id);

const merged = upsertRoutine(bot, {
  instruction: "Check x.com every 15 minutes, then answer mentions, then post.",
  intervalMs: 15 * 60_000,
  groupKey: "x-inbox",
  forceReplace: true,
});
assert.equal(merged.merged, true);
assert.equal(bot.routines.length, 1);
assert.match(merged.routine.instruction, /answer mentions/);

const clash = upsertRoutine(bot, {
  name: "Also X",
  instruction: "Another X job every 15 minutes that would double-fire.",
  intervalMs: 15 * 60_000,
  groupKey: "general",
  forceNew: true,
});
assert.equal(clash.routine.id, first.routine.id);
assert.match(clash.rejected, /overlaps/);
assert.equal(bot.routines.length, 1);

const explicit = upsertRoutine(bot, {
  id: first.routine.id,
  instruction: "Operator rewrite of the standing brief. Open x.com every 15 minutes.",
  forceReplace: true,
});
assert.equal(explicit.merged, true);
assert.match(explicit.routine.instruction, /Operator rewrite/);

console.log("ok routines");
