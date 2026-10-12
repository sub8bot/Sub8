import test from "node:test";
import assert from "node:assert/strict";
import * as routines from "../dist/index.js";
import {
  looksLikeSchedule, upsertRoutine } from "../dist/index.js";

const NEW_YORK = "America/New_York";
const at = (iso) => Date.parse(iso);
const NOW = at("2026-01-15T12:00:00Z");

const standing = (subject) => `Watch ${subject} every 15 minutes and summarize anything new.`;

function seed(spec = {}) {
  const bot = { routines: [] };
  const created = upsertRoutine(bot, {
    name: "Email",
    instruction: standing("the inbox"),
    intervalMs: 15 * 60_000,
    groupKey: "email",
    ...spec,
  });
  return { bot, routine: created.routine, created };
}

// ---------------------------------------------------------------------------
// Upsert identity. Every one of these is a way the operator ends up with the
// wrong number of routines.
// ---------------------------------------------------------------------------

test("upserting the same id updates in place and never duplicates", () => {
  const { bot, routine } = seed();
  const before = routine.createdAt;
  const updated = upsertRoutine(bot, {
    id: routine.id,
    instruction: `${standing("the inbox")} Then flag anything from the bank.`,
    forceReplace: true,
  });
  assert.equal(updated.merged, true);
  assert.equal(updated.routine.id, routine.id);
  assert.equal(bot.routines.length, 1);
  assert.equal(updated.routine.createdAt, before, "an update must not reset createdAt");
  assert.match(updated.routine.instruction, /flag anything from the bank/);
});

test("an id that is not on this bot is refused, it does not create a routine", () => {
  const { bot } = seed();
  const result = upsertRoutine(bot, { id: "not-a-real-id", instruction: standing("flights") });
  assert.equal(result.routine, null);
  assert.equal(result.merged, false);
  assert.equal(result.rejected, "routine not found");
  assert.equal(bot.routines.length, 1, "a stale id from another bot must not fork a second job");
});

test("a second upsert with no id replaces the standing job rather than adding one", () => {
  // This is the default contract: one standing job per bot. A model that calls
  // upsert_routine for a *different* job without passing force_new overwrites
  // the first one — the operator sees the new routine and the old one is gone.
  const { bot, routine } = seed();
  const second = upsertRoutine(bot, {
    name: "Flights",
    instruction: standing("flight prices"),
    intervalMs: 2 * 3600_000,
    groupKey: "flights",
  });
  assert.equal(second.merged, true);
  assert.equal(second.routine.id, routine.id, "same row, renamed");
  assert.equal(bot.routines.length, 1);
  assert.equal(bot.routines[0].name, "Flights");
  assert.equal(bot.routines[0].groupKey, "flights");
});

test("force_new plus solo:false is what actually produces a second routine", () => {
  const { bot, routine } = seed();
  const second = upsertRoutine(bot, {
    name: "Flights",
    instruction: "Watch flight prices every 6 hours and report any drop.",
    intervalMs: 6 * 3600_000,
    groupKey: "flights",
    forceNew: true,
    solo: false,
  });
  assert.equal(second.rejected, undefined);
  assert.equal(bot.routines.length, 2);
  assert.deepEqual(bot.routines.map((r) => r.name), ["Email", "Flights"]);
  assert.notEqual(second.routine.id, routine.id);
});

test("force_new without solo:false still collapses back to one routine", () => {
  // solo defaults to true and runs on the *merge* path, so a force_new that is
  // rejected as an overlap and then retried plainly leaves one row, not two.
  const { bot } = seed();
  upsertRoutine(bot, {
    name: "Flights",
    instruction: "Watch flight prices every 6 hours and report any drop.",
    intervalMs: 6 * 3600_000,
    groupKey: "flights",
    forceNew: true,
    solo: false,
  });
  assert.equal(bot.routines.length, 2);
  upsertRoutine(bot, { name: "Everything", instruction: standing("everything"), intervalMs: 15 * 60_000 });
  assert.equal(bot.routines.length, 1, "solo:true prunes every other routine on merge");
});

