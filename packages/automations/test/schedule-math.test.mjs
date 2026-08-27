import test from "node:test";
import assert from "node:assert/strict";
import * as routines from "../dist/index.js";

const NEW_YORK = "America/New_York";
const LONDON = "Europe/London";
const at = (iso) => Date.parse(iso);
const nine = [{ hour: 9, minute: 0 }];

// ---------------------------------------------------------------------------
// Month ends and leap years. `matchDay` clamps monthDay to the last day of the
// month, so "monthly on the 31st" has to land on Feb 28 / Apr 30 rather than
// skipping those months entirely.
// ---------------------------------------------------------------------------

test("monthly on the 31st lands on the last day of a short month", () => {
  const trigger = { kind: "monthly", monthDay: 31, times: nine };
  const next = (from) => routines.nextTriggerOccurrence(trigger, at(from), NEW_YORK);
  // February 2026 has 28 days: the job fires on the 28th, it does not skip February.
  assert.equal(next("2026-02-01T15:00:00Z"), at("2026-02-28T14:00:00Z"));
  // April has 30 days, and April is EDT so 9 AM local is 13:00Z.
  assert.equal(next("2026-04-01T15:00:00Z"), at("2026-04-30T13:00:00Z"));
  // A month that really has a 31st is untouched.
  assert.equal(next("2026-12-01T15:00:00Z"), at("2026-12-31T14:00:00Z"));
});

test("monthly on the 29th reaches Feb 29 only in a leap year", () => {
  const trigger = { kind: "monthly", monthDay: 29, times: nine };
  const next = (from) => routines.nextTriggerOccurrence(trigger, at(from), NEW_YORK);
  assert.equal(next("2027-02-01T15:00:00Z"), at("2027-02-28T14:00:00Z"));
  assert.equal(next("2028-02-01T15:00:00Z"), at("2028-02-29T14:00:00Z"));
});

test("a monthly job fires once on the clamped day, not on every day it could match", () => {
  const now = at("2026-02-28T14:00:00Z");
  const trigger = { kind: "monthly", monthDay: 31, times: nine, lastRunAt: 0, nextRunAt: now };
  assert.equal(routines.triggerDue(trigger, now, NEW_YORK), true);
  routines.advanceTrigger(trigger, now, NEW_YORK);
  // March has a 31st, so the next fire is March 31 — not "tomorrow, March 1".
  assert.equal(trigger.nextRunAt, at("2026-03-31T13:00:00Z"));
  assert.equal(routines.triggerDue(trigger, now, NEW_YORK), false);
});

// ---------------------------------------------------------------------------
// DST. A wall-clock routine must keep its hour, and must never fire twice on a
// fall-back day or vanish on a spring-forward day.
// ---------------------------------------------------------------------------

test("a daily trigger keeps its wall clock across both DST transitions", () => {
  const daily = { kind: "daily", times: nine };
  const spring = routines.nextTriggerOccurrence(daily, at("2026-03-07T14:30:00Z"), NEW_YORK);
  assert.equal(spring, at("2026-03-08T13:00:00Z"));
  assert.equal(spring - at("2026-03-07T14:00:00Z"), 23 * 3600_000, "spring-forward day is 23 hours long");

  const fall = routines.nextTriggerOccurrence(daily, at("2026-10-31T13:30:00Z"), NEW_YORK);
  assert.equal(fall, at("2026-11-01T14:00:00Z"));
  assert.equal(fall - at("2026-10-31T13:00:00Z"), 25 * 3600_000, "fall-back day is 25 hours long");
});

test("a weekly trigger crosses spring-forward without drifting an hour", () => {
  const monday = { kind: "weekly", weekday: 1, times: nine };
  // Friday March 6 → Monday March 9, the first Monday after the transition.
  assert.equal(
    routines.nextTriggerOccurrence(monday, at("2026-03-06T12:00:00Z"), NEW_YORK),
    at("2026-03-09T13:00:00Z"),
  );
});

