import { randomUUID } from "node:crypto";

const GROUPS = [
  { key: "x-inbox", label: "X inbox", re: /\b(x\.com|\bx\b|twitter|tweet|notifications?|mentions?|dms?|direct messages?|private messages?)\b/i },
  { key: "email", label: "Email", re: /\b(email|gmail|inbox|mail)\b/i },
  { key: "flights", label: "Flights", re: /\b(flight|airfare|airline)\b/i },
  { key: "calendar", label: "Calendar", re: /\b(calendar|meetings?|schedule)\b/i },
  { key: "files", label: "Files", re: /\b(files?|downloads?|folder)\b/i },
];

export function groupKey(text) {
  const hit = GROUPS.find((g) => g.re.test(text));
  return hit ? hit.key : "general";
}

export function groupLabel(key) {
  return GROUPS.find((g) => g.key === key)?.label || "General";
}

const WEAK_JOB =
  /^(check again|check back|try again|look again|do it again|keep going|resume|continue|ok|okay|so)[\s.!?]*$/i;
const ONE_SHOT_NEAR_START =
  /^[\s\S]{0,60}?\b(?:check\s+back|(?:check|try|look|do|run)(?:\s+(?:it|that|this))?\s+again|resume|keep going)\b/i;
const CLOCK_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const CLOCK_TOKEN = `(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|ish)?|${CLOCK_WORDS}|noon|midnight|half\\s+past\\s+(?:${CLOCK_WORDS}|\\d{1,2}))`;
const MORNING_PHRASE = /\b(?:every|each)\s+morning\b/gi;

const MORNING_SCHEDULE = Object.freeze({ type: "daily", hour: 9, minute: 0 });