test("near-duplicate intervals are refused at 2.5x and allowed just past it", () => {
  // similarInterval is the guard against "check email every 20 min" and "check
  // email every 25 min" both existing. The ratio boundary is 2.5 inclusive.
  const second = (aMin, bMin) => {
    const bot = { routines: [] };
    upsertRoutine(bot, { name: "A", instruction: standing("the inbox"), intervalMs: aMin * 60_000, groupKey: "email" });
    const res = upsertRoutine(bot, {
      name: "B",
      instruction: "Watch flight prices and report any drop.",
      intervalMs: bMin * 60_000,
      groupKey: "flights",
      forceNew: true,
      solo: false,
    });
    return { rejected: res.rejected, rows: bot.routines.length };
  };
  assert.match(second(20, 30).rejected, /overlaps/);
  assert.match(second(20, 50).rejected, /overlaps/, "exactly 2.5x still counts as overlapping");
  assert.equal(second(20, 51).rejected, undefined);
  assert.equal(second(20, 51).rows, 2);
});

test("two calendar routines at the same hour overlap, an interval one alongside does not", () => {
  const bot = { routines: [] };
  upsertRoutine(bot, { name: "M1", instruction: "watch the inbox every morning", now: NOW, timeZone: NEW_YORK });
  const sameHour = upsertRoutine(bot, {
    name: "M2",
    instruction: "watch the calendar every morning",
    now: NOW,
    timeZone: NEW_YORK,
    forceNew: true,
    solo: false,
  });
  assert.match(sameHour.rejected, /overlaps/);
  assert.equal(bot.routines.length, 1);

  // A calendar routine and an elapsed-interval routine never compare as
  // overlapping, so this pair coexists even in the same group. That is how a
  // bot ends up with "Email 9 AM" and "Email every 20 min" side by side.
  const poll = upsertRoutine(bot, {
    name: "Poll",
    instruction: standing("the inbox"),
    intervalMs: 20 * 60_000,
    groupKey: "email",
    forceNew: true,
    solo: false,
  });
  assert.equal(poll.rejected, undefined);
  assert.equal(bot.routines.length, 2);
});

// ---------------------------------------------------------------------------
// Stop. disable_routine sets enabled:false; nothing else must be able to undo
// that by accident, and nothing must fire while it is off.
// ---------------------------------------------------------------------------

test("a disabled routine is never due, however far behind it is", () => {
  const { bot, routine } = seed();
  routine.lastRunAt = 0;
  routine.enabled = false;
  assert.equal(routines.dueRoutines(bot, NOW).length, 0);
  assert.equal(routines.dueRoutines(bot, NOW + 365 * 86400_000).length, 0);

  const cal = {
    id: "c1",
    schedule: { type: "daily", hour: 9, minute: 0 },
    nextRunAt: at("2026-01-08T14:00:00Z"),
    lastRunAt: at("2026-01-08T14:00:00Z"),
    enabled: false,
  };
  assert.equal(
    routines.dueRoutines({ routines: [cal] }, at("2026-01-15T15:00:00Z"), { timeZone: NEW_YORK }).length,
    0,
    "a week of missed mornings must not resurrect a paused routine",
  );
});

test("a disabled routine is hidden from the standing-routines prompt block", () => {
  const { bot, routine } = seed();
  assert.match(routines.promptBlock(bot), /\[email\] Email/);
  routine.enabled = false;
  assert.equal(routines.promptBlock(bot), "", "a paused routine must not read as still running");
});

test("upsert with enabled:false stops a routine and upsert with enabled:true resumes it", () => {
  const { bot, routine } = seed();
  routine.lastRunAt = 0;
  const off = upsertRoutine(bot, { id: routine.id, enabled: false });
  assert.equal(off.routine.enabled, false);
  assert.equal(routines.dueRoutines(bot, NOW).length, 0);

  const on = upsertRoutine(bot, { id: routine.id, enabled: true });
  assert.equal(on.routine.enabled, true);
  assert.equal(routines.dueRoutines(bot, NOW).length, 1);
});

