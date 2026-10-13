import { randomUUID } from "node:crypto";

import type {
  ActiveDay,
  ActiveHours,
  InstructionHistoryEntry,
  AdvancedTrigger,
  AutomationJson,
  AutomationWriter,
  DailySchedule,
  DuePack,
  IntervalTrigger,
  MonthlyTrigger,
  ParsedCadence,
  ParsedCron,
  Routine,
  RoutineBot,
  RoutineSpec,
  TimeInput,
  TimeOfDay,
  TimesTrigger,
  Trigger,
  UpsertResult,
  WeeklyTrigger,
  OnceTrigger,
} from "./types.js";

const GROUPS = [
  { key: "x-inbox", label: "X inbox", re: /\b(x\.com|\bx\b|twitter|tweet|notifications?|mentions?|dms?|direct messages?|private messages?)\b/i },
  { key: "email", label: "Email", re: /\b(email|gmail|inbox|mail)\b/i },
  { key: "flights", label: "Flights", re: /\b(flight|airfare|airline)\b/i },
  { key: "calendar", label: "Calendar", re: /\b(calendar|meetings?|schedule)\b/i },
  { key: "files", label: "Files", re: /\b(files?|downloads?|folder)\b/i },
];

export function groupKey(text: string): string {
  const hit = GROUPS.find((g) => g.re.test(text));
  return hit ? hit.key : "general";
}

export function groupLabel(key: string): string {
  return GROUPS.find((g) => g.key === key)?.label || "General";
}

const WEAK_JOB =
  /^(check again|check back|try again|look again|do it again|keep going|resume|continue|ok|okay|so)[\s.!?]*$/i;
const ONE_SHOT_NEAR_START =
  /^[\s\S]{0,60}?\b(?:check\s+back|(?:check|try|look|do|run)(?:\s+(?:it|that|this))?\s+again|resume|keep going)\b/i;
const CLOCK_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const CLOCK_TOKEN = `(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|ish)?|${CLOCK_WORDS}|noon|midnight|half\\s+past\\s+(?:${CLOCK_WORDS}|\\d{1,2}))`;
const MORNING_PHRASE = /\b(?:every|each)\s+morning\b/gi;

const MORNING_SCHEDULE: DailySchedule = Object.freeze({ type: "daily", hour: 9, minute: 0 });

/** Read one property off a value that may not be an object at all. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function morningClockAttached(text: unknown): boolean {
  const t = String(text || "");
  const re = new RegExp(MORNING_PHRASE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const after = t.slice(m.index + m[0].length);
    const before = t.slice(0, m.index);
    if (
      /^\s*,?\s*(?:at|around|by|before|after|until)\b/i.test(after) ||
      /^\s+(?:in|until|before|after)\s+(?:the\s+)?(?:am|pm|noon|midnight)\b/i.test(after) ||
      new RegExp(`^\\s+${CLOCK_TOKEN}\\b`, "i").test(after)
    ) {
      return true;
    }
    if (new RegExp(`(?:at|around|by|before|after|until)\\s+${CLOCK_TOKEN}`, "i").test(before)) return true;
    if (new RegExp(`${CLOCK_TOKEN}\\s*$`, "i").test(before)) return true;
  }
  return false;
}

function blockedMorningInstruction(text: unknown): boolean {
  const t = String(text || "");
  if (!/\b(every|each)\s+morning\b/i.test(t)) return false;
  return morningQuestionOrNegation(t) || morningClockAttached(t);
}

function morningQuestionOrNegation(text: unknown): boolean {
  const t = String(text || "");
  return (
    /[?]\s*$/.test(t) ||
    /^\s*(what|why|when|how|who|which|where)\b/i.test(t) ||
    /\b(?:what|why|when|how|who|which|where)\b.*\b(?:every|each)\s+morning\b/i.test(t) ||
    /\b(?:every|each)\s+morning\b.*\b(?:what|why|when|how|who|which|where)\b/i.test(t) ||
    /\b(?:can|could|would)\s+you\b.*\b(?:every|each)\s+morning\b/i.test(t) ||
    /^\s*(?:do|does|did|is|are|will|should|have|has)\b.*\b(?:every|each)\s+morning\b/i.test(t) ||
    /\b(?:do not|don't|never|no need to)\b.*\b(?:every|each)\s+morning\b/i.test(t)
  );
}

function isOneShotInstruction(text: unknown): boolean {
  const t = String(text || "").trim();
  if (WEAK_JOB.test(t)) return true;
  if (ONE_SHOT_NEAR_START.test(t) && t.length < 220) return true;
  return false;
}

export function isWeakRoutineInstruction(text: unknown): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  if (isOneShotInstruction(t)) return true;
  if (t.length < 20 && !parseSchedule(t)) return true;
  return false;
}

export function isRejectedRoutineInstruction(
  text: unknown,
  { explicitInterval = false }: { explicitInterval?: boolean } = {},
): boolean {
  if (isWeakRoutineInstruction(text)) return true;
  if (looksLikeTeammateTraffic(text)) return true;
  const allowUnsupportedMorningClock =
    explicitInterval && morningClockAttached(String(text || "")) && !morningQuestionOrNegation(text);
  if (blockedMorningInstruction(text) && !allowUnsupportedMorningClock) return true;
  if (cadenceIsBusinessHours(text) && !explicitInterval) return true;
  if (parseSchedule(text) && !looksLikeSchedule(text)) return !allowUnsupportedMorningClock;
  return false;
}

export function parseSchedule(text: unknown): ParsedCadence | null {
  const t = String(text || "").toLowerCase();
  const everyMin = t.match(/every\s+(\d+)\s*(min|mins|minute|minutes)\b/);
  if (everyMin) return { intervalMs: Number(everyMin[1]) * 60_000, label: `Every ${everyMin[1]} minutes` };
  const everyHr = t.match(/every\s+(\d+)\s*(hr|hrs|hour|hours)\b/);
  if (everyHr) return { intervalMs: Number(everyHr[1]) * 3600_000, label: `Every ${everyHr[1]} hours` };
  if (/\bevery\s+hour\b/.test(t) || /\bhourly\b/.test(t)) return { intervalMs: 3600_000, label: "Every hour" };
  if (/\b(daily|every day|each day|once a day)\b/.test(t)) return { intervalMs: 86400_000, label: "Daily" };
  if (/\b(weekly|every week)\b/.test(t)) return { intervalMs: 7 * 86400_000, label: "Weekly" };
  if (/\b(every|each)\s+morning\b/.test(t)) {
    return { schedule: { ...MORNING_SCHEDULE }, label: "Every day at 9:00 AM" };
  }
  return null;
}

export function looksLikeChatLine(text: unknown): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t.length < 220 && !t.includes("\n")) return true;
  if (/^(ok|okay|hey|please|resume|continue|wtf|don't|dont|you should)\b/i.test(t) && t.length < 500) return true;
  return false;
}

export function looksLikeTeammateTraffic(text: unknown): boolean {
  const t = String(text || "").trim();
  if (/^[^\n]{1,80}\s+replies:\s/i.test(t)) return true;
  if (/assigned you this\b/i.test(t) && /YOUR screen/i.test(t)) return true;
  if (/\bteammate report, not a new job\b/i.test(t)) return true;
  return false;
}

function cadenceIsBusinessHours(text: unknown): boolean {
  const t = String(text || "");
  if (/\b(open|opens|closed|hours?)\b[\s\S]{0,80}\b(daily|every day|each day)\b/i.test(t)) return true;
  if (/\b(daily|every day|each day)\b[\s\S]{0,40}\b(\d{1,2}\s*(?:am|pm)|open|hours?)\b/i.test(t) && !/\b(check|watch|run|remind|job|routine)\b/i.test(t)) {
    return true;
  }
  if (/\d{1,2}\s*(?:am|pm)\s*[–—\-to]+\s*\d{1,2}\s*(?:am|pm)\s+(?:daily|every day)\b/i.test(t)) return true;
  return false;
}

export function looksLikeSchedule(text: unknown): boolean {
  const t = String(text || "");
  if (isWeakRoutineInstruction(t)) return false;
  if (looksLikeTeammateTraffic(t)) return false;
  if (cadenceIsBusinessHours(t)) return false;
  if (/[?]\s*$/.test(t)) return false;
  if (/^\s*(what|why|when|how|who|which|where)\b/i.test(t)) return false;
  if (/\b(?:what|why|when|how|who|which|where)\b.*\b(?:every|each|daily|weekly|hourly)\b/i.test(t)) return false;
  if (/^\s*(?:should|can|could|would|do|does|did|is|are|will|have|has)\b.*\b(?:every|each|daily|weekly|hourly)\b/i.test(t)) return false;
  // A cadence followed by a question word is only a QUESTION when the question
  // word heads an interrogative — "Every morning, what should I check". In an
  // ordinary standing brief the same word heads a nominal clause naming what to
  // do with the result: "…and summarize what is new", "…report which tests
  // failed", "…note who replied". Rejecting on the bare word refused all of
  // those outright, leaving bot.routines empty while the tool reported a
  // brief-related error — which is what a routine that "was created but never
  // showed up" looks like. Require the interrogative shape: question word, then
  // a modal or auxiliary, then a pronoun.
  if (
    /\b(?:every|each|daily|weekly|hourly)\b.*\b(?:what|why|when|how|who|which|where)\s+(?:should|shall|can|could|would|will|do|does|did|is|are|was|were|am|have|has|had)\s+(?:i|you|we|they|he|she|it)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/\b(?:i\s+)?wonder\b.*\b(?:whether|if)\b.*\b(?:every|each|daily|weekly|hourly)\b/i.test(t)) return false;
  if (blockedMorningInstruction(t)) return false;
  if (/\b(update|edit|change|rewrite|which|list|have|having)\b.{0,40}\b(routine|cron|schedule)\b/i.test(t)) return false;
  if (/\b(routine details|cronjob|the routine)\b/i.test(t) && !/\bevery\s+\d+\s*(min|hour)/i.test(t)) return false;
  if (/\b(google maps|display :\d|\d\.\d\s*★|reviews?)\b/i.test(t) && t.length > 280) return false;
  if (!parseSchedule(t)) return false;
  return /\b(every|hourly|daily|weekly|each day|once a day|each morning|every morning)\b/i.test(t);
}

function similarInterval(a: number | null | undefined, b: number | null | undefined): boolean {
  const hi = Math.max(a || 0, b || 0);
  const lo = Math.min(a || 0, b || 0);
  if (!hi || !lo) return false;
  return hi / lo <= 2.5;
}

export function normalizeSchedule(value: unknown): DailySchedule | null {
  const row = record(value);
  if (!value || row.type !== "daily") return null;
  const hour = row.hour;
  const minute = row.minute;
  if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { type: "daily", hour, minute };
}

function sameSchedule(a: DailySchedule | null, b: DailySchedule | null): boolean {
  return Boolean(a && b && a.type === b.type && a.hour === b.hour && a.minute === b.minute);
}

function timeZoneOrLocal(timeZone?: string): string {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function asMillis(value: TimeInput): number {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.now();
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * `Intl.DateTimeFormat` is stateless once built but costs ~30µs to construct,
 * and `nextCronOccurrence` walks a minute at a time for up to a year. Keyed by
 * resolved zone; the set of IANA zones is small and fixed.
 */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsFormatters.set(zone, fmt);
  }
  return fmt;
}

