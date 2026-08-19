import assert from "node:assert/strict";
import * as routines from "../server/routines.mjs";
import { resolveZone } from "../server/context.mjs";

const NEW_YORK = "America/New_York";
const morning = { type: "daily", hour: 9, minute: 0 };
const at = (iso) => Date.parse(iso);

function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`not ok ${name}`);
    throw err;
  }
}

test("every 15 minutes keeps elapsed interval semantics", () => {
  const parsed = routines.parseSchedule("watch the inbox every 15 minutes");
  assert.equal(parsed.intervalMs, 15 * 60_000);
  assert.equal(parsed.schedule, undefined);
  const now = at("2026-01-15T12:00:00Z");
  const routine = { intervalMs: 15 * 60_000, lastRunAt: now - 15 * 60_000, enabled: true };
  assert.equal(routines.dueRoutines({ routines: [routine] }, now).length, 1);
  assert.equal(routines.dueRoutines({ routines: [{ ...routine, lastRunAt: now - 15 * 60_000 + 1 }] }, now).length, 0);
  assert.equal(routine.nextRunAt, undefined);
});

test("legacy daily parser remains an elapsed interval", () => {
  const parsed = routines.parseSchedule("check the inbox daily");
  assert.equal(parsed.intervalMs, 86400_000);
  assert.equal(parsed.schedule, undefined);
});

test("one-shot chat instructions remain rejected", () => {
  for (const text of ["check again", "try again", "resume"]) {
    assert.equal(routines.parseSchedule(text), null);
    assert.equal(routines.looksLikeSchedule(text), false);
  }
  const bot = { routines: [] };
  const result = routines.upsertRoutine(bot, { instruction: "check again" });
  assert.equal(result.routine, null);
  assert.equal(bot.routines.length, 0);
});

test("every morning becomes a 9 AM calendar schedule", () => {
  const parsed = routines.parseSchedule("watch the inbox every morning");
  assert.equal(parsed.intervalMs, undefined);
  assert.deepEqual(parsed.schedule, morning);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning"), true);
});

test("questions and unsupported morning clock forms are not scheduled", () => {
  assert.equal(routines.looksLikeSchedule("what should I do every morning?"), false);
  assert.equal(routines.looksLikeSchedule("what is every morning"), false);
  assert.equal(routines.looksLikeSchedule("I do not want to check the inbox every morning"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning at 8"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning at eight"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning 8am"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning by 8"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning in the AM"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning until noon"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning eight o'clock"), false);
  assert.equal(routines.looksLikeSchedule("at 8, watch the inbox every morning"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning at half past eight"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning before 8"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning at 8ish"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning 8ish"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning half past eight"), false);
  assert.equal(routines.looksLikeSchedule("watch the inbox every morning 8"), false);
  assert.equal(routines.looksLikeSchedule("8 every morning watch the inbox"), false);
  assert.equal(routines.looksLikeSchedule("Can you tell me what to do every morning"), false);
  assert.equal(routines.looksLikeSchedule("Do you check the inbox every morning"), false);
  assert.equal(routines.looksLikeSchedule("Should I check the inbox every day"), false);
  assert.equal(routines.looksLikeSchedule("Every morning, what should I check"), false);
  assert.equal(routines.looksLikeSchedule("I am monitoring the inbox every morning"), true);
  assert.equal(routines.upsertRoutine({ routines: [] }, { instruction: "watch the inbox every morning at 8", intervalMs: 15 * 60_000 }).routine.intervalMs, 15 * 60_000);
  assert.equal(routines.upsertRoutine({ routines: [] }, { instruction: "what is daily", intervalMs: 15 * 60_000 }).routine, null);
  assert.equal(routines.upsertRoutine({ routines: [] }, { instruction: "watch the inbox every morning at 8", forceNew: true }).routine, null);
});

test("embedded one-shot work is not scheduled", () => {
  for (const text of [
    "check again every 15 minutes",
    "resume every 15 minutes",
    "run again every 15 minutes",
    "run it again every 15 minutes",
    "try that again every 15 minutes",
    "check this again every 15 minutes",
    "do that again every 15 minutes",
    "check back every 15 minutes",
    "I need you to check again every 15 minutes",
  ]) {
    assert.equal(routines.looksLikeSchedule(text), false);
    assert.equal(routines.upsertRoutine({ routines: [] }, { instruction: text, forceNew: true }).routine, null);
  }
});

test("an explicit interval_minutes value remains authoritative", () => {
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "watch the inbox every morning",
    intervalMs: 15 * 60_000,
  });
  assert.equal(routine.intervalMs, 15 * 60_000);
  assert.equal(routine.schedule, undefined);
  assert.equal(routine.nextRunAt, undefined);
});

test("force_new creates an additional routine instead of merging", () => {
  const bot = { routines: [] };
  routines.upsertRoutine(bot, { instruction: "watch email every 15 minutes" });
  const result = routines.upsertRoutine(bot, {
    instruction: "watch flights every 15 minutes",
    forceNew: true,
    solo: false,
  });
  assert.equal(result.merged, false);
  assert.equal(bot.routines.length, 2);
  assert.equal(routines.upsertRoutine(bot, { instruction: "check again", forceNew: true }).routine, null);
});

test("a cadence-free standing brief update preserves a calendar routine", () => {
  const now = at("2026-01-15T13:00:00Z");
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "watch the inbox every morning",
    now,
    timeZone: NEW_YORK,
  });
  const next = routine.nextRunAt;
  routines.upsertRoutine(bot, {
    id: routine.id,
    instruction: "Watch the inbox and summarize anything urgent for the next checkpoint.",
    timeZone: NEW_YORK,
  });
  assert.deepEqual(routine.schedule, morning);
  assert.equal(routine.intervalMs, undefined);
  assert.equal(routine.nextRunAt, next);
});