test("re-enabling catches up exactly one run, it does not backfill the missed ones", () => {
  const routine = {
    id: "c1",
    schedule: { type: "daily", hour: 9, minute: 0 },
    nextRunAt: at("2026-01-08T14:00:00Z"),
    lastRunAt: at("2026-01-08T14:00:00Z"),
    enabled: true,
  };
  const bot = { routines: [routine] };
  const tenAm = at("2026-01-15T15:00:00Z");
  // Seven mornings were missed. The routine is due once, for *today's* 9 AM.
  assert.equal(routines.calendarNextRunAt(routine, tenAm, NEW_YORK), at("2026-01-15T14:00:00Z"));
  assert.equal(routines.dueRoutines(bot, tenAm, { timeZone: NEW_YORK }).length, 1);
  routines.advanceCalendarRoutine(routine, tenAm, NEW_YORK);
  assert.equal(routine.nextRunAt, at("2026-01-16T14:00:00Z"));
  assert.equal(routines.dueRoutines(bot, tenAm, { timeZone: NEW_YORK }).length, 0);
});

// HAZARD, pinned as-is: an upsert that says nothing about `enabled` silently
// turns a paused routine back on (applyRoutineUpsert: `existing.enabled ===
// false && !spec.forceNew` → true). disable_routine followed by any ordinary
// upsert_routine call therefore resumes the job the operator just stopped.
test("an upsert that does not mention enabled silently resumes a paused routine", () => {
  const { bot, routine } = seed();
  routine.lastRunAt = 0;
  routine.enabled = false;
  const edit = upsertRoutine(bot, {
    id: routine.id,
    instruction: `${standing("the inbox")} Also check the spam folder.`,
    forceReplace: true,
  });
  assert.equal(edit.routine.enabled, true);
  assert.equal(routines.dueRoutines(bot, NOW).length, 1);
});

// ---------------------------------------------------------------------------
// Round trip. "Created but I cannot see it" is a routine that upsert wrote and
// something downstream could not read back.
// ---------------------------------------------------------------------------

test("a calendar routine survives a bots.json round trip with every field intact", () => {
  const bot = { routines: [] };
  const { routine } = upsertRoutine(bot, {
    name: "Morning digest",
    instruction: "Watch the inbox every morning and summarize overnight mail.",
    groupKey: "email",
    now: NOW,
    timeZone: NEW_YORK,
  });
  assert.deepEqual(Object.keys(routine), [
    "id",
    "name",
    "groupKey",
    "instruction",
    "enabled",
    "lastRunAt",
    "createdAt",
    "updatedAt",
    "schedule",
    "nextRunAt",
    "nextRunTimeZone",
  ]);
  const reloaded = JSON.parse(JSON.stringify(bot));
  assert.deepEqual(reloaded.routines[0], routine, "nothing is lost or coerced by JSON");
  // cadenceLabel routes through triggersOf, which synthesizes a daily trigger
  // and drops the zone suffix scheduleLabel would have added.
  assert.equal(routines.cadenceLabel(reloaded.routines[0], NEW_YORK), "Every day at 9:00 AM");
  assert.match(routines.promptBlock(reloaded), /\[email\] Morning digest every day at 9:00 am/);
  assert.equal(routines.dueRoutines(reloaded, routine.nextRunAt, { timeZone: NEW_YORK }).length, 1);
});

test("a trigger routine keeps its trigger ids across a round trip and across an edit", () => {
  // The schedule chips in the UI edit a trigger by id. A re-stamped id would
  // show the routine but make every chip un-editable.
  const bot = { routines: [] };
  const { routine } = upsertRoutine(bot, {
    name: "Digest",
    instruction: "Watch the inbox and send a digest at 8 and at 5.",
    triggers: [{ kind: "daily", times: [{ hour: 8, minute: 0 }, { hour: 17, minute: 0 }] }],
    now: NOW,
    timeZone: NEW_YORK,
  });
  const triggerId = routine.triggers[0].id;
  assert.ok(triggerId);

  const reloaded = JSON.parse(JSON.stringify(bot));
  assert.deepEqual(reloaded.routines[0], routine);
  assert.equal(reloaded.routines[0].triggers[0].id, triggerId);
  assert.equal(routines.cadenceLabel(reloaded.routines[0], NEW_YORK), "Every day at 8:00 AM, 5:00 PM");

  // The save path posts the whole trigger list back, ids included. Those ids
  // have to be honoured, not replaced with fresh ones on every save.
  const edited = upsertRoutine(bot, {
    id: routine.id,
    triggers: [{ id: triggerId, kind: "daily", times: [{ hour: 8, minute: 0 }, { hour: 18, minute: 0 }] }],
    now: NOW,
    timeZone: NEW_YORK,
  });
  assert.equal(edited.routine.triggers.length, 1);
  assert.equal(edited.routine.triggers[0].id, triggerId);
  assert.equal(routines.cadenceLabel(edited.routine, NEW_YORK), "Every day at 8:00 AM, 6:00 PM");

  // A trigger arriving with no id gets one, so a new chip is addressable too.
  const added = upsertRoutine(bot, {
    id: routine.id,
    triggers: [{ id: triggerId, kind: "daily", times: [{ hour: 8, minute: 0 }] }, { kind: "hourly" }],
    now: NOW,
    timeZone: NEW_YORK,
  });
  assert.equal(added.routine.triggers[0].id, triggerId);
  assert.ok(added.routine.triggers[1].id);
  assert.notEqual(added.routine.triggers[1].id, triggerId);
});