test("a daily trigger inside the spring-forward gap advances instead of vanishing", () => {
  // 2:30 AM does not exist in New York on 2026-03-08. The routine must still
  // fire that day (at 3:30 EDT), not silently skip 24 hours.
  const gap = { kind: "daily", times: [{ hour: 2, minute: 30 }] };
  assert.equal(routines.nextTriggerOccurrence(gap, at("2026-03-07T12:00:00Z"), NEW_YORK), at("2026-03-08T07:30:00Z"));
  assert.equal(routines.nextTriggerOccurrence(gap, at("2026-03-08T06:00:00Z"), NEW_YORK), at("2026-03-08T07:30:00Z"));
});

test("an ambiguous fall-back time fires once, on the earlier of the two instants", () => {
  // 1:30 AM happens twice in New York on 2026-11-01: 05:30Z (EDT) and 06:30Z (EST).
  const schedule = { type: "daily", hour: 1, minute: 30 };
  const first = routines.nextCalendarOccurrence(at("2026-10-31T12:00:00Z"), schedule, NEW_YORK);
  assert.equal(first, at("2026-11-01T05:30:00Z"));

  const routine = { schedule, nextRunAt: first, enabled: true };
  assert.equal(routines.dueRoutines({ routines: [routine] }, first, { timeZone: NEW_YORK }).length, 1);
  routines.advanceCalendarRoutine(routine, first, NEW_YORK);
  assert.equal(routine.nextRunAt, at("2026-11-02T06:30:00Z"), "next day, EST");
  assert.equal(
    routines.dueRoutines({ routines: [routine] }, at("2026-11-01T06:30:00Z"), { timeZone: NEW_YORK }).length,
    0,
    "the second 1:30 AM must not fire the routine a second time",
  );
});

// ---------------------------------------------------------------------------
// Timezone changes. `resolveZone` can return a different zone between two ticks
// (the operator travels, or edits the override); the routine has to rebase.
// ---------------------------------------------------------------------------

test("a resolved timezone change rebases the next run and does not double-fire that day", () => {
  const bot = { routines: [] };
  const { routine } = routines.upsertRoutine(bot, {
    instruction: "watch the inbox every morning",
    now: at("2026-01-15T13:00:00Z"),
    timeZone: NEW_YORK,
  });
  assert.equal(routine.nextRunAt, at("2026-01-15T14:00:00Z"));
  routines.advanceCalendarRoutine(routine, at("2026-01-15T14:00:00Z"), NEW_YORK);
  assert.equal(routine.nextRunAt, at("2026-01-16T14:00:00Z"));

  // The operator is now in London. 09:30Z is 9:30 London — today's 9 AM already
  // passed there, so the routine waits for tomorrow rather than firing late.
  const inLondon = at("2026-01-16T09:30:00Z");
  assert.equal(routines.calendarNextRunAt(routine, inLondon, LONDON), at("2026-01-17T09:00:00Z"));
  assert.equal(routines.dueRoutines(bot, inLondon, { timeZone: LONDON }).length, 0);

  routines.advanceCalendarRoutine(routine, inLondon, LONDON);
  assert.equal(routine.nextRunTimeZone, LONDON);
  assert.equal(
    routines.dueRoutines(bot, at("2026-01-16T14:00:00Z"), { timeZone: LONDON }).length,
    0,
    "the old New York 9 AM must not fire once the zone has moved",
  );
});

// ---------------------------------------------------------------------------
// Due-ness after a long sleep. This is the "24 hourly routines in a burst" case.
// ---------------------------------------------------------------------------

test("an hourly routine asleep for a day is due once, not twenty-four times", () => {
  const now = at("2026-01-15T12:00:00Z");
  const routine = { id: "r1", intervalMs: 3600_000, lastRunAt: now - 24 * 3600_000, enabled: true };
  const bot = { routines: [routine] };
  assert.equal(routines.dueRoutines(bot, now).length, 1);
  // The scheduler stamps lastRunAt = now; that must clear the whole backlog.
  routine.lastRunAt = now;
  assert.equal(routines.dueRoutines(bot, now).length, 0);
  assert.equal(routines.dueRoutines(bot, now + 3599_999).length, 0);
  assert.equal(routines.dueRoutines(bot, now + 3600_000).length, 1, "and exactly one hour later, once more");
});