test("a cadence-free standing brief update preserves a legacy interval", () => {
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, { instruction: "watch the inbox every 2 hours" });
  routines.upsertRoutine(bot, {
    id: routine.id,
    instruction: "Watch the inbox and summarize anything urgent for the next checkpoint.",
  });
  assert.equal(routine.intervalMs, 2 * 3600_000);
  assert.equal(routine.schedule, undefined);
  assert.equal(routine.nextRunAt, undefined);
});

test("morning routine is not due before its local occurrence", () => {
  const now = at("2026-01-15T13:59:00Z");
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "watch the inbox every morning",
    now,
    timeZone: NEW_YORK,
  });
  assert.equal(routine.nextRunAt, at("2026-01-15T14:00:00Z"));
  assert.equal(routines.dueRoutines(bot, now, { timeZone: NEW_YORK }).length, 0);
  assert.equal(routines.dueRoutines(bot, routine.nextRunAt, { timeZone: NEW_YORK }).length, 1);
  assert.equal(routines.dueRoutines(bot, routine.nextRunAt + 15 * 60_000, { timeZone: NEW_YORK }).length, 1);
});

test("advancing a delayed fire uses the following local day", () => {
  const fireAt = at("2026-01-15T14:30:00Z");
  const routine = { schedule: morning, nextRunAt: at("2026-01-15T14:00:00Z") };
  routines.advanceCalendarRoutine(routine, fireAt, NEW_YORK);
  assert.equal(routine.nextRunAt, at("2026-01-16T14:00:00Z"));
  assert.notEqual(routine.nextRunAt, fireAt + 24 * 60 * 60_000);
});

test("persisted calendar occurrence survives a restart unchanged", () => {
  const now = at("2026-01-15T13:00:00Z");
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "watch the inbox every morning",
    now,
    timeZone: NEW_YORK,
  });
  const restarted = { routines: [JSON.parse(JSON.stringify(routine))] };
  assert.equal(restarted.routines[0].nextRunAt, routine.nextRunAt);
  assert.equal(routines.dueRoutines(restarted, now, { timeZone: NEW_YORK }).length, 0);
  assert.equal(routines.dueRoutines(restarted, routine.nextRunAt, { timeZone: NEW_YORK }).length, 1);
});