test("a routine written by upsert is readable by the on-disk automation contract", () => {
  const { routine } = seed({ name: "Inbox" });
  const json = routines.automationJson(routine);
  assert.deepEqual(Object.keys(json), ["name", "prompt", "schedule", "enabled", "createdAt", "lastRunAt"]);
  assert.equal(json.schedule, "@every 15m");
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json);

  const single = routines.automationJson({
    name: "Morning",
    instruction: "watch the inbox every morning",
    triggers: [{ kind: "daily", times: [{ hour: 9, minute: 0 }] }],
    enabled: true,
    createdAt: 1,
    lastRunAt: 0,
  });
  assert.equal(single.schedule, "0 9 * * *");

  // A multi-time trigger has no single cron, so automationSchedule falls back
  // to the human label. The desk gets prose here, not a parseable expression.
  const multi = routines.automationJson({
    name: "Digest",
    instruction: "twice a day",
    triggers: [{ kind: "daily", times: [{ hour: 8, minute: 0 }, { hour: 17, minute: 0 }] }],
    enabled: true,
    createdAt: 1,
    lastRunAt: 0,
  });
  assert.equal(multi.schedule, "Every day at 8:00 AM, 5:00 PM");
});

test("persistRoutineAutomation writes nothing when the bot has no desk", async () => {
  const { routine } = seed();
  const writes = [];
  const writer = {
    mkdirpInContainer: (c, d) => writes.push(["mkdir", c, d]),
    writeFileToContainer: (c, dest, body) => writes.push(["write", c, dest, body]),
  };
  assert.equal(await routines.persistRoutineAutomation({ id: "b1" }, routine, writer), null);
  assert.equal(await routines.persistRoutineAutomation({ id: "b1", vm: { container: "c1", status: "missing" } }, routine, writer), null);
  // A cloud desk (deskUrl) owns its own automations; the host must not write.
  assert.equal(await routines.persistRoutineAutomation({ id: "b1", vm: { container: "c1", deskUrl: "https://d" } }, routine, writer), null);
  assert.equal(writes.length, 0);

  const dest = await routines.persistRoutineAutomation({ id: "b1", vm: { container: "c1" } }, routine, writer);
  assert.equal(dest, "/config/agent-data/agents/b1/automations/email/automation.json");
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[1][3]), routines.automationJson(routine));
});

test("a bot with no routines array gets one, and a missing bot throws", () => {
  // Rows written by older builds have no `routines` key at all.
  const bot = {};
  const { routine } = upsertRoutine(bot, { name: "Email", instruction: standing("the inbox"), intervalMs: 15 * 60_000 });
  assert.equal(bot.routines.length, 1);
  assert.equal(bot.routines[0].id, routine.id);
  assert.throws(() => upsertRoutine(null, { instruction: standing("the inbox") }), /bot missing/);
});

// looksLikeSchedule used to refuse any brief with a question word *after* the
// cadence, to catch "Every morning, what should I check". That also refused the
// five ordinary briefs below: upsertRoutine returned { routine: null, rejected }
// even with an explicit interval_minutes, so the operator was told the job was
// set up while bot.routines stayed empty — a routine that "was created" and
// never appeared.
//
// Narrowed to the interrogative shape (question word, then a modal or auxiliary,
// then a pronoun), which is what "what should I check" has and what "summarize
// what is new" does not. The question forms the suite pins are all still
// refused; see the negative cases in the next test.
test("an ordinary standing brief that mentions what or which is accepted", () => {
  for (const text of [
    "Watch the inbox every 15 minutes and summarize what is new.",
    "Check x.com every 30 minutes and tell me what changed.",
    "Every hour, check the build and report which tests failed.",
    "Check the inbox hourly and note who replied.",
    "Watch flights daily and say when the price drops.",
  ]) {
    const bot = { routines: [] };
    const result = upsertRoutine(bot, { instruction: text, intervalMs: 15 * 60_000 });
    assert.ok(result.routine, `refused: ${text}`);
    assert.equal(bot.routines.length, 1);
  }
});

