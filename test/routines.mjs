import assert from "node:assert/strict";
import * as routines from "../server/routines.mjs";
import { overlappingRoutine, upsertRoutine } from "../server/routines.mjs";
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

test("overlapping jobs merge instead of stacking", () => {
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
});

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

test("restaurant hours daily is not a standing job", () => {
  const blob = `Tacos replies:
Every field holds up. Hours: Closed · Opens 10 AM — consistent with 10 AM–10 PM daily.
Rating 4.6 ★ · 1,530 reviews on Google Maps.`;
  assert.equal(routines.looksLikeSchedule(blob), false);
  assert.equal(routines.looksLikeTeammateTraffic(blob), true);
  const r = upsertRoutine({ routines: [] }, { instruction: blob });
  assert.equal(r.routine, null);
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
  assert.equal(routines.looksLikeSchedule("Summarize overnight mail every morning and flag meetings before noon"), true);
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

test("a standing brief may use continue without being rejected", () => {
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "Watch the inbox every morning and continue yesterday's digest.",
    timeZone: NEW_YORK,
  });
  assert.ok(routine);
  assert.deepEqual(routine.schedule, morning);
  const updated = routines.upsertRoutine(bot, {
    id: routine.id,
    instruction: "Watch the inbox every morning and continue yesterday's digest, then stop.",
    timeZone: NEW_YORK,
    forceReplace: true,
  });
  assert.equal(updated.rejected, undefined);
  assert.match(updated.routine.instruction, /continue yesterday/);
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

test("a 1440-minute morning job becomes a 9 AM calendar schedule", () => {
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "watch the inbox every morning",
    intervalMs: 86400_000,
    timeZone: NEW_YORK,
    now: at("2026-01-15T13:00:00Z"),
  });
  assert.deepEqual(routine.schedule, morning);
  assert.equal(routine.intervalMs, undefined);
});