test("advancing an elapsed trigger after a long sleep does not queue the catch-up runs", () => {
  const now = at("2026-01-15T12:00:00Z");
  const trigger = { kind: "hourly", lastRunAt: at("2026-01-14T12:00:00Z"), nextRunAt: null };
  assert.equal(routines.triggerDue(trigger, now), true);
  routines.advanceTrigger(trigger, now);
  assert.equal(trigger.lastRunAt, now);
  assert.equal(trigger.nextRunAt, now + 3600_000, "one hour from now, not from the stale lastRunAt");
  assert.equal(routines.triggerDue(trigger, now), false);
});

test("a daily trigger missed for three days fires once and resumes tomorrow", () => {
  const now = at("2026-01-15T15:00:00Z");
  const trigger = {
    kind: "daily",
    times: nine,
    lastRunAt: at("2026-01-12T14:00:00Z"),
    nextRunAt: at("2026-01-13T14:00:00Z"),
  };
  assert.equal(routines.triggerDue(trigger, now, NEW_YORK), true);
  routines.advanceTrigger(trigger, now, NEW_YORK);
  assert.equal(trigger.nextRunAt, at("2026-01-16T14:00:00Z"), "tomorrow, not the two skipped mornings");
  assert.equal(routines.triggerDue(trigger, now, NEW_YORK), false);
});

test("the legacy morning migration fires today rather than skipping the day", () => {
  // hydrateRoutine runs inside dueRoutines. Migrating at 10 AM local sets
  // nextRunAt to today's 9 AM, which is already past — so the routine fires
  // once, immediately, instead of waiting until tomorrow.
  const tenAm = at("2026-01-15T15:00:00Z");
  const legacy = {
    id: "legacy",
    instruction: "watch the inbox every morning",
    intervalMs: 86400_000,
    lastRunAt: tenAm - 86400_000,
    enabled: true,
  };
  const bot = { routines: [legacy] };
  assert.equal(routines.dueRoutines(bot, tenAm, { timeZone: NEW_YORK }).length, 1);
  assert.equal(legacy.nextRunAt, at("2026-01-15T14:00:00Z"));
  assert.equal(legacy.intervalMs, undefined);
  routines.advanceCalendarRoutine(legacy, tenAm, NEW_YORK);
  assert.equal(routines.dueRoutines(bot, tenAm, { timeZone: NEW_YORK }).length, 0);
});

test("packDue collapses a group into one turn instead of one turn per routine", () => {
  // Three due routines in the same group must reach the model as a single
  // prompt; otherwise a bot that wakes up behind fires three turns at once.
  const packs = routines.packDue([
    { id: "a", groupKey: "email", name: "Email", instruction: "read mail" },
    { id: "b", groupKey: "email", name: "Second", instruction: "flag urgent" },
    { id: "c", groupKey: "flights", name: "Flights", instruction: "watch fares" },
  ]);
  assert.equal(packs.length, 2);
  assert.deepEqual(packs[0].ids, ["a", "b"]);
  assert.equal(packs[0].name, "Email", "the pack is named after the first routine in the group");
  assert.equal(packs[0].instruction, "read mail\nflag urgent");
  assert.deepEqual(packs[1].ids, ["c"]);
});

// ---------------------------------------------------------------------------
// Cron. The UI has a free-text cron field, so an operator can type anything.
// ---------------------------------------------------------------------------

test("cron day-of-month and day-of-week are ORed when both are restricted", () => {
  // Standard cron: "0 9 13 * 5" is the 13th OR any Friday, not their intersection.
  assert.equal(
    routines.nextCronOccurrence(at("2026-01-15T12:00:00Z"), "0 9 13 * 5", NEW_YORK),
    at("2026-01-16T14:00:00Z"),
    "Friday Jan 16, reached through the weekday half of the OR",
  );
  assert.equal(
    routines.nextCronOccurrence(at("2026-01-17T12:00:00Z"), "0 9 * * 1-5", NEW_YORK),
    at("2026-01-19T14:00:00Z"),
    "Saturday skips to Monday",
  );
});