// The other half of that narrowing: a real question must still be refused, or
// "Every morning, what should I check" becomes a standing job. Asserted on
// looksLikeSchedule itself, which is the function that was narrowed —
// upsertRoutine does not gate solely on it (see the note below), so going
// through it would test something else.
test("a cadence followed by an actual question is still refused", () => {
  for (const text of [
    "Every morning, what should I check",
    "Every day, what do you think I should read",
    "Each week, which of these should we drop",
    "Every hour, how do I know it worked",
    "Every night, when should we run it",
  ]) {
    assert.equal(looksLikeSchedule(text), false, `accepted a question: ${text}`);
  }
});

// NOTE, found while pinning the above and NOT changed: upsertRoutine does not
// gate solely on looksLikeSchedule. "Each week, which of these should we drop"
// is refused by looksLikeSchedule and still yields a routine. That is
// pre-existing — looksLikeSchedule returns false for it both before and after
// the narrowing — but it means a caller cannot rely on the guard alone.
test("KNOWN: a refused brief can still produce a routine through upsert", () => {
  const bot = { routines: [] };
  const result = upsertRoutine(bot, {
    instruction: "Each week, which of these should we drop",
    intervalMs: 15 * 60_000,
  });
  assert.equal(looksLikeSchedule("Each week, which of these should we drop"), false);
  assert.ok(result.routine, "documenting current behaviour, not endorsing it");
});

// DEFECT: the "refused casual rewrite" guard in applyRoutineUpsert returns
// early, before schedule / triggers / intervalMs / name / groupKey are applied.
// So an upsert that carries a *cadence change* alongside any short or
// cadence-free instruction keeps the old cadence and reports
// "kept standing brief" — a message about the brief, for a change that was not
// to the brief. The escape hatch, force_replace, then overwrites the standing
// brief with that same short text, so there is no call shape that changes only
// the schedule. The guard has to stop rewriting the instruction while still
// applying the rest of the spec; that is a restructure of the merge branch,
// not a one-liner.
test("an upsert that changes only the cadence applies it and keeps the brief", () => {
  const brief = "Watch the inbox and send a digest of anything that arrived overnight, twice a day, at 8 and at 5.";
  const build = () => {
    const bot = { routines: [] };
    const { routine } = upsertRoutine(bot, {
      name: "Digest",
      instruction: brief,
      triggers: [{ kind: "daily", times: [{ hour: 8, minute: 0 }, { hour: 17, minute: 0 }] }],
      now: NOW,
      timeZone: NEW_YORK,
    });
    return { bot, routine };
  };

  // Renaming and re-timing at once: both must land.
  const renamed = build();
  const afterRename = upsertRoutine(renamed.bot, {
    id: renamed.routine.id,
    name: "Digest v2",
    triggers: [{ id: renamed.routine.triggers[0].id, kind: "daily", times: [{ hour: 8, minute: 0 }, { hour: 18, minute: 0 }] }],
    now: NOW,
    timeZone: NEW_YORK,
  });
  assert.equal(afterRename.routine.name, "Digest v2");
  assert.equal(afterRename.routine.instruction, brief, "the standing brief is untouched");
  assert.equal(routines.cadenceLabel(afterRename.routine, NEW_YORK), "Every day at 8:00 AM, 6:00 PM");

  // Re-sending the identical brief with a new interval: the interval must land.
  const retimed = build();
  const afterInterval = upsertRoutine(retimed.bot, { id: retimed.routine.id, instruction: brief, intervalMs: 3600_000 });
  assert.equal(afterInterval.routine.instruction, brief);
  assert.equal(afterInterval.routine.intervalMs, 3600_000);
});

