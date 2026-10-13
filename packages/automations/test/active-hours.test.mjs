import test from "node:test";
import assert from "node:assert/strict";
import * as routines from "../dist/index.js";

const NY = "America/New_York";
const at = (iso) => Date.parse(iso);
const hours = (extra = {}) => ({ start: "08:00", end: "20:00", tz: NY, ...extra });

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("parseActiveHours validates and normalizes", () => {
  const ok = (raw, opts) => {
    const r = routines.parseActiveHours(raw, opts);
    assert.equal(r.ok, true, r.error);
    return r.value;
  };
  const bad = (raw, re, opts) => {
    const r = routines.parseActiveHours(raw, opts);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (re) assert.match(r.error, re);
  };
  assert.deepEqual(ok({ start: "08:00", end: "20:00", tz: NY }), { start: "08:00", end: "20:00", tz: NY });
  assert.deepEqual(ok({ start: "8:00", end: "20:05", tz: NY }), { start: "08:00", end: "20:05", tz: NY });
  assert.equal(ok(null), null);
  assert.equal(ok(undefined), null);
  // tz falls back to the caller's zone, and is required without one.
  assert.equal(ok({ start: "08:00", end: "20:00" }, { defaultTimeZone: "Europe/London" }).tz, "Europe/London");
  bad({ start: "08:00", end: "20:00" }, /tz is required/);
  bad({ start: "08:00", end: "20:00", tz: "Mars/Olympus" }, /not a time zone/);
  bad({ start: "24:00", end: "20:00", tz: NY }, /start/);
  bad({ start: "08:60", end: "20:00", tz: NY }, /start/);
  bad({ start: "08:00", end: "8pm", tz: NY }, /end/);
  bad("08:00-20:00", /object/);
  bad([], /object/);
  // days: lowercase three-letter names, week order, de-duplicated.
  assert.deepEqual(ok(hours({ days: ["FRI", "mon", "mon"] })).days, ["mon", "fri"]);
  bad(hours({ days: ["funday"] }), /funday/);
  bad(hours({ days: [] }), /empty/);
  bad(hours({ days: "mon" }), /list/);
  // All seven is the same as every day.
  assert.equal(ok(hours({ days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] })).days, undefined);
  // start == end is accepted: the whole day.
  assert.deepEqual(ok({ start: "06:00", end: "06:00", tz: NY }), { start: "06:00", end: "06:00", tz: NY });
});

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

test("inside and outside a plain daytime window", () => {
  const h = hours();
  // Mon 2026-10-12 is EDT (UTC-4): 08:00 local is 12:00Z.
  assert.equal(routines.inActiveHours(h, at("2026-10-12T11:59:00Z")), false);
  assert.equal(routines.inActiveHours(h, at("2026-10-12T12:00:00Z")), true);
  assert.equal(routines.inActiveHours(h, at("2026-10-12T23:59:00Z")), true);
  assert.equal(routines.inActiveHours(h, at("2026-10-13T00:00:00Z")), false, "end is exclusive");
  assert.equal(routines.nextActiveStart(h, at("2026-10-12T15:00:00Z")), at("2026-10-12T15:00:00Z"), "open now answers now");
  assert.equal(routines.nextActiveStart(h, at("2026-10-13T01:00:00Z")), at("2026-10-13T12:00:00Z"));
  // No window at all is always open.
  assert.equal(routines.inActiveHours(null, at("2026-10-13T03:00:00Z")), true);
});

test("a window that crosses midnight belongs to the day it opened", () => {
  const h = hours({ start: "22:00", end: "06:00", days: ["fri"] });
  // Fri 2026-10-16 23:00 EDT
  assert.equal(routines.inActiveHours(h, at("2026-10-17T03:00:00Z")), true);
  // Sat 05:00: still Friday's window
  assert.equal(routines.inActiveHours(h, at("2026-10-17T09:00:00Z")), true);
  // Sat 06:00: closed
  assert.equal(routines.inActiveHours(h, at("2026-10-17T10:00:00Z")), false);
  // Sat 23:00: Saturday is not a listed day
  assert.equal(routines.inActiveHours(h, at("2026-10-18T03:00:00Z")), false);
  // Fri 05:00 belongs to Thursday's window, which is not listed
  assert.equal(routines.inActiveHours(h, at("2026-10-16T09:00:00Z")), false);
  // Next opening after Saturday morning: the following Friday 22:00 EDT.
  assert.equal(routines.nextActiveStart(h, at("2026-10-17T11:00:00Z")), at("2026-10-24T02:00:00Z"));
});

