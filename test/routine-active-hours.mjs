/**
 * Routine active hours, server side.
 *
 * 1. upsert_routine takes active_hours {start, end, tz, days?}, keeps it when
 *    omitted, clears it with null or clear_active_hours, and refuses a bad one
 *    with its own error. list_routines shows it and the next run.
 * 2. tickRoutines (the only path that starts a routine turn on its own) holds
 *    an out-of-window fire before asking dueRoutines, so no turn starts; the
 *    restore-from-desk reader keeps activeHours; Test run is documented as
 *    ignoring the window. The window math and the scheduler walk itself are
 *    in packages/automations/test/active-hours.test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-routine-hours-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;
const botId = "00000000-0000-4000-8000-0000000000c1";
process.env.SUB8BOT_BOT_ID = botId;

const store = await import("@sub8/store");
const { callTool, TOOLS } = await import("../server/mcp-sub8.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIEF = "Check the X inbox every 30 minutes, reply to anything that needs an answer, and log one line per pass.";

await store.writeJsonAtomic(store.botsPath, [
  {
    id: botId,
    name: "Personal",
    messages: [],
    routines: [{ id: "loop", name: "Inbox loop", groupKey: "general", instruction: BRIEF, enabled: true, intervalMs: 30 * 60_000, lastRunAt: 0, createdAt: 1 }],
  },
]);
const loopOf = async () => (await store.getBot(botId)).routines.find((r) => r.id === "loop");

/* --- 1. the tool schema and round trip --- */
{
  const schema = TOOLS.find((t) => t.name === "upsert_routine").inputSchema.properties;
  assert.equal(schema.active_hours.type, "object");
  assert.deepEqual(Object.keys(schema.active_hours.properties).sort(), ["days", "end", "start", "tz"]);
  assert.deepEqual(schema.active_hours.properties.days.items.enum, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(schema.clear_active_hours.type, "boolean");

  const set = await callTool("upsert_routine", {
    id: "loop",
    instruction: BRIEF,
    active_hours: { start: "8:00", end: "20:00", tz: "America/New_York", days: ["Fri", "mon"] },
  });
  assert.equal(set.isError, undefined, set.content[0].text);
  assert.match(set.content[0].text, /active 08:00-20:00 America\/New_York, mon fri only/);
  assert.deepEqual((await loopOf()).activeHours, { start: "08:00", end: "20:00", tz: "America/New_York", days: ["mon", "fri"] });

  // Omitted: kept.
  const kept = await callTool("upsert_routine", { id: "loop", instruction: BRIEF, interval_minutes: 30 });
  assert.equal(kept.isError, undefined, kept.content[0].text);
  assert.equal((await loopOf()).activeHours.start, "08:00");

  const listed = JSON.parse((await callTool("list_routines", {})).content[0].text);
  assert.deepEqual(listed[0].activeHours, { start: "08:00", end: "20:00", tz: "America/New_York", days: ["mon", "fri"] });
  assert.ok(typeof listed[0].nextRun === "string" && !Number.isNaN(Date.parse(listed[0].nextRun)), "list_routines shows the next run");

  // Bad window: its own error, nothing written.
  const bad = await callTool("upsert_routine", { id: "loop", instruction: BRIEF, active_hours: { start: "08:00", end: "20:00", tz: "Nowhere/Land" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /active_hours not set: .*not a time zone/);
  assert.equal((await loopOf()).activeHours.tz, "America/New_York");

  // tz defaults to the user's zone.
  const noTz = await callTool("upsert_routine", { id: "loop", instruction: BRIEF, active_hours: { start: "22:00", end: "06:00" } });
  assert.equal(noTz.isError, undefined, noTz.content[0].text);
  const stored = (await loopOf()).activeHours;
  assert.equal(stored.start, "22:00");
  assert.ok(stored.tz, "a zone was filled in");
  assert.equal(stored.days, undefined);

  // null clears; so does clear_active_hours.
  await callTool("upsert_routine", { id: "loop", instruction: BRIEF, active_hours: null });
  assert.equal("activeHours" in (await loopOf()), false);
  await callTool("upsert_routine", { id: "loop", instruction: BRIEF, active_hours: { start: "09:00", end: "17:00", tz: "UTC" } });
  assert.equal((await loopOf()).activeHours.tz, "UTC");
  await callTool("upsert_routine", { id: "loop", instruction: BRIEF, clear_active_hours: true });
  assert.equal("activeHours" in (await loopOf()), false);
}

/* --- 2. the scheduler, the desk reader and Test run --- */
{
  const indexSrc = readFileSync(path.join(here, "..", "server", "index.mts"), "utf8");
  const tick = indexSrc.slice(indexSrc.indexOf("async function tickRoutines"), indexSrc.indexOf("async function postSpendNudge"));
  assert.ok(tick.length > 1000, "found tickRoutines");
  assert.equal((tick.match(/routines\.holdOutsideActiveHours\(/g) || []).length, 2, "both the scan and the locked patch hold out-of-window fires");
  // Every turn the tick starts comes after dueRoutines, which refuses a routine outside its window.
  const firstEnqueue = tick.indexOf("enqueueTurn(");
  assert.ok(firstEnqueue > tick.indexOf("routines.dueRoutines("), "dueRoutines gates the turn");
  assert.equal((tick.match(/enqueueTurn\(/g) || []).length, 1, "one turn start in the tick");
  // Only the tick and Test run start routine turns.
  assert.equal((indexSrc.match(/origin: "routine"/g) || []).length, 2, "routine turns start only in tickRoutines and Test run");
  assert.match(indexSrc, /"Test run": an explicit user action, so it runs now even outside the\s+\* routine's active hours/);

  const restore = indexSrc.slice(indexSrc.indexOf("async function restoreDeskAutomations"));
  assert.match(restore.slice(0, 4000), /routines\.normalizeActiveHours\(auto\.activeHours\)/, "restore-from-desk reads activeHours back");
  assert.match(restore.slice(0, 4000), /activeHours: r\.activeHours/, "and writes it onto the restored row");

  // Interrupted routine turns are never retried by themselves.
  const interrupted = readFileSync(path.join(here, "..", "server", "interrupted.mts"), "utf8");
  assert.match(interrupted, /Only "user" turns are ever retried automatically/);
}

await fs.rm(tmp, { recursive: true, force: true });
console.log("routine-active-hours ok");