// ---------------------------------------------------------------------------
// A chat message is never a standing brief. Replays the 2026-10-12 incident:
// a long "new standing orders" message (it mentioned an old routine as
// "hourly") went through the chat schedule capture, which called
// upsertRoutine with the whole message as the instruction. That replaced the
// X loop's brief with the message text, reset its 30-minute cadence to hourly
// and, through the solo default, dropped every other routine.
// ---------------------------------------------------------------------------

const LOOP_BRIEF = [
  "X ENGAGEMENT LOOP for the owner. Run silently.",
  "1) NOTIFICATIONS. Like every new reply on the owner's posts that is not already liked.",
  "2) TIMELINE. Like 8-10 posts in lane per pass, cap 12.",
  "3) BOOKMARKS. Bookmark 1-3 posts per pass.",
  "4) LOG. Append one line to the monthly log.",
].join("\n");

const ORDERS = [
  "New standing orders. Save them to profile.md, update your routines, then reply with a short confirmation.",
  "",
  "1. CREATE ONE PERSISTENT TEAMMATE named \"Poster\". Keep it alive; do not delete it after a task.",
  "2. NO LONG SLEEPS. Never run a shell sleep longer than 20 seconds.",
  "3. DMs, every pass. Open x.com/messages, including message requests, and draft replies.",
  "4. DISABLE the old \"General\" routine (hourly, never ran). The X engagement loop is the only routine.",
  "5. DIGEST. At most 3 times a day, and only when something needs the owner, send one short message here.",
].join("\n");

function loopBot() {
  return {
    routines: [
      { id: "loop", name: "X engagement loop", groupKey: "general", instruction: LOOP_BRIEF, enabled: true, intervalMs: 30 * 60_000, lastRunAt: 1, createdAt: 1 },
      { id: "other", name: "Inbox", groupKey: "email", instruction: standing("the inbox"), enabled: true, intervalMs: 15 * 60_000, lastRunAt: 1, createdAt: 1 },
    ],
  };
}

test("the incident message reads as a schedule, so the old capture path would have taken it", () => {
  // Pins the premise: without captureChatSchedule's guard this text reaches upsertRoutine.
  assert.equal(looksLikeSchedule(ORDERS), true);
  const bot = loopBot();
  const p = routines.parseSchedule(ORDERS);
  upsertRoutine(bot, { instruction: ORDERS, intervalMs: p.intervalMs, schedule: p.schedule });
  assert.equal(bot.routines.length, 1, "old path: solo default dropped the other routine");
  assert.equal(bot.routines[0].instruction, ORDERS, "old path: the brief became the message");
});

test("a long chat message never rewrites an existing routine", () => {
  const bot = loopBot();
  const out = routines.captureChatSchedule(bot, ORDERS);
  assert.equal(out, null);
  assert.equal(bot.routines.length, 2);
  assert.equal(bot.routines[0].instruction, LOOP_BRIEF);
  assert.equal(bot.routines[0].intervalMs, 30 * 60_000);
  assert.equal(bot.routines[0].instructionHistory, undefined);
});

test("a short cadence line moves only the cadence, never the brief or other rows", () => {
  const bot = loopBot();
  bot.routines[0].enabled = false;
  const out = routines.captureChatSchedule(bot, "check it every 2 hours from now on");
  assert.equal(out?.routine?.id, "loop");
  const loop = bot.routines.find((r) => r.id === "loop");
  assert.equal(loop.instruction, LOOP_BRIEF);
  assert.equal(loop.instructionHistory, undefined);
  assert.equal(loop.intervalMs, 2 * 60 * 60_000);
  assert.equal(loop.enabled, false, "a chat line does not resume a paused routine");
  assert.equal(bot.routines.length, 2, "no solo drop from a chat line");
  assert.equal(bot.routines.find((r) => r.id === "other").instruction, standing("the inbox"));
});

test("with no routine yet, a chat cadence still creates one", () => {
  const bot = { routines: [] };
  const text = "Check the status page every 30 minutes and tell me when anything goes red.";
  const out = routines.captureChatSchedule(bot, text);
  assert.equal(out?.merged, false);
  assert.equal(bot.routines.length, 1);
  assert.equal(bot.routines[0].instruction, text);
  assert.equal(bot.routines[0].intervalMs, 30 * 60_000);
});