test("force_new with a similar interval is rejected as overlap", () => {
  const bot = { routines: [] };
  routines.upsertRoutine(bot, { instruction: "watch email every 15 minutes" });
  const result = routines.upsertRoutine(bot, {
    instruction: "watch flights every 15 minutes",
    forceNew: true,
    solo: false,
  });
  assert.match(result.rejected, /overlaps/);
  assert.equal(bot.routines.length, 1);
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

test("a missed yesterday morning waits for today's 9 AM", () => {
  const yesterday = at("2026-01-14T14:00:00Z");
  const eightAm = at("2026-01-15T13:00:00Z");
  const routine = { schedule: morning, nextRunAt: yesterday, enabled: true };
  assert.equal(routines.calendarNextRunAt(routine, eightAm, NEW_YORK), at("2026-01-15T14:00:00Z"));
  assert.equal(routines.dueRoutines({ routines: [routine] }, eightAm, { timeZone: NEW_YORK }).length, 0);
});

test("a missed yesterday morning fires once after today's 9 AM and advances to tomorrow", () => {
  const yesterday = at("2026-01-14T14:00:00Z");
  const tenAm = at("2026-01-15T15:00:00Z");
  const routine = { schedule: morning, nextRunAt: yesterday, enabled: true };
  assert.equal(routines.calendarNextRunAt(routine, tenAm, NEW_YORK), at("2026-01-15T14:00:00Z"));
  assert.equal(routines.dueRoutines({ routines: [routine] }, tenAm, { timeZone: NEW_YORK }).length, 1);
  routines.advanceCalendarRoutine(routine, tenAm, NEW_YORK);
  assert.equal(routine.nextRunAt, at("2026-01-16T14:00:00Z"));
  assert.equal(routines.dueRoutines({ routines: [routine] }, tenAm, { timeZone: NEW_YORK }).length, 0);
});

test("advancing a delayed fire uses the following local day", () => {
  const fireAt = at("2026-01-15T14:30:00Z");
  const routine = { schedule: morning, nextRunAt: at("2026-01-15T14:00:00Z") };
  routines.advanceCalendarRoutine(routine, fireAt, NEW_YORK);
  assert.equal(routine.nextRunAt, at("2026-01-16T14:00:00Z"));
  assert.notEqual(routine.nextRunAt, fireAt + 24 * 60 * 60_000);
});

test("after advance the same morning is not due again", () => {
  const fireAt = at("2026-01-15T14:00:00Z");
  const routine = { schedule: morning, nextRunAt: fireAt, enabled: true };
  routines.advanceCalendarRoutine(routine, fireAt, NEW_YORK);
  assert.equal(routines.dueRoutines({ routines: [routine] }, fireAt + 15_000, { timeZone: NEW_YORK }).length, 0);
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

test("daily wall-clock occurrence follows a fall-back without drifting", () => {
  const beforeTransition = at("2026-10-31T13:30:00Z");
  const next = routines.nextCalendarOccurrence(beforeTransition, morning, NEW_YORK);
  assert.equal(next, at("2026-11-01T14:00:00Z"));
  assert.equal(next - at("2026-10-31T13:00:00Z"), 25 * 60 * 60_000);
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

test("legacy morning interval data migrates to a 9 AM calendar schedule", () => {
  const eightAm = at("2026-01-15T13:00:00Z");
  const legacy = {
    instruction: "watch the inbox every morning",
    intervalMs: 86400_000,
    lastRunAt: eightAm - 86400_000,
    enabled: true,
  };
  assert.equal(routines.dueRoutines({ routines: [legacy] }, eightAm, { timeZone: NEW_YORK }).length, 0);
  assert.deepEqual(legacy.schedule, morning);
  assert.equal(legacy.intervalMs, undefined);
  assert.equal(legacy.nextRunAt, at("2026-01-15T14:00:00Z"));
});

test("interval and daily triggers can share a routine", () => {
  const now = at("2026-01-15T12:00:00Z");
  const bot = { routines: [] };
  const { routine } = upsertRoutine(bot, {
    instruction: "Watch the inbox and send a digest.",
    triggers: [
      { kind: "interval", intervalMs: 2 * 3600_000, lastRunAt: now },
      { kind: "daily", times: [{ hour: 8, minute: 0 }] },
    ],
    timeZone: NEW_YORK,
    now,
  });
  assert.equal(routine.triggers.length, 2);
  assert.equal(routines.dueRoutines(bot, now, { timeZone: NEW_YORK }).length, 0);
  assert.equal(routines.dueRoutines(bot, now + 2 * 3600_000, { timeZone: NEW_YORK }).length, 1);
});

test("weekdays skip Saturday", () => {
  const fridayNight = at("2026-01-16T23:00:00Z");
  const next = routines.nextTriggerOccurrence(
    { kind: "weekdays", times: [{ hour: 8, minute: 0 }] },
    fridayNight,
    NEW_YORK,
  );
  assert.equal(next, at("2026-01-19T13:00:00Z"));
});

test("cron 0 8 * * * is 8 AM local", () => {
  assert.ok(routines.parseCron("0 8 * * *"));
  const now = at("2026-01-15T12:00:00Z");
  const next = routines.nextCronOccurrence(now, "0 8 * * *", NEW_YORK);
  assert.equal(next, at("2026-01-15T13:00:00Z"));
});

test("trigger labels match the schedule chips", () => {
  assert.equal(routines.triggerLabel({ kind: "hourly" }), "Every hour");
  assert.equal(routines.triggerLabel({ kind: "interval", intervalMs: 2 * 3600_000 }), "Every 2 hours");
  assert.equal(routines.triggerLabel({ kind: "daily", times: [{ hour: 8, minute: 0 }] }), "Every day at 8:00 AM");
  assert.equal(routines.triggerLabel({ kind: "cron", cron: "0 8 * * *" }), "0 8 * * *");
});

console.log("ok routines");