test("days filter skips to the next listed day", () => {
  const h = hours({ days: ["mon", "tue", "wed", "thu", "fri"] });
  // Sat 2026-10-17 noon
  assert.equal(routines.inActiveHours(h, at("2026-10-17T16:00:00Z")), false);
  assert.equal(routines.nextActiveStart(h, at("2026-10-17T16:00:00Z")), at("2026-10-19T12:00:00Z"));
});

test("start == end is a full day on the listed days", () => {
  const h = hours({ start: "00:00", end: "00:00", days: ["sun"] });
  // Sun 2026-11-01 is the fall-back day: 25 hours, 04:00Z to 05:00Z next day.
  assert.equal(routines.inActiveHours(h, at("2026-11-01T04:00:00Z")), true);
  assert.equal(routines.inActiveHours(h, at("2026-11-02T04:30:00Z")), true, "23:30 EST Sunday");
  assert.equal(routines.inActiveHours(h, at("2026-11-02T05:00:00Z")), false, "midnight Monday");
  assert.equal(routines.inActiveHours(h, at("2026-11-01T03:59:00Z")), false, "Saturday 23:59 EDT");
});

test("DST spring-forward (2026-03-08, America/New_York)", () => {
  const day = hours();
  // Saturday is EST (UTC-5): 08:00 is 13:00Z. Sunday is EDT: 08:00 is 12:00Z.
  assert.equal(routines.nextActiveStart(day, at("2026-03-08T02:00:00Z")), at("2026-03-08T12:00:00Z"));
  assert.equal(routines.inActiveHours(day, at("2026-03-08T11:59:00Z")), false);
  assert.equal(routines.inActiveHours(day, at("2026-03-08T12:00:00Z")), true);
  assert.equal(routines.inActiveHours(day, at("2026-03-09T00:00:00Z")), false, "20:00 EDT closes");

  // A start inside the skipped hour opens when the gap ends (03:00 EDT = 07:00Z).
  const gapStart = hours({ start: "02:30", end: "04:00" });
  assert.equal(routines.inActiveHours(gapStart, at("2026-03-08T06:59:00Z")), false, "01:59 EST");
  assert.equal(routines.inActiveHours(gapStart, at("2026-03-08T07:00:00Z")), true, "03:00 EDT");
  assert.equal(routines.nextActiveStart(gapStart, at("2026-03-08T05:00:00Z")), at("2026-03-08T07:00:00Z"));
  // An end inside the gap closes at the same instant.
  const gapEnd = hours({ start: "22:00", end: "02:30" });
  assert.equal(routines.inActiveHours(gapEnd, at("2026-03-08T06:59:00Z")), true, "01:59 EST, Saturday's window");
  assert.equal(routines.inActiveHours(gapEnd, at("2026-03-08T07:00:00Z")), false, "03:00 EDT");
});

test("DST fall-back (2026-11-01, America/New_York)", () => {
  const day = hours();
  // Saturday 08:00 EDT = 12:00Z; Sunday 08:00 EST = 13:00Z. A fixed offset
  // would call 12:30Z (07:30 EST) open.
  assert.equal(routines.inActiveHours(day, at("2026-10-31T12:00:00Z")), true);
  assert.equal(routines.inActiveHours(day, at("2026-11-01T12:30:00Z")), false);
  assert.equal(routines.nextActiveStart(day, at("2026-11-01T12:30:00Z")), at("2026-11-01T13:00:00Z"));
  assert.equal(routines.inActiveHours(day, at("2026-11-02T00:59:00Z")), true, "19:59 EST");
  assert.equal(routines.inActiveHours(day, at("2026-11-02T01:00:00Z")), false, "20:00 EST");

  // An end inside the repeated hour closes at its first pass and stays closed.
  const early = hours({ start: "00:00", end: "01:30" });
  assert.equal(routines.inActiveHours(early, at("2026-11-01T05:29:00Z")), true, "01:29 EDT");
  assert.equal(routines.inActiveHours(early, at("2026-11-01T05:45:00Z")), false, "01:45 EDT");
  assert.equal(routines.inActiveHours(early, at("2026-11-01T06:15:00Z")), false, "01:15 EST, second pass");
});