function localParts(value: number, timeZone?: string): LocalParts {
  const parts = partsFormatter(timeZoneOrLocal(timeZone)).formatToParts(new Date(value));
  const values = new Map<string, number>();
  for (const part of parts) {
    if (part.type !== "literal") values.set(part.type, Number(part.value));
  }
  const read = (key: string): number => values.get(key) ?? Number.NaN;
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function localDateKey(parts: LocalParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → the three numbers, NaN for a malformed key (as the old `.map(Number)` gave). */
function numbersFromKey(key: string): [number, number, number] {
  const [year, month, day] = key.split("-");
  return [Number(year), Number(month), Number(day)];
}

function dateFromKey(key: string): Date {
  const [year, month, day] = numbersFromKey(key);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function addLocalDays(key: string, days: number): string {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function wallMillis(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
}

/**
 * EVERY instant that maps to this wall time, earliest first.
 *
 * Usually one. On a DST fall-back the wall times in the repeated hour map to
 * TWO instants, and localDateTimeToMillis answers with the earlier -- correct
 * for "when is 01:30 today", wrong for a cron walk. The day-walking
 * nextCronOccurrence generates candidates by WALL time, so every candidate in
 * the repeated hour resolved to the pre-transition instant, failed the
 * `>= threshold` test once the clock was past it, and was discarded -- and the
 * loop then moved to the next day. An every-5-minutes routine therefore stopped
 * firing for up to 65 minutes, once a year. The minute-walk it replaced did not
 * have this problem because it walked instants, not wall times.
 *
 * (Spelling the cron expression out rather than writing it: the star-slash in
 * one closes this comment.)
 */
function localDateTimeInstants(key: string, schedule: TimeOfDay, timeZone?: string): number[] {
  const [year, month, day] = numbersFromKey(key);
  const targetWall = Date.UTC(year, month - 1, day, schedule.hour, schedule.minute, 0, 0);
  const offsets = new Set<number>();
  for (const days of [-3, -2, -1, 0, 1, 2, 3]) {
    const sample = targetWall + days * 86400_000;
    offsets.add(wallMillis(localParts(sample, timeZone)) - sample);
  }
  return [...offsets]
    .map((offset) => targetWall - offset)
    .filter((instant) => wallMillis(localParts(instant, timeZone)) === targetWall)
    .sort((a, b) => a - b);
}

function localDateTimeToMillis(key: string, schedule: TimeOfDay, timeZone?: string): number {
  const [year, month, day] = numbersFromKey(key);
  const targetWall = Date.UTC(year, month - 1, day, schedule.hour, schedule.minute, 0, 0);
  const offsets = new Set<number>();
  for (const days of [-3, -2, -1, 0, 1, 2, 3]) {
    const sample = targetWall + days * 86400_000;
    const actual = localParts(sample, timeZone);
    offsets.add(wallMillis(actual) - sample);
  }
  const candidates = [...offsets].map((offset) => {
    const instant = targetWall - offset;
    return { instant, wall: wallMillis(localParts(instant, timeZone)) };
  });
  const exact = candidates.filter((candidate) => candidate.wall === targetWall).sort((a, b) => a.instant - b.instant);
  const first = exact[0];
  if (first) return first.instant;
  const afterGap = candidates
    .filter((candidate) => candidate.wall > targetWall)
    .sort((a, b) => a.wall - b.wall || a.instant - b.instant);
  const pick = afterGap[0] ?? candidates[0];
  return pick ? pick.instant : targetWall;
}

export function nextCalendarOccurrence(
  now: TimeInput,
  schedule: unknown,
  timeZone?: string,
  { inclusive = true }: { inclusive?: boolean } = {},
): number | null {
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return null;
  const current = asMillis(now);
  const zone = timeZoneOrLocal(timeZone);
  const today = localParts(current, zone);
  let key = localDateKey(today);
  let occurrence = localDateTimeToMillis(key, normalized, zone);
  if (inclusive ? occurrence < current : occurrence <= current) {
    key = addLocalDays(key, 1);
    occurrence = localDateTimeToMillis(key, normalized, zone);
  }
  return occurrence;
}

export function calendarNextRunAt(
  routine: Routine | null | undefined,
  now: TimeInput,
  timeZone?: string,
): number | null {
  const schedule = normalizeSchedule(routine?.schedule);
  if (!routine || !schedule) return null;
  const current = asMillis(now);
  const zone = timeZoneOrLocal(timeZone);
  const expected = nextCalendarOccurrence(current, schedule, zone);
  if (routine.nextRunTimeZone && timeZone && routine.nextRunTimeZone !== timeZone) return expected;
  const next = Number(routine.nextRunAt);
  if (!Number.isFinite(next) || next <= 0) return expected;
  const local = localParts(next, zone);
  const wallClockMatches = local.hour === schedule.hour && local.minute === schedule.minute && local.second === 0;
  const normalizedGapMatches = localDateTimeToMillis(localDateKey(local), schedule, zone) === next;
  if (!wallClockMatches && !normalizedGapMatches) return expected;
  const todayKey = localDateKey(localParts(current, zone));
  const nextKey = localDateKey(local);
  if (nextKey < todayKey) return localDateTimeToMillis(todayKey, schedule, zone);
  if (next <= current || next === expected) return next;
  return expected;
}

export function advanceCalendarRoutine(
  routine: Routine | null | undefined,
  now: TimeInput,
  timeZone?: string,
): number | null {
  const schedule = normalizeSchedule(routine?.schedule);
  if (!routine || !schedule) return null;
  routine.nextRunAt = nextCalendarOccurrence(now, schedule, timeZone, { inclusive: false });
  if (timeZone) routine.nextRunTimeZone = timeZone;
  return routine.nextRunAt;
}

export function isCalendarRoutine(routine: Routine | null | undefined): boolean {
  return Boolean(normalizeSchedule(routine?.schedule));
}

export function hydrateRoutine<T extends Routine | null | undefined>(
  routine: T,
  now: TimeInput = Date.now(),
  timeZone?: string,
): T {
  if (!routine || isCalendarRoutine(routine)) return routine;
  const text = String(routine.instruction || "");
  if (Number(routine.intervalMs) !== 86400_000) return routine;
  if (!/\b(every|each)\s+morning\b/i.test(text)) return routine;
  if (morningClockAttached(text) || morningQuestionOrNegation(text)) return routine;
  const zone = timeZoneOrLocal(timeZone);
  const schedule = { ...MORNING_SCHEDULE };
  const todayKey = localDateKey(localParts(asMillis(now), zone));
  routine.schedule = schedule;
  delete routine.intervalMs;
  routine.nextRunAt = localDateTimeToMillis(todayKey, schedule, zone);
  routine.nextRunTimeZone = zone;
  return routine;
}

function clockLabel(schedule: TimeOfDay): string {
  const hour = schedule.hour % 12 || 12;
  const suffix = schedule.hour >= 12 ? "PM" : "AM";
  return `${hour}:${String(schedule.minute).padStart(2, "0")} ${suffix}`;
}

export function scheduleLabel(schedule: unknown, timeZone = ""): string {
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return "";
  const zone = timeZone ? ` (${timeZone})` : "";
  return `Every day at ${clockLabel(normalized)}${zone}`;
}

export function cadenceLabel(routine: Routine | null | undefined, timeZone = ""): string {
  const list = triggersOf(routine);
  if (list.length) return list.map((t) => triggerLabel(t)).join(", ");
  const schedule = normalizeSchedule(routine?.schedule);
  if (schedule) return scheduleLabel(schedule, timeZone);
  return `Every ${Math.round((routine?.intervalMs || 0) / 60000)} min`;
}

function asInt(value: unknown, fallback: number): number;
function asInt(value: unknown, fallback?: number | null): number | null;
function asInt(value: unknown, fallback: number | null = null): number | null {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function normalizeTimes(list: unknown): TimeOfDay[] {
  if (!Array.isArray(list)) return [];
  const out: TimeOfDay[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const r = record(row);
    const hour = asInt(r.hour, asInt(r.h));
    const minute = asInt(r.minute, asInt(r.m, 0));
    if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (minute === null || !Number.isInteger(minute) || minute < 0 || minute > 59) continue;
    const key = `${hour}:${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hour, minute });
  }
  return out.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

function parseCronField(
  field: string | undefined,
  min: number,
  max: number,
  { sundaySeven = false }: { sundaySeven?: boolean } = {},
): Set<number> | null {
  const raw = String(field || "").trim();
  if (!raw) return null;
  const allowed = new Set<number>();
  const add = (value: number): void => {
    let n = value;
    if (sundaySeven && n === 7) n = 0;
    if (n < min || n > max) return;
    allowed.add(n);
  };
  for (const part of raw.split(",")) {
    const stepMatch = part.match(/^(.*?)\/(\d+)$/);
    const body = stepMatch?.[1] ?? part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let start = min;
    let end = max;
    if (body === "*") {
      /* full range */
    } else if (/^\d+$/.test(body)) {
      start = Number(body);
      end = stepMatch ? max : start;
    } else {
      const range = body.match(/^(\d+)-(\d+)$/);
      if (!range) return null;
      start = Number(range[1]);
      end = Number(range[2]);
    }
    if (start > end) return null;
    for (let n = start; n <= end; n += step) add(n);
  }
  return allowed.size ? allowed : null;
}

export function parseCron(expr: unknown): ParsedCron | null {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dow = parseCronField(parts[4], 0, 7, { sundaySeven: true });
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow, source: parts.join(" ") };
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function weekdayFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = weekdayFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" });
    weekdayFormatters.set(zone, fmt);
  }
  return fmt;
}

function localWeekdayFromKey(key: string, timeZone?: string): number {
  const ms = localDateTimeToMillis(key, { hour: 12, minute: 0 }, timeZone);
  const txt = weekdayFormatter(timeZoneOrLocal(timeZone)).format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(txt);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextTimesOnDays(
  now: TimeInput,
  times: unknown,
  timeZone: string | undefined,
  {
    inclusive = true,
    matchDay,
  }: { inclusive?: boolean; matchDay?: (key: string, zone: string) => boolean } = {},
): number | null {
  const stamps = normalizeTimes(times);
  if (!stamps.length) return null;
  const zone = timeZoneOrLocal(timeZone);
  const current = asMillis(now);
  let key = localDateKey(localParts(current, zone));
  for (let i = 0; i < 420; i++) {
    if (!matchDay || matchDay(key, zone)) {
      const instants = stamps.map((t) => localDateTimeToMillis(key, t, zone)).sort((a, b) => a - b);
      for (const stamp of instants) {
        if (inclusive ? stamp >= current : stamp > current) return stamp;
      }
    }
    key = addLocalDays(key, 1);
  }
  return null;
}

/**
 * The DATE half of a cron match: month, day-of-month, day-of-week.
 *
 * Split out of `cronMatchesKey` so `nextCronOccurrence` can reject a whole day
 * at once instead of testing all 1,440 of its minutes. Month and day-of-month
 * are pure arithmetic on the key; only the weekday costs a zone round-trip, so
 * it is computed lazily — and for the common `* * ` day fields, never at all.
 */
function cronMatchesDate(parsed: ParsedCron, key: string, timeZone: string): boolean {
  const [, month, day] = numbersFromKey(key);
  if (!parsed.month.has(month)) return false;
  const starDom = parsed.dom.size === 31;
  const starDow = parsed.dow.size === 7;
  const domOk = parsed.dom.has(day);
  // "*" in dow means the weekday can never decide the match — skip the lookup.
  if (starDow) return starDom || domOk;
  if (starDom) return parsed.dow.has(localWeekdayFromKey(key, timeZone));
  // Neither field is "*": cron's documented OR. `domOk` short-circuits the
  // weekday round-trip on the days that already matched.
  return domOk || parsed.dow.has(localWeekdayFromKey(key, timeZone));
}

function cronMatchesKey(parsed: ParsedCron, key: string, timeZone: string, hour: number, minute: number): boolean {
  if (!parsed.minute.has(minute) || !parsed.hour.has(hour)) return false;
  return cronMatchesDate(parsed, key, timeZone);
}

/** Four years of days — the longest gap between Feb 29s, plus slack. */
const CRON_SEARCH_DAYS = 4 * 366;

export function nextCronOccurrence(
  now: TimeInput,
  expr: unknown,
  timeZone?: string,
  { inclusive = false }: { inclusive?: boolean } = {},
): number | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;
  const zone = timeZoneOrLocal(timeZone);
  const current = asMillis(now);
  const start = new Date(inclusive ? current : current + 60_000);
  start.setUTCSeconds(0, 0);
  const threshold = start.getTime();

  // Walk DAYS, not minutes. The old loop tested every one of 366*24*60 =
  // 527,040 minutes, which cost ~1.5s of blocked event loop for an expression
  // that never matches — inside tickRoutines, which runs every 15s per bot.
  // Rejecting a day costs one arithmetic check, so the same scan is now a few
  // thousand cheap iterations and the window can afford to be four years wide.
  // That width is what makes "0 0 29 2 *" — the ordinary way to write "every
  // leap day" — resolve at all: within 366 days it found nothing and returned
  // null, so the routine silently never fired in three years out of four.
  const hours = [...parsed.hour].sort((a, b) => a - b);
  const minutes = [...parsed.minute].sort((a, b) => a - b);
  // Start from the local day the threshold falls in. There is no hour/minute
  // cursor: inside a fall-back the earliest qualifying instant can have a wall
  // time earlier than the threshold's, so the whole day is scanned.
  let key = localDateKey(localParts(threshold, zone));

  for (let day = 0; day < CRON_SEARCH_DAYS; day++) {
    if (cronMatchesDate(parsed, key, zone)) {
      // The EARLIEST qualifying instant in this day, not the first in wall
      // order. Wall order and real order agree except inside a DST fall-back,
      // where the repeated hour runs twice: 01:00 EST is LATER than 01:55 EDT
      // even though its wall time is earlier. Returning on the first wall-order
      // hit therefore skipped the whole second pass -- an every-5-minutes
      // routine stopped firing for up to 65 minutes, once a year.
      //
      // Scanning the matching day costs hours x minutes candidates once (288
      // for an every-5-minutes expression) and only on the day that matches.
      let best: number | null = null;
      for (const hour of hours) {
        for (const minute of minutes) {
          // EVERY instant for this wall time: two inside a repeated hour, and
          // NONE inside the spring-forward gap -- which is what makes cron skip
          // that day, the behaviour the old round-trip check provided.
          for (const instant of localDateTimeInstants(key, { hour, minute }, zone)) {
            if (instant >= threshold && (best === null || instant < best)) best = instant;
          }
        }
      }
      if (best !== null) return best;
    }
    key = addLocalDays(key, 1);
  }
  return null;
}

export function normalizeTrigger(raw: unknown): Trigger | null {
  if (!raw || typeof raw !== "object") return null;
  const row = record(raw);
  const kind = String(row.kind || "").toLowerCase();
  const id = String(row.id || "").trim() || null;
  const times = normalizeTimes(row.times);
  const lastRunAt = Number(row.lastRunAt);
  const nextRunAt = Number(row.nextRunAt);
  const stamp = {
    lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : 0,
    nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : null,
  };
  if (kind === "once") {
    const at = Number(row.at);
    if (!Number.isFinite(at) || at <= 0) return null;
    const trigger: OnceTrigger = { id, kind: "once", at, ...stamp };
    return trigger;
  }
  if (kind === "hourly") {
    const trigger: IntervalTrigger = { id, kind: "hourly", intervalMs: 3600_000, ...stamp };
    return trigger;
  }
  if (kind === "interval") {
    const intervalMs = Number(row.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < 60_000) return null;
    const trigger: IntervalTrigger = { id, kind: "interval", intervalMs, ...stamp };
    return trigger;
  }
  if (kind === "daily") {
    if (!times.length) return null;
    const trigger: TimesTrigger = { id, kind: "daily", times, ...stamp };
    return trigger;
  }
  if (kind === "weekdays") {
    if (!times.length) return null;
    const trigger: TimesTrigger = { id, kind: "weekdays", times, ...stamp };
    return trigger;
  }
  if (kind === "weekly") {
    const weekday = ((asInt(row.weekday, 1) % 7) + 7) % 7;
    const trigger: WeeklyTrigger = {
      id,
      kind: "weekly",
      weekday,
      times: times.length ? times : [{ hour: 9, minute: 0 }],
      ...stamp,
    };
    return trigger;
  }
  if (kind === "monthly") {
    const monthDay = Math.min(31, Math.max(1, asInt(row.monthDay, 1)));
    const trigger: MonthlyTrigger = {
      id,
      kind: "monthly",
      monthDay,
      times: times.length ? times : [{ hour: 9, minute: 0 }],
      ...stamp,
    };
    return trigger;
  }
  if (kind === "advanced") {
    const months = Array.isArray(row.months)
      ? [...new Set(row.months.map((n) => asInt(n)).filter((n): n is number => n !== null && n >= 1 && n <= 12))]
      : [];
    const days = row.days === "weekdays" ? "weekdays" : "every";
    const trigger: AdvancedTrigger = {
      id,
      kind: "advanced",
      months,
      days,
      times: times.length ? times : [{ hour: 8, minute: 0 }],
      ...stamp,
    };
    return trigger;
  }
  if (kind === "cron") {
    const cron = String(row.cron || "").trim();
    if (!parseCron(cron)) return null;
    return { id, kind: "cron", cron, ...stamp };
  }
  return null;
}

export function triggerLabel(trigger: unknown): string {
  const t = normalizeTrigger(trigger);
  if (!t) return "";
  const times = "times" in t ? t.times : [];
  const clocks = times.map((x) => clockLabel(x));
  const clock = clocks.join(", ");
  if (t.kind === "hourly") return "Every hour";
  if (t.kind === "interval") {
    const mins = Math.max(1, Math.round(t.intervalMs / 60_000));
    if (mins % 60 === 0) {
      const hours = mins / 60;
      return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `Every ${mins} minute${mins === 1 ? "" : "s"}`;
  }
  if (t.kind === "daily") return clocks.length > 1 ? `Every day at ${clock}` : `Every day at ${clock}`;
  if (t.kind === "weekdays") return `Weekdays at ${clock}`;
  if (t.kind === "weekly") {
    const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][t.weekday] || "week";
    return `Every week on ${day} at ${clock}`;
  }
  if (t.kind === "monthly") return `Every month on the ${t.monthDay} at ${clock}`;
  if (t.kind === "advanced") return clocks.length ? `Advanced · ${clock}` : "Advanced";
  if (t.kind === "cron") return t.cron;
  return "";
}

export function triggersOf(routine: Routine | null | undefined): Trigger[] {
  const stored = routine?.triggers;
  if (Array.isArray(stored) && stored.length) {
    return stored.map(normalizeTrigger).filter((t): t is Trigger => t !== null);
  }
  const schedule = normalizeSchedule(routine?.schedule);
  if (schedule) {
    return [
      {
        kind: "daily",
        times: [{ hour: schedule.hour, minute: schedule.minute }],
        nextRunAt: routine?.nextRunAt || null,
        lastRunAt: routine?.lastRunAt || 0,
      },
    ];
  }
  if (Number(routine?.intervalMs) > 0) {
    const intervalMs = Number(routine?.intervalMs);
    return [
      {
        kind: intervalMs === 3600_000 ? "hourly" : "interval",
        intervalMs,
        lastRunAt: routine?.lastRunAt || 0,
        nextRunAt: routine?.nextRunAt || null,
      },
    ];
  }
  return [];
}

/** `hourly` and `interval` share a shape; a predicate narrows both sides of the branch. */
function isElapsedTrigger(t: Trigger): t is IntervalTrigger {
  return t.kind === "hourly" || t.kind === "interval";
}

export function nextTriggerOccurrence(
  trigger: unknown,
  now: TimeInput,
  timeZone?: string,
  { inclusive = true }: { inclusive?: boolean } = {},
): number | null {
  const t = normalizeTrigger(trigger);
  if (!t) return null;
  const current = asMillis(now);
  if (t.kind === "once") {
    // Fired already → never again. Otherwise it is due at `at` (or now, if that
    // moment has passed and it has not fired yet).
    if (t.lastRunAt > 0 && t.lastRunAt >= t.at) return null;
    return inclusive && t.at <= current ? current : t.at;
  }
  if (isElapsedTrigger(t)) {
    const base = t.lastRunAt > 0 ? t.lastRunAt : current;
    const wait = t.intervalMs || 3600_000;
    const next = base + wait;
    if (inclusive) return next <= current ? current : next;
    return next <= current ? current + wait : next;
  }
  if (t.kind === "cron") return nextCronOccurrence(now, t.cron, timeZone, { inclusive });
  const times = t.times || [{ hour: 9, minute: 0 }];
  const matchDay = (key: string, zone: string): boolean => {
    const dow = localWeekdayFromKey(key, zone);
    const [year, month, day] = numbersFromKey(key);
    if (t.kind === "weekdays") return dow >= 1 && dow <= 5;
    if (t.kind === "weekly") return dow === t.weekday;
    if (t.kind === "monthly") return day === Math.min(t.monthDay, lastDayOfMonth(year, month));
    if (t.kind === "advanced") {
      if (t.months?.length && !t.months.includes(month)) return false;
      if (t.days === "weekdays") return dow >= 1 && dow <= 5;
      return true;
    }
    return true;
  };
  return nextTimesOnDays(now, times, timeZone, { inclusive, matchDay });
}

export function triggerDue(trigger: unknown, now: TimeInput, timeZone?: string): boolean {
  const t = normalizeTrigger(trigger);
  if (!t) return false;
  const current = asMillis(now);
  if (isElapsedTrigger(t)) {
    return current - (t.lastRunAt || 0) >= (t.intervalMs || 3600_000);
  }
  const stored = t.nextRunAt;
  const next =
    stored !== null && Number.isFinite(stored) && stored > 0 ? stored : nextTriggerOccurrence(t, current, timeZone);
  return next !== null && Number.isFinite(next) && current >= next;
}

export function advanceTrigger(trigger: unknown, now: TimeInput, timeZone?: string): unknown {
  const t = normalizeTrigger(trigger);
  if (!t) return trigger;
  const current = asMillis(now);
  t.lastRunAt = current;
  t.nextRunAt = nextTriggerOccurrence(t, current, timeZone, { inclusive: false });
  Object.assign(record(trigger), t);
  return trigger;
}

export function syncLegacyFromTriggers(routine: Routine, now: TimeInput = Date.now(), timeZone?: string): Routine {
  const list = (routine.triggers || []).map(normalizeTrigger).filter((t): t is Trigger => t !== null);
  routine.triggers = list.map((t) => ({ ...t, id: t.id || randomUUID() }));
  const only = list.length === 1 ? list[0] : null;
  if (only && (only.kind === "interval" || only.kind === "hourly")) {
    routine.intervalMs = only.intervalMs;
    delete routine.schedule;
    delete routine.nextRunAt;
    delete routine.nextRunTimeZone;
    return routine;
  }
  if (only && only.kind === "daily" && only.times.length === 1) {
    const first = only.times[0];
    if (first) {
      routine.schedule = { type: "daily", hour: first.hour, minute: first.minute };
      delete routine.intervalMs;
      routine.nextRunAt = nextTriggerOccurrence(only, now, timeZone);
      if (timeZone) routine.nextRunTimeZone = timeZone;
      return routine;
    }
  }
  if (list.length) {
    delete routine.intervalMs;
    delete routine.schedule;
    delete routine.nextRunAt;
    delete routine.nextRunTimeZone;
  }
  return routine;
}

function cadenceOverlaps(row: Routine | null | undefined, spec: { schedule?: unknown; intervalMs?: number | null }): boolean {
  const existingSchedule = normalizeSchedule(row?.schedule);
  const schedule = normalizeSchedule(spec?.schedule);
  if (existingSchedule && schedule) return sameSchedule(existingSchedule, schedule);
  if (existingSchedule || schedule) return false;
  return similarInterval(row?.intervalMs || spec?.intervalMs, spec?.intervalMs);
}

export function overlappingRoutine(bot: RoutineBot | null | undefined, spec: RoutineSpec = {}): Routine | null {
  const rows = bot?.routines || [];
  const key = spec.groupKey || groupKey(spec.instruction || spec.name || "");
  const parsed = parseSchedule(spec.instruction || spec.name || "");
  const schedule = normalizeSchedule(spec.schedule || parsed?.schedule);
  const intervalMs = spec.intervalMs || parsed?.intervalMs || (schedule ? null : 20 * 60_000);
  const probe = { schedule, intervalMs };
  return (
    rows.find((r) => r.id !== spec.id && r.groupKey === key && cadenceOverlaps(r, probe)) ||
    rows.find((r) => r.id !== spec.id && cadenceOverlaps(r, probe)) ||
    null
  );
}

/** Filesystem slug for automations/<slug>/automation.json — same rules as memory.slug. */
export function automationSlug(text: unknown): string {
  const s = String(text || "job")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "job";
}

export function automationPath(botId: string, routine: Routine | null | undefined): string {
  const s = automationSlug(routine?.name || routine?.id);
  return `/config/agent-data/agents/${botId}/automations/${s}/automation.json`;
}

function intervalShorthand(intervalMs: unknown): string {
  const mins = Math.max(1, Math.round(Number(intervalMs) / 60_000));
  if (mins === 60) return "@hourly";
  if (mins === 1440) return "@daily";
  if (mins === 10080) return "@weekly";
  if (mins % 1440 === 0) return `@every ${mins / 1440}d`;
  if (mins % 60 === 0) return `@every ${mins / 60}h`;
  return `@every ${mins}m`;
}

function cronFromTimes(times: TimeOfDay[] | undefined, dow = "*", dom = "*"): string | null {
  if (!Array.isArray(times) || times.length !== 1) return null;
  const t = times[0];
  if (!t || !Number.isInteger(t.minute) || !Number.isInteger(t.hour)) return null;
  return `${t.minute} ${t.hour} ${dom} * ${dow}`;
}

/** Spec-ish schedule: cron / @shorthand string, else a JSON-serializable object. */
export function automationSchedule(
  routine: Routine | null | undefined,
): string | Record<string, unknown> | undefined {
  if (!routine) return undefined;
  if (typeof routine.schedule === "string") {
    const s = routine.schedule.trim();
    if (s) return s;
  }
  const list = triggersOf(routine);
  const t = list[0];
  if (list.length === 1 && t) {
    if (t.kind === "cron" && t.cron) return t.cron;
    if (t.kind === "hourly") return "@hourly";
    if (t.kind === "interval") return intervalShorthand(t.intervalMs);
    if (t.kind === "daily") {
      const cron = cronFromTimes(t.times);
      if (cron) return cron;
    }
    if (t.kind === "weekdays") {
      const cron = cronFromTimes(t.times, "1-5");
      if (cron) return cron;
    }
    if (t.kind === "weekly") {
      const cron = cronFromTimes(t.times, String(t.weekday));
      if (cron) return cron;
    }
    if (t.kind === "monthly") {
      const cron = cronFromTimes(t.times, "*", String(t.monthDay));
      if (cron) return cron;
    }
  }
  const cal = normalizeSchedule(routine.schedule);
  if (cal) return `${cal.minute} ${cal.hour} * * *`;
  if (routine.schedule && typeof routine.schedule === "object") return { ...record(routine.schedule) };
  if (Number(routine.intervalMs) > 0) return intervalShorthand(routine.intervalMs);
  const label = cadenceLabel(routine);
  return label || undefined;
}

/** On-disk AutomationJson: name, prompt, schedule, enabled, createdAt, lastRunAt, and activeHours when set. */
export function automationJson(routine: Routine | null | undefined): AutomationJson {
  const last = Number(routine?.lastRunAt);
  const created = Number(routine?.createdAt);
  const schedule = automationSchedule(routine);
  const json = {
    name: String(routine?.name || "Routine"),
    prompt: String(routine?.instruction || ""),
    enabled: routine?.enabled !== false,
    createdAt: Number.isFinite(created) ? created : 0,
    lastRunAt: Number.isFinite(last) && last > 0 ? last : null,
    schedule: schedule !== undefined && schedule !== "" ? schedule : undefined,
  };
  const activeHours = normalizeActiveHours(routine?.activeHours);
  return {
    name: json.name,
    prompt: json.prompt,
    ...(json.schedule !== undefined ? { schedule: json.schedule } : {}),
    enabled: json.enabled,
    createdAt: json.createdAt,
    lastRunAt: json.lastRunAt,
    ...(activeHours ? { activeHours } : {}),
  };
}

/**
 * Every key either mirror writer puts in `automation.json`: `automationJson`
 * above, and the seed `ensureLayout` (server/memory.mts) writes when a file is
 * missing ({id, name, cadence, instruction}).
 */
const MIRROR_KEYS = new Set([
  "id",
  "name",
  "cadence",
  "instruction",
  "prompt",
  "schedule",
  "enabled",
  "createdAt",
  "lastRunAt",
  "activeHours",
]);

/**
 * True when a parsed `automation.json` is one the routine mirror wrote: an
 * object with a string name, a string brief (`prompt` or `instruction`) and no
 * key outside the two mirror shapes. Pruning stale mirrors deletes only these,
 * so a file a user or the bot wrote by hand in that folder is left alone.
 */
export function isMirroredAutomationJson(json: unknown): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const row = json as Record<string, unknown>;
  if (typeof row.name !== "string") return false;
  if (typeof row.prompt !== "string" && typeof row.instruction !== "string") return false;
  return Object.keys(row).every((k) => MIRROR_KEYS.has(k));
}

/**
 * The desk filesystem, injected by the host process. `server/routines.mjs`
 * reached vm.mjs through a lazy dynamic import here; that seam is the package
 * boundary now, so nothing in this package knows about the container tunnel.
 */
let automationWriter: AutomationWriter | null = null;

export function setAutomationWriter(writer: AutomationWriter | null): void {
  automationWriter = writer;
}

function canWriteDesk(bot: RoutineBot | null | undefined): boolean {
  if (!bot?.id || bot?.vm?.deskUrl) return false;
  return Boolean(bot.vm?.container) && bot.vm?.status !== "missing";
}

export async function persistRoutineAutomation(
  bot: RoutineBot | null | undefined,
  routine: Routine | null | undefined,
  writer: AutomationWriter | null = automationWriter,
): Promise<string | null> {
  if (!canWriteDesk(bot) || !routine || !writer) return null;
  const container = bot?.vm?.container;
  if (!bot?.id || !container) return null;
  const dest = automationPath(bot.id, routine);
  const dir = dest.slice(0, dest.lastIndexOf("/"));
  const body = `${JSON.stringify(automationJson(routine), null, 2)}\n`;
  await writer.mkdirpInContainer(container, dir);
  await writer.writeFileToContainer(container, dest, body);
  return dest;
}

function persistAfterUpsert(bot: RoutineBot, routine: Routine): void {
  if (!canWriteDesk(bot) || !routine) return;
  void persistRoutineAutomation(bot, routine).catch(() => {});
}

/** How many replaced briefs a routine keeps on `instructionHistory`. */
export const INSTRUCTION_HISTORY_MAX = 5;

/**
 * Replace a routine's brief, keeping the old one on `instructionHistory`. Every
 * write to `instruction` on an existing row goes through here, so a brief that
 * was overwritten by mistake can always be put back.
 */
function setInstruction(routine: Routine, next: string, now: number = Date.now()): void {
  const prev = String(routine.instruction || "");
  if (prev === next) return;
  if (prev.trim()) {
    const history = Array.isArray(routine.instructionHistory) ? routine.instructionHistory : [];
    history.push({ instruction: prev, replacedAt: now });
    routine.instructionHistory = history.slice(-INSTRUCTION_HISTORY_MAX);
  }
  routine.instruction = next;
}

/**
 * Put back the brief a routine had before its last replacement. The current
 * brief goes onto the history in its place, so a restore can itself be undone.
 * Returns null when the routine is missing or has nothing to restore.
 */
export function restorePreviousInstruction(
  bot: RoutineBot,
  id: string,
  now: number = Date.now(),
): Routine | null {
  const routine = (bot?.routines || []).find((r) => r.id === id);
  const history = routine?.instructionHistory;
  if (!routine || !Array.isArray(history) || !history.length) return null;
  const last = history.pop()!;
  const current = String(routine.instruction || "");
  if (current.trim()) history.push({ instruction: current, replacedAt: now });
  routine.instructionHistory = history.slice(-INSTRUCTION_HISTORY_MAX);
  routine.instruction = last.instruction;
  routine.updatedAt = now;
  return routine;
}

/**
 * Routines as list_routines shows them. The full history would repeat every
 * old brief in each listing, so each earlier brief appears as when it was
 * replaced, its length and how it began: enough to decide on a restore.
 */
export function routinesForListing<T extends object>(
  rows: readonly T[] | null | undefined,
  { now, timeZone }: { now?: number; timeZone?: string } = {},
): Record<string, unknown>[] {
  const current = now ?? Date.now();
  return (rows || []).map((r) => {
    const { instructionHistory, ...rest } = r as T & { instructionHistory?: InstructionHistoryEntry[] | undefined };
    // When it fires next, the active-hours window applied: what "Next run" means.
    const routine = r as unknown as Routine;
    const next = routine.enabled === false ? null : routineNextRunAt(routine, current, timeZone);
    const row = { ...rest, nextRun: next === null ? null : new Date(next).toISOString() };
    return Array.isArray(instructionHistory) && instructionHistory.length
      ? {
          ...row,
          previousInstructions: instructionHistory.map((h) => ({
            replacedAt: new Date(h.replacedAt).toISOString(),
            chars: String(h.instruction || "").length,
            begins: String(h.instruction || "").slice(0, 160),
          })),
        }
      : { ...row };
  });
}

/**
 * The schedule a plain chat message carries, applied to the bot's routines.
 *
 * A user line like "check the inbox every 30 minutes" becomes a routine when
 * the bot has none. Once a standing routine exists, the message is NOT a new
 * brief: it is a chat turn the model reads and acts on (it has upsert_routine
 * for real edits). Treating it as one is how a long "new standing orders"
 * message (which mentioned an old routine as "hourly") replaced a bot's
 * whole standing brief with the message text, reset its 30-minute cadence to
 * hourly and, through the solo default, dropped every other routine. So with
 * a routine in place this only ever adjusts the cadence, only for a short
 * one-line request, and never touches the brief or any other row.
 */
export function captureChatSchedule(
  bot: RoutineBot,
  text: unknown,
  { timeZone, now }: { timeZone?: string; now?: number } = {},
): UpsertResult | null {
  const t = String(text || "");
  if (looksLikeTeammateTraffic(t) || !looksLikeSchedule(t)) return null;
  const parsed = parseSchedule(t);
  if (!parsed) return null;
  const cadence = {
    ...(parsed.intervalMs !== undefined ? { intervalMs: parsed.intervalMs } : {}),
    ...(parsed.schedule !== undefined ? { schedule: parsed.schedule } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(now !== undefined ? { now } : {}),
  };
  const standing = (bot?.routines || []).filter(
    (r) => !(Array.isArray(r.triggers) && r.triggers.length > 0 && r.triggers.every((x) => x.kind === "once")),
  );
  if (!standing.length) return upsertRoutine(bot, { instruction: t, ...cadence });
  if (!looksLikeChatLine(t)) return null;
  return upsertRoutine(bot, { instruction: t, ...cadence, keepInstruction: true, solo: false });
}

export function upsertRoutine(bot: RoutineBot, spec: RoutineSpec): UpsertResult {
  const result = applyRoutineUpsert(bot, spec);
  if (result?.routine) persistAfterUpsert(bot, result.routine);
  return result;
}

function stampTriggers(list: unknown[]): Trigger[] {
  return list
    .map(normalizeTrigger)
    .filter((t): t is Trigger => t !== null)
    .map((t) => ({ ...t, id: t.id || randomUUID(), lastRunAt: t.lastRunAt || Date.now() }));
}

function applyRoutineUpsert(bot: RoutineBot, spec: RoutineSpec): UpsertResult {
  if (!bot) throw new Error("upsertRoutine: bot missing");
  if (!Array.isArray(bot.routines)) bot.routines = [];
  const rows = bot.routines;
  const text = String(spec.instruction || spec.name || "").trim();
  let explicitInterval =
    Number.isFinite(Number(spec.intervalMs)) && Number(spec.intervalMs) > 0 ? Number(spec.intervalMs) : null;
  const key = spec.groupKey || "general";
  const parsed = parseSchedule(text);
  if (explicitInterval === 86400_000 && (parsed?.schedule || normalizeSchedule(spec.schedule))) {
    explicitInterval = null;
  }
  // An explicit trigger list (a one-shot reminder, a cron) IS the schedule; the
  // instruction-text classifier only applies when the model gave no trigger.
  const explicitTriggers = Array.isArray(spec.triggers) && spec.triggers.length > 0;
  const rejectedNew = explicitTriggers ? false : isRejectedRoutineInstruction(text, { explicitInterval: Boolean(explicitInterval) });
  const schedule = explicitInterval ? null : normalizeSchedule(spec.schedule || parsed?.schedule);
  const intervalMs = explicitInterval || (!schedule ? parsed?.intervalMs || 20 * 60_000 : null);
  const byId = spec.id ? rows.find((r) => r.id === spec.id) : null;
  if (spec.id && !byId) {
    return { routine: null, merged: false, rejected: "routine not found" };
  }
  // undefined: leave the stored window; null: clear it; else: set it.
  let activeHours: ActiveHours | null | undefined;
  if (spec.activeHours !== undefined) {
    const parsedHours = parseActiveHours(spec.activeHours, spec.timeZone ? { defaultTimeZone: spec.timeZone } : {});
    if (!parsedHours.ok) return { routine: null, merged: false, rejected: parsedHours.error };
    activeHours = parsedHours.value;
  }
  const creating = !spec.id && !rows.length;
  if (!byId && rejectedNew && (creating || spec.forceNew === true)) {
    return {
      routine: null,
      merged: false,
      rejected: "need a standing job (what to watch, and how often), not a chat or one-shot instruction",
    };
  }
  const overlap = overlappingRoutine(bot, { ...spec, groupKey: key, intervalMs, schedule });
  // A one-off reminder (explicit trigger) never 'overlaps' a standing job.
  if (spec.forceNew && overlap && !explicitTriggers) {
    return {
      routine: overlap,
      merged: false,
      rejected: `overlaps "${overlap.name}" (${overlap.id}) ${cadenceLabel(overlap).toLowerCase()}. Update that id instead of creating a second job.`,
    };
  }
  // A one-off reminder is never the standing job: it must not absorb a new
  // standing brief (that merged "every 30 minutes" into a fired reminder whose
  // `once` trigger could never fire again), and a new standing job must not
  // replace it.
  const isOnce = (r: Routine): boolean => Array.isArray(r.triggers) && r.triggers.length > 0 && r.triggers.every((t) => t.kind === "once");
  const standing = rows.filter((r) => !isOnce(r));
  const primary = standing.find((r) => r.groupKey === "general") || standing[0] || null;
  const existing = byId || (!spec.forceNew && ((overlap && !isOnce(overlap) ? overlap : null) || primary)) || null;
  if (existing) {
    hydrateRoutine(existing, spec.now ?? Date.now(), spec.timeZone);
    // A new cadence replaces stale triggers on the merged row (a fired `once`
    // would otherwise pin nextRunAt to null forever).
    if ((explicitInterval || schedule) && isOnce(existing)) existing.triggers = [];
    // Refusing a casual rewrite used to RETURN here, which skipped everything
    // below — schedule, triggers, intervalMs, name, groupKey. So an upsert that
    // carried a new cadence alongside a short instruction kept the old cadence
    // and reported "kept standing brief": a message about the brief, for a
    // change that was not to the brief. The only escape, forceReplace, then
    // overwrote the standing brief with that short text, so no call shape could
    // change the cadence alone. Now it declines only the INSTRUCTION and the
    // rest of the spec applies.
    let keptBrief = false;
    // `keepInstruction`: a cadence-only update (a schedule captured from chat).
    // It must not write the brief, and like a refused rewrite it must not
    // quietly resume a paused routine either.
    const cadenceOnly = spec.keepInstruction === true;
    if (text && !cadenceOnly) {
      const prev = existing.instruction || "";
      const weak = isWeakRoutineInstruction(text);
      const casual = (looksLikeChatLine(text) || weak) && !parseSchedule(text);
      if ((weak || (casual && prev.length > 80)) && spec.forceReplace !== true) {
        keptBrief = true;
      } else if (spec.replace === false && prev) {
        if (!prev.includes(text)) setInstruction(existing, `${prev.trim()}\n\n${text}`, spec.now);
      } else {
        setInstruction(existing, text, spec.now);
      }
    }
    if (schedule) {
      const oldSchedule = normalizeSchedule(existing.schedule);
      existing.schedule = schedule;
      delete existing.intervalMs;
      if (!sameSchedule(oldSchedule, schedule) || !Number.isFinite(existing.nextRunAt)) {
        existing.nextRunAt = nextCalendarOccurrence(spec.now ?? Date.now(), schedule, spec.timeZone);
      } else if (spec.timeZone) {
        existing.nextRunAt = calendarNextRunAt(existing, spec.now ?? Date.now(), spec.timeZone);
      }
      if (spec.timeZone) existing.nextRunTimeZone = spec.timeZone;
    } else if (normalizeSchedule(existing.schedule) && !explicitInterval && !parsed?.intervalMs) {
      if (spec.timeZone && existing.nextRunTimeZone && existing.nextRunTimeZone !== spec.timeZone) {
        existing.nextRunAt = calendarNextRunAt(existing, spec.now ?? Date.now(), spec.timeZone);
      }
      if (spec.timeZone) existing.nextRunTimeZone = spec.timeZone;
    } else if (
      !explicitInterval &&
      !parsed?.intervalMs &&
      typeof existing.intervalMs === "number" &&
      Number.isFinite(existing.intervalMs) &&
      existing.intervalMs > 0
    ) {
      /* No parsed cadence: leave schedule/intervalMs as stored. */
    } else {
      delete existing.schedule;
      delete existing.nextRunAt;
      delete existing.nextRunTimeZone;
      if (intervalMs !== null && Number.isFinite(intervalMs) && intervalMs > 0) existing.intervalMs = intervalMs;
    }
    if (spec.name) existing.name = spec.name;
    if (spec.groupKey) existing.groupKey = spec.groupKey;
    if (Array.isArray(spec.triggers)) {
      existing.triggers = stampTriggers(spec.triggers);
      syncLegacyFromTriggers(existing, spec.now ?? Date.now(), spec.timeZone);
    }
    if (activeHours !== undefined) {
      const before = JSON.stringify(existing.activeHours ?? null);
      if (activeHours) existing.activeHours = activeHours;
      else delete existing.activeHours;
      if (before !== JSON.stringify(activeHours)) rebaseHeldTriggers(existing, spec.now ?? Date.now(), spec.timeZone);
    }
    if (typeof spec.enabled === "boolean") existing.enabled = spec.enabled;
    // `!keptBrief`: the old early return never reached this auto-re-enable, so a
    // refused rewrite must not quietly resume a paused routine now that it
    // falls through.
    else if (!keptBrief && !cadenceOnly && existing.enabled === false && !spec.forceNew) existing.enabled = true;
    existing.updatedAt = Date.now();
    if (spec.solo !== false && !spec.forceNew) {
      bot.routines = rows.filter((r) => r.id === existing.id);
    }
    return keptBrief
      ? { routine: existing, merged: true, rejected: "kept standing brief (refused casual rewrite)" }
      : { routine: existing, merged: true };
  }
  if (rejectedNew) {
    return {
      routine: null,
      merged: false,
      rejected: "need a standing job (what to watch, and how often), not a chat or one-shot instruction",
    };
  }
  const routine: Routine = {
    id: randomUUID(),
    name: spec.name || groupLabel(key),
    groupKey: key,
    instruction: text,
    enabled: spec.enabled !== false,
    lastRunAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (schedule) {
    routine.schedule = schedule;
    routine.nextRunAt = nextCalendarOccurrence(spec.now ?? Date.now(), schedule, spec.timeZone);
    if (spec.timeZone) routine.nextRunTimeZone = spec.timeZone;
  } else if (intervalMs !== null) {
    routine.intervalMs = intervalMs;
  }
  if (Array.isArray(spec.triggers) && spec.triggers.length) {
    routine.triggers = stampTriggers(spec.triggers);
    syncLegacyFromTriggers(routine, spec.now ?? Date.now(), spec.timeZone);
  }
  if (activeHours) routine.activeHours = activeHours;
  rows.push(routine);
  return { routine, merged: false };
}

export function dueRoutines(
  bot: RoutineBot,
  now: number = Date.now(),
  { timeZone }: { timeZone?: string } = {},
): Routine[] {
  return (bot.routines || []).filter((r) => {
    hydrateRoutine(r, now, timeZone);
    if (r.enabled === false) return false;
    // Outside its active hours a routine is never due, whatever its cadence
    // says: no turn, no model call. `holdOutsideActiveHours` moves the fire to
    // the window's next opening.
    if (r.activeHours && !inActiveHours(r.activeHours, now, timeZone)) return false;
    if (Array.isArray(r.triggers) && r.triggers.length) {
      return r.triggers.some((t) => triggerDue(t, now, timeZone));
    }
    const schedule = normalizeSchedule(r.schedule);
    if (schedule) {
      const next = calendarNextRunAt(r, now, timeZone);
      return next !== null && Number.isFinite(next) && now >= next;
    }
    return now - (r.lastRunAt || 0) >= Number(r.intervalMs);
  });
}

export function packDue(due: Routine[]): DuePack[] {
  const buckets = new Map<string, Routine[]>();
  for (const r of due) {
    const k = r.groupKey || "general";
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = [];
      buckets.set(k, bucket);
    }
    bucket.push(r);
  }
  return [...buckets.values()].map((items) => {
    const head = items[0];
    return {
      groupKey: head?.groupKey,
      name: head?.name,
      ids: items.map((i) => i.id),
      instruction: items.map((i) => i.instruction).join("\n"),
    };
  });
}

export function promptBlock(
  bot: RoutineBot,
  { compact = false, timeZone = "" }: { compact?: boolean; timeZone?: string } = {},
): string {
  const rows = (bot.routines || []).filter((r) => r.enabled !== false);
  if (!rows.length) return "";
  const lines = compact
    ? rows.map(
        (r) =>
          `- [${r.groupKey}] ${r.name} ${cadenceLabel(r, timeZone).toLowerCase()}${hoursSuffix(r)}. The current user task is this job — do not paste the brief back.`,
      )
    : rows.map(
        (r) =>
          `- [${r.groupKey}] ${r.name} ${cadenceLabel(r, timeZone).toLowerCase()}${hoursSuffix(r)}: ${String(r.instruction ?? "").replace(/\n/g, " | ")}`,
      );
  return [
    "",
    "## Standing routines (master schedule)",
    "These fire automatically. You MAY edit them: list_routines, then upsert_routine with that id. When the operator asks to change the routine, that IS permission — pass the full new brief and force_replace. Default is ONE standing job. Do not create a second routine that overlaps (same group or a similar interval); update the existing id instead. Instruction text must be a standing brief, never a chat one-liner.",
    ...lines,
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------------ */
/* Active hours                                                              */
/* ------------------------------------------------------------------------ */

/** `ActiveHours.days` in week order, indexed like `Date#getDay`. */
export const ACTIVE_DAYS: readonly ActiveDay[] = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

function parseClock(value: unknown): TimeOfDay | null {
  const m = String(value ?? "").trim().match(CLOCK_RE);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function clockText(t: TimeOfDay): string {
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

function isTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type ActiveHoursParse = { ok: true; value: ActiveHours | null } | { ok: false; error: string };

/**
 * Validate a firing window from a tool call, the REST API, a mirror file or
 * a hand-edited bots.json. null / undefined is "no window" (and on an upsert,
 * "clear it"). `start` and `end` are "HH:MM" (24-hour, "8:00" is accepted and
 * stored as "08:00"); `tz` is an IANA zone Intl accepts and falls back to
 * `defaultTimeZone`; `days` is optional, three-letter weekday names, stored
 * lowercase in week order (all seven collapse to "every day", i.e. absent).
 * `start` equal to `end` is accepted and means the whole day.
 */
export function parseActiveHours(raw: unknown, { defaultTimeZone }: { defaultTimeZone?: string } = {}): ActiveHoursParse {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "active_hours must be an object {start, end, tz, days?} or null" };
  }
  const row = raw as Record<string, unknown>;
  const start = parseClock(row.start);
  if (!start) return { ok: false, error: 'active_hours.start must be a 24-hour time like "08:00"' };
  const end = parseClock(row.end);
  if (!end) return { ok: false, error: 'active_hours.end must be a 24-hour time like "20:00"' };
  const tz = String(row.tz ?? row.timeZone ?? defaultTimeZone ?? "").trim();
  if (!tz) return { ok: false, error: 'active_hours.tz is required (an IANA zone like "America/New_York")' };
  if (!isTimeZone(tz)) return { ok: false, error: `active_hours.tz "${tz}" is not a time zone this system knows` };
  const value: ActiveHours = { start: clockText(start), end: clockText(end), tz };
  if (row.days !== undefined && row.days !== null) {
    if (!Array.isArray(row.days)) return { ok: false, error: 'active_hours.days must be a list like ["mon", "tue"]' };
    const picked = new Set<ActiveDay>();
    for (const d of row.days) {
      const key = String(d ?? "").trim().toLowerCase() as ActiveDay;
      if (!ACTIVE_DAYS.includes(key)) {
        return { ok: false, error: `active_hours.days: "${String(d)}" is not one of ${ACTIVE_DAYS.join(", ")}` };
      }
      picked.add(key);
    }
    if (!picked.size) return { ok: false, error: "active_hours.days is empty; omit it for every day" };
    if (picked.size < 7) value.days = ACTIVE_DAYS.filter((d) => picked.has(d));
  }
  return { ok: true, value };
}

/** A stored window, or null when there is none or it does not validate. */
export function normalizeActiveHours(raw: unknown, fallbackZone?: string): ActiveHours | null {
  const parsed = parseActiveHours(raw, fallbackZone ? { defaultTimeZone: fallbackZone } : {});
  return parsed.ok ? parsed.value : null;
}

/**
 * The first instant whose wall time in `zone` is at or after `t` on `key`.
 * Normally the one instant for that wall time (the earlier of two on a DST
 * fall-back day). Inside a spring-forward gap the wall time never happens, and
 * the window opens (or closes) at the end of the gap: a 02:30 start on that
 * day opens at 03:00, not at 03:30.
 */
function wallAtOrAfter(key: string, t: TimeOfDay, zone: string): number {
  const exact = localDateTimeInstants(key, t, zone);
  if (exact[0] !== undefined) return exact[0];
  const [year, month, day] = numbersFromKey(key);
  const target = Date.UTC(year, month - 1, day, t.hour, t.minute, 0, 0);
  let hi = localDateTimeToMillis(key, t, zone);
  let lo = hi - 3 * 3600_000;
  while (hi - lo > 60_000) {
    const mid = lo + Math.max(60_000, Math.floor((hi - lo) / 120_000) * 60_000);
    if (wallMillis(localParts(mid, zone)) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function windowDayAllowed(ah: ActiveHours, key: string): boolean {
  if (!ah.days) return true;
  const dow = localWeekdayFromKey(key, ah.tz);
  const name = ACTIVE_DAYS[dow];
  return name !== undefined && ah.days.includes(name);
}

/** [open, close) of the window that opens on local day `key`. */
function windowOn(ah: ActiveHours, key: string): { open: number; close: number } {
  const start = parseClock(ah.start)!;
  const end = parseClock(ah.end)!;
  const crosses = end.hour * 60 + end.minute <= start.hour * 60 + start.minute;
  return {
    open: wallAtOrAfter(key, start, ah.tz),
    close: wallAtOrAfter(crosses ? addLocalDays(key, 1) : key, end, ah.tz),
  };
}

/** True when `now` falls inside the window (always true when there is none). */
export function inActiveHours(raw: unknown, now: TimeInput, fallbackZone?: string): boolean {
  const ah = normalizeActiveHours(raw, fallbackZone);
  if (!ah) return true;
  const current = asMillis(now);
  const today = localDateKey(localParts(current, ah.tz));
  // A window that crosses midnight and opened yesterday may still be open.
  for (const key of [addLocalDays(today, -1), today]) {
    if (!windowDayAllowed(ah, key)) continue;
    const w = windowOn(ah, key);
    if (w.open <= current && current < w.close) return true;
  }
  return false;
}

/**
 * When the window is next open: `now` itself when it is open now, else the
 * next opening. null only for a window with no day that ever opens.
 */
export function nextActiveStart(raw: unknown, now: TimeInput, fallbackZone?: string): number | null {
  const current = asMillis(now);
  const ah = normalizeActiveHours(raw, fallbackZone);
  if (!ah || inActiveHours(ah, current)) return current;
  let key = localDateKey(localParts(current, ah.tz));
  for (let i = 0; i < 9; i++) {
    if (windowDayAllowed(ah, key)) {
      const { open, close } = windowOn(ah, key);
      // `open < close`: a window that collapses to nothing (02:00-03:00 on a
      // spring-forward day) never opens.
      if (open > current && open < close) return open;
    }
    key = addLocalDays(key, 1);
  }
  return null;
}

/** "08:00-20:00 America/New_York" plus ", mon tue wed" when limited to days. */
export function activeHoursLabel(raw: unknown): string {
  const ah = normalizeActiveHours(raw);
  if (!ah) return "";
  return `${ah.start}-${ah.end} ${ah.tz}${ah.days ? `, ${ah.days.join(" ")}` : ""}`;
}

function hoursSuffix(r: Routine): string {
  const label = activeHoursLabel(r.activeHours);
  return label ? ` (active ${label} only)` : "";
}

/** When the cadence alone would fire next, ignoring the window. */
export function cadenceNextRunAt(routine: Routine | null | undefined, now: TimeInput, timeZone?: string): number | null {
  if (!routine) return null;
  const current = asMillis(now);
  const list = Array.isArray(routine.triggers) && routine.triggers.length
    ? routine.triggers.map(normalizeTrigger).filter((t): t is Trigger => t !== null)
    : [];
  if (list.length) {
    let best: number | null = null;
    for (const t of list) {
      let next: number | null;
      if (isElapsedTrigger(t)) next = t.lastRunAt > 0 ? t.lastRunAt + (t.intervalMs || 3600_000) : current;
      else if (t.nextRunAt !== null && Number.isFinite(t.nextRunAt) && t.nextRunAt > 0) next = t.nextRunAt;
      else next = nextTriggerOccurrence(t, current, timeZone);
      if (next !== null && (best === null || next < best)) best = next;
    }
    return best;
  }
  if (isCalendarRoutine(routine)) return calendarNextRunAt(routine, current, timeZone);
  const interval = Number(routine.intervalMs);
  if (interval > 0) return routine.lastRunAt ? routine.lastRunAt + interval : current;
  return null;
}

/**
 * When the routine will actually fire next: the cadence's next fire (now, if
 * it is overdue), moved to the window's next opening when that falls outside
 * the active hours.
 */
export function routineNextRunAt(routine: Routine | null | undefined, now: TimeInput, timeZone?: string): number | null {
  const current = asMillis(now);
  const next = cadenceNextRunAt(routine, current, timeZone);
  if (next === null) return null;
  const at = Math.max(next, current);
  const ah = normalizeActiveHours(routine?.activeHours, timeZone);
  if (!ah || inActiveHours(ah, at)) return at;
  return nextActiveStart(ah, at);
}

/**
 * A due fire outside the window: move it to the window's next opening instead
 * of starting a turn. Returns true when the row changed.
 *
 * Clock triggers (daily, weekly, cron, once...) carry `nextRunAt`, so the
 * held fire is written there and fires at the opening; `advanceTrigger` then
 * resumes the normal cadence. Elapsed triggers (hourly, interval) and legacy
 * `intervalMs` rows need nothing stored: they stay due by their own clock and
 * `dueRoutines` keeps them closed until the window opens. A legacy calendar
 * row (`schedule` + `nextRunAt`) is moved onto its equivalent daily trigger,
 * because `calendarNextRunAt` would otherwise snap a held time back to the
 * schedule's own wall time and the day's fire would be lost.
 */
export function holdOutsideActiveHours(routine: Routine | null | undefined, now: TimeInput, timeZone?: string): boolean {
  if (!routine || routine.enabled === false) return false;
  const ah = normalizeActiveHours(routine.activeHours, timeZone);
  if (!ah) return false;
  const current = asMillis(now);
  if (inActiveHours(ah, current)) return false;
  const open = nextActiveStart(ah, current);
  if (open === null) return false;
  if (Array.isArray(routine.triggers) && routine.triggers.length) {
    let changed = false;
    for (const t of routine.triggers) {
      const row = normalizeTrigger(t);
      if (!row || isElapsedTrigger(row)) continue;
      if (!triggerDue(row, current, timeZone)) continue;
      if (t.nextRunAt !== open) {
        t.nextRunAt = open;
        changed = true;
      }
    }
    return changed;
  }
  if (isCalendarRoutine(routine)) {
    const next = calendarNextRunAt(routine, current, timeZone);
    if (next !== null && current >= next) {
      routine.triggers = triggersOf(routine).map((t) => ({ ...t, id: t.id || randomUUID(), nextRunAt: open }));
      return true;
    }
  }
  return false;
}

/**
 * After the window changes (set, moved or cleared), drop any fire held for the
 * old window: each clock trigger goes back to the cadence's next occurrence
 * after its last fire. One that is overdue fires now (or is held again for the
 * new window on the next tick).
 */
export function rebaseHeldTriggers(routine: Routine | null | undefined, now: TimeInput, timeZone?: string): void {
  if (!routine || !Array.isArray(routine.triggers)) return;
  const current = asMillis(now);
  for (const t of routine.triggers) {
    const row = normalizeTrigger(t);
    if (!row || isElapsedTrigger(row)) continue;
    const base = row.lastRunAt > 0 ? row.lastRunAt : current;
    t.nextRunAt = nextTriggerOccurrence(row, base, timeZone, { inclusive: row.lastRunAt <= 0 });
  }
}