test("resolved timezone controls the wall-clock occurrence", () => {
  const zone = resolveZone({ userTimeZoneOverride: "Europe/London" });
  const now = at("2026-01-15T08:59:00Z");
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "watch the inbox every morning",
    now,
    timeZone: zone,
  });
  assert.equal(routine.nextRunAt, at("2026-01-15T09:00:00Z"));
  assert.equal(routines.dueRoutines(bot, now, { timeZone: zone }).length, 0);
  assert.equal(routines.dueRoutines(bot, routine.nextRunAt, { timeZone: zone }).length, 1);
});

test("a changed resolved timezone rebases a persisted occurrence", () => {
  const now = at("2026-01-15T08:00:00Z");
  const routine = { schedule: morning, nextRunAt: at("2026-01-15T14:00:00Z") };
  assert.equal(routines.calendarNextRunAt(routine, now, "Europe/London"), at("2026-01-15T09:00:00Z"));
  assert.equal(routines.dueRoutines({ routines: [routine] }, now, { timeZone: "Europe/London" }).length, 0);
});

test("far-future persisted occurrences are recomputed from the current calendar", () => {
  const now = at("2026-01-15T08:00:00Z");
  const routine = { schedule: morning, nextRunAt: at("2030-01-15T14:00:00Z") };
  assert.equal(routines.calendarNextRunAt(routine, now, NEW_YORK), at("2026-01-15T14:00:00Z"));
});

test("daily wall-clock occurrence follows DST without drifting", () => {
  const beforeTransition = at("2026-03-07T14:30:00Z");
  const next = routines.nextCalendarOccurrence(beforeTransition, morning, NEW_YORK);
  assert.equal(next, at("2026-03-08T13:00:00Z"));
  assert.equal(next - at("2026-03-07T14:00:00Z"), 23 * 60 * 60_000);

  const routine = { schedule: morning, nextRunAt: at("2026-03-07T14:00:00Z") };
  routines.advanceCalendarRoutine(routine, at("2026-03-07T14:30:00Z"), NEW_YORK);
  assert.equal(routine.nextRunAt, next);
});

test("a nonexistent daily wall-clock time advances through a DST gap", () => {
  const schedule = { type: "daily", hour: 2, minute: 30 };
  const next = routines.nextCalendarOccurrence(at("2026-03-08T06:00:00Z"), schedule, NEW_YORK);
  assert.equal(next, at("2026-03-08T07:30:00Z"));
  const routine = { schedule, nextRunAt: next };
  assert.equal(routines.dueRoutines({ routines: [routine] }, next + 15_000, { timeZone: NEW_YORK }).length, 1);
});

test("invalid calendar fields are not normalized into midnight", () => {
  assert.equal(routines.normalizeSchedule({ type: "daily", hour: null, minute: null }), null);
  assert.equal(routines.normalizeSchedule({ type: "daily", hour: "9", minute: "0" }), null);
});

test("legacy interval routines remain valid without calendar metadata", () => {
  const now = at("2026-01-15T12:00:00Z");
  const legacy = { intervalMs: 2 * 3600_000, lastRunAt: now - 2 * 3600_000, enabled: true };
  const due = routines.dueRoutines({ routines: [legacy] }, now, { timeZone: NEW_YORK });
  assert.equal(due.length, 1);
  assert.equal(legacy.schedule, undefined);
  assert.equal(legacy.nextRunAt, undefined);
});

test("legacy morning interval data is not silently migrated", () => {
  const now = at("2026-01-15T14:00:00Z");
  const legacy = {
    instruction: "watch the inbox every morning",
    intervalMs: 86400_000,
    lastRunAt: now - 86400_000,
    enabled: true,
  };
  assert.equal(routines.dueRoutines({ routines: [legacy] }, now, { timeZone: NEW_YORK }).length, 1);
  assert.equal(legacy.schedule, undefined);
});

console.log("routine tests passed");