// ---------------------------------------------------------------------------
// Next run and holding a due fire
// ---------------------------------------------------------------------------

test("routineNextRunAt moves an out-of-window fire to the next opening", () => {
  const r = {
    id: "r",
    enabled: true,
    activeHours: hours(),
    triggers: [{ id: "t", kind: "interval", intervalMs: 30 * 60_000, lastRunAt: at("2026-10-12T23:50:00Z"), nextRunAt: null }],
  };
  // 19:50 + 30 min = 20:20 EDT, outside: next is Tuesday 08:00 EDT.
  assert.equal(routines.routineNextRunAt(r, at("2026-10-12T23:55:00Z"), NY), at("2026-10-13T12:00:00Z"));
  // Without the window it is the cadence.
  assert.equal(routines.routineNextRunAt({ ...r, activeHours: null }, at("2026-10-12T23:55:00Z"), NY), at("2026-10-13T00:20:00Z"));
  // Inside the window the cadence stands.
  const mid = { ...r, triggers: [{ ...r.triggers[0], lastRunAt: at("2026-10-12T15:00:00Z") }] };
  assert.equal(routines.routineNextRunAt(mid, at("2026-10-12T15:10:00Z"), NY), at("2026-10-12T15:30:00Z"));
});

test("a due clock trigger outside the window is held to the opening, then resumes its cadence", () => {
  const seven = at("2026-10-12T11:00:00Z"); // 07:00 EDT
  const r = {
    id: "r",
    enabled: true,
    activeHours: hours(),
    triggers: [{ id: "t", kind: "daily", times: [{ hour: 7, minute: 0 }], lastRunAt: at("2026-10-11T12:00:00Z"), nextRunAt: seven }],
  };
  const bot = { routines: [r] };
  const now = seven + 10_000;
  assert.equal(routines.dueRoutines(bot, now, { timeZone: NY }).length, 0, "never due outside the window");
  assert.equal(routines.holdOutsideActiveHours(r, now, NY), true);
  assert.equal(r.triggers[0].nextRunAt, at("2026-10-12T12:00:00Z"), "held to 08:00 EDT");
  assert.equal(routines.holdOutsideActiveHours(r, now, NY), false, "holding again changes nothing");
  assert.equal(routines.dueRoutines(bot, at("2026-10-12T11:59:00Z"), { timeZone: NY }).length, 0);
  const eight = at("2026-10-12T12:00:00Z");
  assert.equal(routines.dueRoutines(bot, eight, { timeZone: NY }).length, 1, "fires when the window opens");
  routines.advanceTrigger(r.triggers[0], eight, NY);
  assert.equal(r.triggers[0].nextRunAt, at("2026-10-13T11:00:00Z"), "then the normal cadence: tomorrow 07:00");
});

test("a legacy daily schedule outside the window moves onto a held trigger", () => {
  const ten = at("2026-10-13T02:00:00Z"); // Mon 22:00 EDT
  const r = { id: "r", enabled: true, activeHours: hours(), schedule: { type: "daily", hour: 22, minute: 0 }, nextRunAt: ten, nextRunTimeZone: NY };
  assert.equal(routines.dueRoutines({ routines: [r] }, ten + 5_000, { timeZone: NY }).length, 0);
  assert.equal(routines.holdOutsideActiveHours(r, ten + 5_000, NY), true);
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0].kind, "daily");
  assert.equal(r.triggers[0].nextRunAt, at("2026-10-13T12:00:00Z"));
  assert.equal(routines.dueRoutines({ routines: [r] }, at("2026-10-13T12:00:00Z"), { timeZone: NY }).length, 1);
});