// The fall-back half, which had no test — and that omission is why the
// day-walking rewrite shipped with a hole. On 2026-11-01 in New York the wall
// times 01:00-01:59 happen TWICE. The walk generates candidates by wall time,
// so every candidate in the repeated hour resolved to the earlier (EDT)
// instant, failed the "after now" test once the clock was past it, and was
// discarded — then the loop moved to the next day. An every-5-minutes routine
// stopped firing for up to 65 minutes, once a year.
//
// Note the shape of the third case: 01:00 EST is LATER in real time than
// 01:55 EDT even though its wall clock reads earlier, so the walk cannot return
// on the first wall-order hit — it has to take the earliest qualifying instant
// across the whole day.
test("a cron keeps firing through a DST fall-back", () => {
  assert.equal(
    routines.nextCronOccurrence(at("2026-11-01T06:15:00Z"), "*/5 * * * *", NEW_YORK),
    at("2026-11-01T06:20:00Z"),
    "skipped the rest of the repeated hour",
  );
  assert.equal(
    routines.nextCronOccurrence(at("2026-11-01T05:55:00Z"), "*/5 * * * *", NEW_YORK),
    at("2026-11-01T06:00:00Z"),
    "01:00 EST is later than 01:55 EDT — the second pass must not be skipped",
  );
  assert.equal(
    routines.nextCronOccurrence(at("2026-11-01T05:05:00Z"), "0 * * * *", NEW_YORK),
    at("2026-11-01T06:00:00Z"),
    "an hourly cron lost the repeated hour entirely",
  );
});

// Southern hemisphere: the transition runs the other way round in the calendar.
test("a fall-back is handled the same way south of the equator", () => {
  const SYD = "Australia/Sydney";
  const t = routines.nextCronOccurrence(at("2026-04-04T15:30:00Z"), "*/5 * * * *", SYD);
  assert.ok(t !== null, "returned null across the Sydney transition");
  assert.ok(t > at("2026-04-04T15:30:00Z"), "went backwards");
  assert.ok(t - at("2026-04-04T15:30:00Z") <= 10 * 60_000, `jumped ${(t - at("2026-04-04T15:30:00Z")) / 60000} minutes`);
});

test("a cron time inside the spring-forward gap skips that day", () => {
  // nextCronOccurrence walks real minutes and matches the local clock, so a
  // 2:30 AM cron simply has no match on 2026-03-08 and lands on the 9th. The
  // trigger path (nextTimesOnDays) shifts the same time to 3:30 instead — the
  // two are deliberately different, and this pins which is which.
  assert.equal(
    routines.nextCronOccurrence(at("2026-03-07T20:00:00Z"), "30 2 * * *", NEW_YORK),
    at("2026-03-09T06:30:00Z"),
  );
});

test("an impossible cron returns null, it does not throw or hang", () => {
  // "0 0 30 2 *" — every Feb 30 — parses, so the UI accepts it and the routine
  // is stored, but it can never match. The scheduler needs null: no throw, no
  // hang. ("0 0 29 2 *" used to belong here too; it resolves now, see below.)
  assert.ok(routines.parseCron("0 0 30 2 *"));
  const started = Date.now();
  const next = routines.nextCronOccurrence(at("2026-03-01T00:00:00Z"), "0 0 30 2 *", NEW_YORK);
  const elapsed = Date.now() - started;
  assert.equal(next, null);
  // The bound is a smoke alarm, not a benchmark, but it is now tight enough to
  // catch a regression back to minute-walking. A full no-match scan rejects
  // four years of DAYS by arithmetic instead of testing 527,040 minutes:
  // ~190s before the formatter cache, ~1.5s after it, 0.65ms warm now. Every
  // shape got cheaper, not just this one (avg of 20, warm, America/New_York):
  //   "*/5 * * * *" 0.16ms -> 0.08ms   "0 9 * * 1"  31ms -> 0.13ms
  //   "0 0 31 * *"    20ms -> 0.07ms   "0 0 29 2 *" ~1.5s -> 0.36ms
  assert.ok(elapsed < 1_000, `full-window cron scan took ${elapsed}ms`);
});

// "0 0 29 2 *" is the ordinary way to write "every leap day". It used to
// resolve to null in three years out of four — the search window was 366 days —
// so the routine silently never fired, and each attempt burned ~1.5s of blocked
// event loop inside tickRoutines (every 15s, every bot). nextCronOccurrence now
// walks days instead of minutes, so a four-year window is affordable.
test("a leap-day cron finds the next Feb 29", () => {
  assert.equal(
    routines.nextCronOccurrence(at("2026-03-01T00:00:00Z"), "0 0 29 2 *", NEW_YORK),
    at("2028-02-29T05:00:00Z"),
  );
});