function morningClockAttached(text) {
  const t = String(text || "");
  const re = new RegExp(MORNING_PHRASE.source, "gi");
  let m;
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

function blockedMorningInstruction(text) {
  const t = String(text || "");
  if (!/\b(every|each)\s+morning\b/i.test(t)) return false;
  return morningQuestionOrNegation(t) || morningClockAttached(t);
}

function morningQuestionOrNegation(text) {
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

function isOneShotInstruction(text) {
  const t = String(text || "").trim();
  if (WEAK_JOB.test(t)) return true;
  if (ONE_SHOT_NEAR_START.test(t) && t.length < 220) return true;
  return false;
}

export function isWeakRoutineInstruction(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (isOneShotInstruction(t)) return true;
  if (t.length < 20 && !parseSchedule(t)) return true;
  return false;
}

export function isRejectedRoutineInstruction(text, { explicitInterval = false } = {}) {
  if (isWeakRoutineInstruction(text)) return true;
  const allowUnsupportedMorningClock = explicitInterval && morningClockAttached(String(text || "")) && !morningQuestionOrNegation(text);
  if (blockedMorningInstruction(text) && !allowUnsupportedMorningClock) return true;
  if (parseSchedule(text) && !looksLikeSchedule(text)) return !allowUnsupportedMorningClock;
  return false;
}

export function parseSchedule(text) {
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

export function looksLikeChatLine(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t.length < 220 && !t.includes("\n")) return true;
  if (/^(ok|okay|hey|please|resume|continue|wtf|don't|dont|you should)\b/i.test(t) && t.length < 500) return true;
  return false;
}

export function looksLikeSchedule(text) {
  const t = String(text || "");
  if (isWeakRoutineInstruction(t)) return false;
  if (/[?]\s*$/.test(t)) return false;
  if (/^\s*(what|why|when|how|who|which|where)\b/i.test(t)) return false;
  if (/\b(?:what|why|when|how|who|which|where)\b.*\b(?:every|each|daily|weekly|hourly)\b/i.test(t)) return false;
  if (/^\s*(?:should|can|could|would|do|does|did|is|are|will|have|has)\b.*\b(?:every|each|daily|weekly|hourly)\b/i.test(t)) return false;
  if (/\b(?:every|each|daily|weekly|hourly)\b.*\b(?:what|why|when|how|who|which|where)\b/i.test(t)) return false;
  if (/\b(?:i\s+)?wonder\b.*\b(?:whether|if)\b.*\b(?:every|each|daily|weekly|hourly)\b/i.test(t)) return false;
  if (blockedMorningInstruction(t)) return false;
  if (/\b(update|edit|change|rewrite|which|list|have|having)\b.{0,40}\b(routine|cron|schedule)\b/i.test(t)) return false;
  if (/\b(routine details|cronjob|the routine)\b/i.test(t) && !/\bevery\s+\d+\s*(min|hour)/i.test(t)) return false;
  if (!parseSchedule(t)) return false;
  return /\b(every|hourly|daily|weekly|each day|once a day|each morning|every morning)\b/i.test(t);
}

function similarInterval(a, b) {
  const hi = Math.max(a || 0, b || 0);
  const lo = Math.min(a || 0, b || 0);
  if (!hi || !lo) return false;
  return hi / lo <= 2.5;
}

export function normalizeSchedule(value) {
  if (!value || value.type !== "daily") return null;
  const hour = value.hour;
  const minute = value.minute;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { type: "daily", hour, minute };
}

function sameSchedule(a, b) {
  return Boolean(a && b && a.type === b.type && a.hour === b.hour && a.minute === b.minute);
}

function timeZoneOrLocal(timeZone) {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function asMillis(value) {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.now();
}

function localParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneOrLocal(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function localDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function addLocalDays(key, days) {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function wallMillis(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
}

function localDateTimeToMillis(key, schedule, timeZone) {
  const [year, month, day] = key.split("-").map(Number);
  const targetWall = Date.UTC(year, month - 1, day, schedule.hour, schedule.minute, 0, 0);
  const offsets = new Set();
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
  if (exact.length) return exact[0].instant;
  const afterGap = candidates
    .filter((candidate) => candidate.wall > targetWall)
    .sort((a, b) => a.wall - b.wall || a.instant - b.instant);
  return (afterGap[0] || candidates[0]).instant;
}

export function nextCalendarOccurrence(now, schedule, timeZone, { inclusive = true } = {}) {
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

export function calendarNextRunAt(routine, now, timeZone) {
  const schedule = normalizeSchedule(routine?.schedule);
  if (!schedule) return null;
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

export function advanceCalendarRoutine(routine, now, timeZone) {
  const schedule = normalizeSchedule(routine?.schedule);
  if (!schedule) return null;
  routine.nextRunAt = nextCalendarOccurrence(now, schedule, timeZone, { inclusive: false });
  if (timeZone) routine.nextRunTimeZone = timeZone;
  return routine.nextRunAt;
}

export function isCalendarRoutine(routine) {
  return Boolean(normalizeSchedule(routine?.schedule));
}

export function hydrateRoutine(routine, now = Date.now(), timeZone) {
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

function clockLabel(schedule) {
  const hour = schedule.hour % 12 || 12;
  const suffix = schedule.hour >= 12 ? "PM" : "AM";
  return `${hour}:${String(schedule.minute).padStart(2, "0")} ${suffix}`;
}

export function scheduleLabel(schedule, timeZone = "") {
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return "";
  const zone = timeZone ? ` (${timeZone})` : "";
  return `Every day at ${clockLabel(normalized)}${zone}`;
}

export function cadenceLabel(routine, timeZone = "") {
  const list = triggersOf(routine);
  if (list.length) return list.map((t) => triggerLabel(t)).join(", ");
  const schedule = normalizeSchedule(routine?.schedule);
  if (schedule) return scheduleLabel(schedule, timeZone);
  return `Every ${Math.round((routine?.intervalMs || 0) / 60000)} min`;
}

function asInt(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function normalizeTimes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const hour = asInt(row?.hour, asInt(row?.h));
    const minute = asInt(row?.minute, asInt(row?.m, 0));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) continue;
    const key = `${hour}:${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hour, minute });
  }
  return out.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

function parseCronField(field, min, max, { sundaySeven = false } = {}) {
  const raw = String(field || "").trim();
  if (!raw) return null;
  const allowed = new Set();
  const add = (n) => {
    if (sundaySeven && n === 7) n = 0;
    if (n < min || n > max) return;
    allowed.add(n);
  };
  for (const part of raw.split(",")) {
    const stepMatch = part.match(/^(.*?)\/(\d+)$/);
    const body = stepMatch ? stepMatch[1] : part;
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

export function parseCron(expr) {
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

function localWeekdayFromKey(key, timeZone) {
  const ms = localDateTimeToMillis(key, { hour: 12, minute: 0 }, timeZone);
  const txt = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneOrLocal(timeZone),
    weekday: "short",
  }).format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(txt);
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextTimesOnDays(now, times, timeZone, { inclusive = true, matchDay } = {}) {
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

function cronMatchesKey(parsed, key, timeZone, hour, minute) {
  const [year, month, day] = key.split("-").map(Number);
  const dow = localWeekdayFromKey(key, timeZone);
  if (!parsed.minute.has(minute) || !parsed.hour.has(hour) || !parsed.month.has(month)) return false;
  const starDom = parsed.dom.size === 31;
  const starDow = parsed.dow.size === 7;
  const domOk = parsed.dom.has(day);
  const dowOk = parsed.dow.has(dow);
  if (!starDom && !starDow) return domOk || dowOk;
  return (starDom || domOk) && (starDow || dowOk);
}

export function nextCronOccurrence(now, expr, timeZone, { inclusive = false } = {}) {
  const parsed = parseCron(expr);
  if (!parsed) return null;
  const zone = timeZoneOrLocal(timeZone);
  const current = asMillis(now);
  const start = new Date(inclusive ? current : current + 60_000);
  start.setUTCSeconds(0, 0);
  let cursor = start.getTime();
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const parts = localParts(cursor, zone);
    const key = localDateKey(parts);
    if (cronMatchesKey(parsed, key, zone, parts.hour, parts.minute)) return cursor;
    cursor += 60_000;
  }
  return null;
}

export function normalizeTrigger(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").toLowerCase();
  const id = String(raw.id || "").trim() || null;
  const times = normalizeTimes(raw.times);
  const lastRunAt = Number(raw.lastRunAt);
  const nextRunAt = Number(raw.nextRunAt);
  const stamp = {
    lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : 0,
    nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : null,
  };
  if (kind === "hourly") return { id, kind: "hourly", intervalMs: 3600_000, ...stamp };
  if (kind === "interval") {
    const intervalMs = Number(raw.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < 60_000) return null;
    return { id, kind: "interval", intervalMs, ...stamp };
  }
  if (kind === "daily") {
    if (!times.length) return null;
    return { id, kind: "daily", times, ...stamp };
  }
  if (kind === "weekdays") {
    if (!times.length) return null;
    return { id, kind: "weekdays", times, ...stamp };
  }
  if (kind === "weekly") {
    const weekday = ((asInt(raw.weekday, 1) % 7) + 7) % 7;
    return { id, kind: "weekly", weekday, times: times.length ? times : [{ hour: 9, minute: 0 }], ...stamp };
  }
  if (kind === "monthly") {
    const monthDay = Math.min(31, Math.max(1, asInt(raw.monthDay, 1)));
    return { id, kind: "monthly", monthDay, times: times.length ? times : [{ hour: 9, minute: 0 }], ...stamp };
  }
  if (kind === "advanced") {
    const months = Array.isArray(raw.months)
      ? [...new Set(raw.months.map((n) => asInt(n)).filter((n) => n >= 1 && n <= 12))]
      : [];
    const days = raw.days === "weekdays" ? "weekdays" : "every";
    return {
      id,
      kind: "advanced",
      months,
      days,
      times: times.length ? times : [{ hour: 8, minute: 0 }],
      ...stamp,
    };
  }
  if (kind === "cron") {
    const cron = String(raw.cron || "").trim();
    if (!parseCron(cron)) return null;
    return { id, kind: "cron", cron, ...stamp };
  }
  return null;
}

export function triggerLabel(trigger) {
  const t = normalizeTrigger(trigger);
  if (!t) return "";
  const clocks = (t.times || []).map((x) => clockLabel(x));
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

export function triggersOf(routine) {
  if (Array.isArray(routine?.triggers) && routine.triggers.length) {
    return routine.triggers.map(normalizeTrigger).filter(Boolean);
  }
  const schedule = normalizeSchedule(routine?.schedule);
  if (schedule) return [{ kind: "daily", times: [{ hour: schedule.hour, minute: schedule.minute }], nextRunAt: routine.nextRunAt || null, lastRunAt: routine.lastRunAt || 0 }];
  if (Number(routine?.intervalMs) > 0) {
    const intervalMs = Number(routine.intervalMs);
    return [{ kind: intervalMs === 3600_000 ? "hourly" : "interval", intervalMs, lastRunAt: routine.lastRunAt || 0, nextRunAt: routine.nextRunAt || null }];
  }
  return [];
}

export function nextTriggerOccurrence(trigger, now, timeZone, { inclusive = true } = {}) {
  const t = normalizeTrigger(trigger);
  if (!t) return null;
  const current = asMillis(now);
  if (t.kind === "hourly" || t.kind === "interval") {
    const base = t.lastRunAt > 0 ? t.lastRunAt : current;
    const wait = t.intervalMs || 3600_000;
    const next = base + wait;
    if (inclusive) return next <= current ? current : next;
    return next <= current ? current + wait : next;
  }
  if (t.kind === "cron") return nextCronOccurrence(now, t.cron, timeZone, { inclusive });
  const times = t.times || [{ hour: 9, minute: 0 }];
  const matchDay = (key, zone) => {
    const dow = localWeekdayFromKey(key, zone);
    const [year, month, day] = key.split("-").map(Number);
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

export function triggerDue(trigger, now, timeZone) {
  const t = normalizeTrigger(trigger);
  if (!t) return false;
  const current = asMillis(now);
  if (t.kind === "hourly" || t.kind === "interval") {
    return current - (t.lastRunAt || 0) >= (t.intervalMs || 3600_000);
  }
  const next = Number.isFinite(t.nextRunAt) && t.nextRunAt > 0 ? t.nextRunAt : nextTriggerOccurrence(t, current, timeZone);
  return Number.isFinite(next) && current >= next;
}

export function advanceTrigger(trigger, now, timeZone) {
  const t = normalizeTrigger(trigger);
  if (!t) return trigger;
  const current = asMillis(now);
  t.lastRunAt = current;
  t.nextRunAt = nextTriggerOccurrence(t, current, timeZone, { inclusive: false });
  Object.assign(trigger, t);
  return trigger;
}

export function syncLegacyFromTriggers(routine, now = Date.now(), timeZone) {
  const list = (routine.triggers || []).map(normalizeTrigger).filter(Boolean);
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
    routine.schedule = { type: "daily", hour: only.times[0].hour, minute: only.times[0].minute };
    delete routine.intervalMs;
    routine.nextRunAt = nextTriggerOccurrence(only, now, timeZone);
    if (timeZone) routine.nextRunTimeZone = timeZone;
    return routine;
  }
  if (list.length) {
    delete routine.intervalMs;
    delete routine.schedule;
    delete routine.nextRunAt;
    delete routine.nextRunTimeZone;
  }
  return routine;
}

function cadenceOverlaps(row, spec) {
  const existingSchedule = normalizeSchedule(row?.schedule);
  const schedule = normalizeSchedule(spec?.schedule);
  if (existingSchedule && schedule) return sameSchedule(existingSchedule, schedule);
  if (existingSchedule || schedule) return false;
  return similarInterval(row?.intervalMs || spec?.intervalMs, spec?.intervalMs);
}

export function overlappingRoutine(bot, spec = {}) {
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

export function upsertRoutine(bot, spec) {
  if (!bot) throw new Error("upsertRoutine: bot missing");
  if (!Array.isArray(bot.routines)) bot.routines = [];
  const text = String(spec.instruction || spec.name || "").trim();
  let explicitInterval = Number.isFinite(Number(spec.intervalMs)) && Number(spec.intervalMs) > 0 ? Number(spec.intervalMs) : null;
  const key = spec.groupKey || "general";
  const parsed = parseSchedule(text);
  if (explicitInterval === 86400_000 && (parsed?.schedule || normalizeSchedule(spec.schedule))) {
    explicitInterval = null;
  }
  const rejectedNew = isRejectedRoutineInstruction(text, { explicitInterval: Boolean(explicitInterval) });
  const schedule = explicitInterval ? null : normalizeSchedule(spec.schedule || parsed?.schedule);
  const intervalMs = explicitInterval || (!schedule ? parsed?.intervalMs || 20 * 60_000 : null);
  const byId = spec.id ? bot.routines.find((r) => r.id === spec.id) : null;
  if (spec.id && !byId) {
    return { routine: null, merged: false, rejected: "routine not found" };
  }
  const creating = !spec.id && !(bot.routines || []).length;
  if (!byId && rejectedNew && (creating || spec.forceNew === true)) {
    return {
      routine: null,
      merged: false,
      rejected: "need a standing job (what to watch, and how often), not a chat or one-shot instruction",
    };
  }
  const overlap = overlappingRoutine(bot, { ...spec, groupKey: key, intervalMs, schedule });
  if (spec.forceNew && overlap) {
    return {
      routine: overlap,
      merged: false,
      rejected: `overlaps "${overlap.name}" (${overlap.id}) ${cadenceLabel(overlap).toLowerCase()}. Update that id instead of creating a second job.`,
    };
  }
  const primary = bot.routines.find((r) => r.groupKey === "general") || bot.routines[0] || null;
  const existing = byId || (!spec.forceNew && (overlap || primary)) || null;
  if (existing) {
    hydrateRoutine(existing, spec.now ?? Date.now(), spec.timeZone);
    if (text) {
      const prev = existing.instruction || "";
      const weak = isWeakRoutineInstruction(text);
      const casual = (looksLikeChatLine(text) || weak) && !parseSchedule(text);
      if ((weak || (casual && prev.length > 80)) && spec.forceReplace !== true) {
        existing.updatedAt = Date.now();
        if (typeof spec.enabled === "boolean") existing.enabled = spec.enabled;
        return { routine: existing, merged: true, rejected: "kept standing brief (refused casual rewrite)" };
      }
      if (spec.replace === false && prev) {
        if (!prev.includes(text)) existing.instruction = `${prev.trim()}\n\n${text}`;
      } else {
        existing.instruction = text;
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
    } else if (!explicitInterval && !parsed?.intervalMs && Number.isFinite(existing.intervalMs) && existing.intervalMs > 0) {
      /* No parsed cadence: leave schedule/intervalMs as stored. */
    } else {
      delete existing.schedule;
      delete existing.nextRunAt;
      delete existing.nextRunTimeZone;
      if (Number.isFinite(intervalMs) && intervalMs > 0) existing.intervalMs = intervalMs;
    }
    if (spec.name) existing.name = spec.name;
    if (spec.groupKey) existing.groupKey = spec.groupKey;
    if (Array.isArray(spec.triggers)) {
      existing.triggers = spec.triggers.map(normalizeTrigger).filter(Boolean).map((t) => ({
        ...t,
        id: t.id || randomUUID(),
        lastRunAt: t.lastRunAt || Date.now(),
      }));
      syncLegacyFromTriggers(existing, spec.now ?? Date.now(), spec.timeZone);
    }
    if (typeof spec.enabled === "boolean") existing.enabled = spec.enabled;
    else if (existing.enabled === false && !spec.forceNew) existing.enabled = true;
    existing.updatedAt = Date.now();
    if (spec.solo !== false && !spec.forceNew) {
      bot.routines = bot.routines.filter((r) => r.id === existing.id);
    }
    return { routine: existing, merged: true };
  }
  if (rejectedNew) {
    return {
      routine: null,
      merged: false,
      rejected: "need a standing job (what to watch, and how often), not a chat or one-shot instruction",
    };
  }
  const routine = {
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
  } else {
    routine.intervalMs = intervalMs;
  }
  if (Array.isArray(spec.triggers) && spec.triggers.length) {
    routine.triggers = spec.triggers.map(normalizeTrigger).filter(Boolean).map((t) => ({
      ...t,
      id: t.id || randomUUID(),
      lastRunAt: t.lastRunAt || Date.now(),
    }));
    syncLegacyFromTriggers(routine, spec.now ?? Date.now(), spec.timeZone);
  }
  bot.routines.push(routine);
  return { routine, merged: false };
}

export function dueRoutines(bot, now = Date.now(), { timeZone } = {}) {
  return (bot.routines || []).filter((r) => {
    hydrateRoutine(r, now, timeZone);
    if (r.enabled === false) return false;
    if (Array.isArray(r.triggers) && r.triggers.length) {
      return r.triggers.some((t) => triggerDue(t, now, timeZone));
    }
    const schedule = normalizeSchedule(r.schedule);
    if (schedule) {
      const next = calendarNextRunAt(r, now, timeZone);
      return Number.isFinite(next) && now >= next;
    }
    return now - (r.lastRunAt || 0) >= r.intervalMs;
  });
}

export function packDue(due) {
  const buckets = new Map();
  for (const r of due) {
    const k = r.groupKey || "general";
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  return [...buckets.values()].map((items) => ({
    groupKey: items[0].groupKey,
    name: items[0].name,
    ids: items.map((i) => i.id),
    instruction: items.map((i) => i.instruction).join("\n"),
  }));
}

export function promptBlock(bot, { compact = false, timeZone = "" } = {}) {
  const rows = (bot.routines || []).filter((r) => r.enabled !== false);
  if (!rows.length) return "";
  const lines = compact
    ? rows.map(
        (r) =>
          `- [${r.groupKey}] ${r.name} ${cadenceLabel(r, timeZone).toLowerCase()}. The current user task is this job — do not paste the brief back.`,
      )
    : rows.map(
        (r) =>
          `- [${r.groupKey}] ${r.name} ${cadenceLabel(r, timeZone).toLowerCase()}: ${r.instruction.replace(/\n/g, " | ")}`,
      );
  return [
    "",
    "## Standing routines (master schedule)",
    "These fire automatically. You MAY edit them: list_routines, then upsert_routine with that id. When the operator asks to change the routine, that IS permission — pass the full new brief and force_replace. Default is ONE standing job. Do not create a second routine that overlaps (same group or a similar interval); update the existing id instead. Instruction text must be a standing brief, never a chat one-liner.",
    ...lines,
    "",
  ].join("\n");
}