test("rebaseHeldTriggers drops a hold when the window changes", () => {
  const r = {
    id: "r",
    enabled: true,
    triggers: [{ id: "t", kind: "daily", times: [{ hour: 7, minute: 0 }], lastRunAt: at("2026-10-11T11:00:00Z"), nextRunAt: at("2026-10-12T12:00:00Z") }],
  };
  routines.rebaseHeldTriggers(r, at("2026-10-12T11:30:00Z"), NY);
  assert.equal(r.triggers[0].nextRunAt, at("2026-10-12T11:00:00Z"), "back on the cadence (due now)");
});

/**
 * The tick in server/index.mts, reduced to the calls it makes: hydrate, hold,
 * fill a missing nextRunAt, ask dueRoutines, stamp and advance. `runTurn` is
 * the stub standing in for enqueueTurn/runUserTurn.
 */
function tick(bot, now, zone, runTurn) {
  for (const r of bot.routines) {
    routines.hydrateRoutine(r, now, zone);
    routines.holdOutsideActiveHours(r, now, zone);
    for (const t of r.triggers || []) {
      if (!Number.isFinite(t.nextRunAt) || t.nextRunAt <= 0) t.nextRunAt = routines.nextTriggerOccurrence(t, now, zone);
    }
  }
  const due = routines.dueRoutines(bot, now, { timeZone: zone });
  for (const r of due) {
    r.lastRunAt = now;
    for (const t of r.triggers || []) if (routines.triggerDue(t, now, zone)) routines.advanceTrigger(t, now, zone);
    runTurn(r, now);
  }
}

test("scheduler: no turn starts outside the window, across a weekend and a restart backlog", () => {
  const zone = NY;
  const window = hours({ days: ["mon", "tue", "wed", "thu", "fri"] });
  const bot = {
    routines: [
      // Hourly; last ran long ago, as after a restart.
      { id: "hourly", enabled: true, activeHours: window, triggers: [{ id: "a", kind: "interval", intervalMs: 3600_000, lastRunAt: at("2026-10-01T00:00:00Z"), nextRunAt: null }] },
      // Every 5 minutes by cron.
      { id: "cron", enabled: true, activeHours: window, triggers: [{ id: "b", kind: "cron", cron: "*/5 * * * *", lastRunAt: at("2026-10-01T00:00:00Z"), nextRunAt: null }] },
      // Daily at 06:00, before the window opens.
      { id: "early", enabled: true, activeHours: window, triggers: [{ id: "c", kind: "daily", times: [{ hour: 6, minute: 0 }], lastRunAt: at("2026-10-01T00:00:00Z"), nextRunAt: null }] },
    ],
  };
  const fires = [];
  const runTurn = (r, now) => fires.push({ id: r.id, now });
  // Fri 2026-10-16 00:00 EDT through Mon 2026-10-19 12:00 EDT, a tick a minute.
  const from = at("2026-10-16T04:00:00Z");
  const to = at("2026-10-19T16:00:00Z");
  for (let now = from; now <= to; now += 60_000) tick(bot, now, zone, runTurn);

  assert.ok(fires.length > 0);
  for (const f of fires) assert.equal(routines.inActiveHours(window, f.now), true, `${f.id} fired outside the window at ${new Date(f.now).toISOString()}`);
  const of = (id) => fires.filter((f) => f.id === id).map((f) => f.now);
  // The overdue hourly job does not fire at midnight: it waits for 08:00 Friday, then runs hourly.
  assert.equal(of("hourly")[0], at("2026-10-16T12:00:00Z"));
  assert.equal(of("hourly")[1], at("2026-10-16T13:00:00Z"));
  // Friday 08:00..19:00 and Monday 08:00..12:00.
  assert.equal(of("hourly").length, 12 + 5);
  // Nothing on the weekend.
  assert.equal(fires.filter((f) => f.now >= at("2026-10-17T04:00:00Z") && f.now < at("2026-10-19T04:00:00Z")).length, 0);
  // The cron job's first fire is the opening, and its last Friday fire is 19:55.
  assert.equal(of("cron")[0], at("2026-10-16T12:00:00Z"));
  assert.ok(of("cron").includes(at("2026-10-16T23:55:00Z")));
  assert.ok(!of("cron").includes(at("2026-10-17T00:00:00Z")));
  // The 06:00 job is held to 08:00 on each weekday.
  assert.deepEqual(of("early"), [at("2026-10-16T12:00:00Z"), at("2026-10-19T12:00:00Z")]);
});