test("teammate traffic and questions are never captured", () => {
  const bot = { routines: [] };
  assert.equal(routines.captureChatSchedule(bot, "Poster replies: checked every 30 minutes, all fine"), null);
  assert.equal(routines.captureChatSchedule(bot, "Can you check the inbox every 30 minutes?"), null);
  assert.equal(bot.routines.length, 0);
});

// ---------------------------------------------------------------------------
// Replaced briefs are kept and can be put back.
// ---------------------------------------------------------------------------

test("replacing a brief keeps the old one, and restore puts it back", () => {
  const bot = loopBot();
  const next = `${LOOP_BRIEF}\n5) DMs every pass, draft replies, never send.`;
  upsertRoutine(bot, { id: "loop", instruction: next, forceReplace: true, now: 1000 });
  const loop = bot.routines.find((r) => r.id === "loop");
  assert.equal(loop.instruction, next);
  assert.deepEqual(loop.instructionHistory, [{ instruction: LOOP_BRIEF, replacedAt: 1000 }]);

  const back = routines.restorePreviousInstruction(bot, "loop", 2000);
  assert.equal(back.instruction, LOOP_BRIEF);
  assert.deepEqual(back.instructionHistory, [{ instruction: next, replacedAt: 2000 }], "the restore itself can be undone");
  assert.equal(routines.restorePreviousInstruction(bot, "missing"), null);
  assert.equal(routines.restorePreviousInstruction({ routines: [{ id: "x", instruction: "y" }] }, "x"), null);
});

test("an unchanged brief adds no history and the history is capped", () => {
  const bot = loopBot();
  upsertRoutine(bot, { id: "loop", instruction: LOOP_BRIEF, forceReplace: true });
  assert.equal(bot.routines.find((r) => r.id === "loop").instructionHistory, undefined);
  for (let i = 0; i < routines.INSTRUCTION_HISTORY_MAX + 3; i++) {
    upsertRoutine(bot, { id: "loop", instruction: `${LOOP_BRIEF}\nrevision ${i}`, forceReplace: true });
  }
  const loop = bot.routines.find((r) => r.id === "loop");
  assert.equal(loop.instructionHistory.length, routines.INSTRUCTION_HISTORY_MAX);
  assert.match(loop.instructionHistory.at(-1).instruction, new RegExp(`revision ${routines.INSTRUCTION_HISTORY_MAX + 1}$`));
});

test("appending (replace=false) also records the earlier brief", () => {
  const bot = loopBot();
  upsertRoutine(bot, { id: "loop", instruction: "6) Archive reply drafts older than six hours every pass.", replace: false, forceReplace: true });
  const loop = bot.routines.find((r) => r.id === "loop");
  assert.ok(loop.instruction.startsWith(LOOP_BRIEF));
  assert.equal(loop.instructionHistory[0].instruction, LOOP_BRIEF);
});

test("listing summarizes history instead of repeating every old brief", () => {
  const bot = loopBot();
  upsertRoutine(bot, { id: "loop", instruction: `${LOOP_BRIEF}\nmore`, forceReplace: true, solo: false, now: Date.parse("2026-10-12T18:12:04Z") });
  const [loop, other] = routines.routinesForListing(bot.routines);
  assert.equal(loop.instructionHistory, undefined);
  assert.deepEqual(loop.previousInstructions, [{ replacedAt: "2026-10-12T18:12:04.000Z", chars: LOOP_BRIEF.length, begins: LOOP_BRIEF.slice(0, 160) }]);
  assert.equal(other.previousInstructions, undefined);
  assert.equal(other.instruction, standing("the inbox"));
});

test("isMirroredAutomationJson accepts both mirror shapes and nothing else", () => {
  assert.equal(routines.isMirroredAutomationJson(routines.automationJson({ id: "a", name: "General", instruction: "x", intervalMs: 3600000 })), true);
  assert.equal(routines.isMirroredAutomationJson({ id: "a", name: "General", cadence: "Every hour", instruction: "x" }), true);
  assert.equal(routines.isMirroredAutomationJson({ name: "Mine", prompt: "x", notes: "hand-written" }), false);
  assert.equal(routines.isMirroredAutomationJson({ prompt: "x" }), false);
  assert.equal(routines.isMirroredAutomationJson({ name: "n" }), false);
  assert.equal(routines.isMirroredAutomationJson([]), false);
  assert.equal(routines.isMirroredAutomationJson(null), false);
});