// ---------------------------------------------------------------------------
// Upsert, listing, mirror
// ---------------------------------------------------------------------------

const BRIEF = "Check the X inbox every 30 minutes and reply to anything that needs an answer, then log what changed.";

test("upsertRoutine sets, keeps, clears and rejects active hours", () => {
  const bot = { id: "b", routines: [] };
  const made = routines.upsertRoutine(bot, { instruction: BRIEF, intervalMs: 30 * 60_000, activeHours: { start: "8:00", end: "20:00" }, timeZone: NY });
  assert.ok(made.routine);
  assert.deepEqual(made.routine.activeHours, { start: "08:00", end: "20:00", tz: NY });
  const id = made.routine.id;
  // Absent: kept.
  routines.upsertRoutine(bot, { id, instruction: BRIEF, intervalMs: 30 * 60_000, timeZone: NY });
  assert.deepEqual(bot.routines[0].activeHours, { start: "08:00", end: "20:00", tz: NY });
  // Changed.
  routines.upsertRoutine(bot, { id, instruction: BRIEF, activeHours: { start: "22:00", end: "06:00", tz: "Europe/London", days: ["sat"] } });
  assert.deepEqual(bot.routines[0].activeHours, { start: "22:00", end: "06:00", tz: "Europe/London", days: ["sat"] });
  // Invalid: refused, the stored one untouched.
  const bad = routines.upsertRoutine(bot, { id, instruction: BRIEF, activeHours: { start: "25:00", end: "06:00", tz: NY } });
  assert.equal(bad.routine, null);
  assert.match(bad.rejected, /start/);
  assert.equal(bot.routines[0].activeHours.start, "22:00");
  // null: cleared.
  routines.upsertRoutine(bot, { id, instruction: BRIEF, activeHours: null });
  assert.equal("activeHours" in bot.routines[0], false);
});

test("routinesForListing shows activeHours and the next run with the window applied", () => {
  const rows = routines.routinesForListing(
    [{ id: "r", enabled: true, activeHours: hours(), intervalMs: 3600_000, lastRunAt: at("2026-10-12T23:30:00Z") }],
    { now: at("2026-10-12T23:45:00Z"), timeZone: NY },
  );
  assert.deepEqual(rows[0].activeHours, hours());
  assert.equal(rows[0].nextRun, "2026-10-13T12:00:00.000Z");
  const paused = routines.routinesForListing([{ id: "p", enabled: false, intervalMs: 3600_000 }]);
  assert.equal(paused[0].nextRun, null);
});

test("desk mirror: automation.json carries activeHours and reads back", () => {
  const routine = {
    id: "r",
    name: "Inbox",
    instruction: BRIEF,
    enabled: true,
    createdAt: 1,
    intervalMs: 30 * 60_000,
    activeHours: hours({ days: ["mon", "fri"] }),
  };
  const json = routines.automationJson(routine);
  assert.deepEqual(json.activeHours, { start: "08:00", end: "20:00", tz: NY, days: ["mon", "fri"] });
  const onDisk = JSON.parse(JSON.stringify(json));
  assert.equal(routines.isMirroredAutomationJson(onDisk), true, "still recognised as a mirror file (pruning)");
  assert.deepEqual(routines.normalizeActiveHours(onDisk.activeHours), routine.activeHours);
  // No window: no key, as before.
  assert.equal("activeHours" in routines.automationJson({ ...routine, activeHours: null }), false);
});

test("persistRoutineAutomation writes activeHours to the desk", async () => {
  const files = new Map();
  const writer = {
    async mkdirpInContainer() {},
    async writeFileToContainer(_c, dest, body) {
      files.set(dest, body);
    },
  };
  const bot = { id: "b1", vm: { container: "c1", status: "running" } };
  const dest = await routines.persistRoutineAutomation(bot, { id: "r", name: "Inbox", instruction: BRIEF, intervalMs: 3600_000, activeHours: hours() }, writer);
  assert.deepEqual(JSON.parse(files.get(dest)).activeHours, hours());
});
