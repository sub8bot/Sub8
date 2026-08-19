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
const ONE_SHOT_PHRASE =
  /\bcheck\s+back\b|\b(?:check|try|look|do|run)(?:\s+(?:it|that|this))?\s+again\b|\b(?:resume|continue|keep going)\b/i;
const CLOCK_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const CLOCK_VALUE = `(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|ish)?|${CLOCK_WORDS}|noon|midnight|half\\s+past\\s+(?:${CLOCK_WORDS}|\\d{1,2}))`;
const MORNING_TIME =
  new RegExp(
    `\\b(?:at|around|by|before|after|until)\\s+${CLOCK_VALUE}\\b|` +
      `\\b(?:in|until|before|after)\\s+(?:the\\s+)?(?:am|pm|noon|midnight)\\b|` +
      `\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b|\\b(?:noon|midnight)\\b|` +
      `\\b(?:${CLOCK_WORDS})\\s+o['’]?clock\\b|` +
      `\\b(?:every|each)\\s+morning\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|ish)?\\b|` +
      `\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|ish)?\\s+(?:every|each)\\s+morning\\b|` +
      `\\b(?:every|each)\\s+morning\\s+(?:${CLOCK_WORDS}|half\\s+past\\s+(?:${CLOCK_WORDS}|\\d{1,2}))\\b|` +
      `\\b(?:${CLOCK_WORDS})\\s+(?:every|each)\\s+morning\\b`,
    "i",
  );

const MORNING_SCHEDULE = Object.freeze({ type: "daily", hour: 9, minute: 0 });

function blockedMorningInstruction(text) {
  const t = String(text || "");
  if (!/\b(every|each)\s+morning\b/i.test(t)) return false;
  return morningQuestionOrNegation(t) || MORNING_TIME.test(t);
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

export function isWeakRoutineInstruction(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (WEAK_JOB.test(t)) return true;
  if (ONE_SHOT_PHRASE.test(t)) return true;
  if (t.length < 20 && !parseSchedule(t)) return true;
  return false;
}

export function isRejectedRoutineInstruction(text, { explicitInterval = false } = {}) {
  if (isWeakRoutineInstruction(text)) return true;
  const allowUnsupportedMorningClock = explicitInterval && MORNING_TIME.test(String(text || "")) && !morningQuestionOrNegation(text);
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
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
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
  const expected = nextCalendarOccurrence(current, schedule, timeZone);
  if (routine.nextRunTimeZone && timeZone && routine.nextRunTimeZone !== timeZone) return expected;
  const next = Number(routine.nextRunAt);
  if (!Number.isFinite(next) || next <= 0) return expected;
  const local = localParts(next, timeZone);
  const wallClockMatches = local.hour === schedule.hour && local.minute === schedule.minute && local.second === 0;
  // A spring-forward gap may normalize a requested local time to the first valid time after it.
  const normalizedGapMatches = localDateTimeToMillis(localDateKey(local), schedule, timeZone) === next;
  if (!wallClockMatches && !normalizedGapMatches) return expected;
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
  const schedule = normalizeSchedule(routine?.schedule);
  if (schedule) return scheduleLabel(schedule, timeZone);
  return `Every ${Math.round((routine?.intervalMs || 0) / 60000)} min`;
}

export function upsertRoutine(bot, spec) {
  if (!bot) throw new Error("upsertRoutine: bot missing");
  if (!Array.isArray(bot.routines)) bot.routines = [];
  const text = String(spec.instruction || spec.name || "").trim();
  const explicitInterval = Number.isFinite(Number(spec.intervalMs)) && Number(spec.intervalMs) > 0 ? Number(spec.intervalMs) : null;
  if (isRejectedRoutineInstruction(text, { explicitInterval: Boolean(explicitInterval) })) {
    return {
      routine: null,
      merged: false,
      rejected: "need a standing job (what to watch, and how often), not a chat or one-shot instruction",
    };
  }
  const key = spec.groupKey || "general";
  const parsed = parseSchedule(text);
  const schedule = explicitInterval ? null : normalizeSchedule(spec.schedule || parsed?.schedule);
  const intervalMs = explicitInterval || (!schedule ? parsed?.intervalMs || 20 * 60_000 : null);
  const byId = spec.id ? bot.routines.find((r) => r.id === spec.id) : null;
  if (spec.id && !byId) {
    return { routine: null, merged: false, rejected: "routine not found" };
  }
  const primary = bot.routines.find((r) => r.groupKey === "general") || bot.routines[0] || null;
  const sameGroup = bot.routines.find((r) => {
    if (r.groupKey !== key) return false;
    const existingSchedule = normalizeSchedule(r.schedule);
    return schedule
      ? sameSchedule(existingSchedule, schedule)
      : !existingSchedule && similarInterval(r.intervalMs || intervalMs, intervalMs);
  });
  const existing = byId || (!spec.forceNew && primary) || (!spec.forceNew && sameGroup);
  if (existing) {
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
      // A standing brief update must not downgrade a calendar routine to 20 minutes.
      if (spec.timeZone) existing.nextRunAt = calendarNextRunAt(existing, spec.now ?? Date.now(), spec.timeZone);
      if (spec.timeZone) existing.nextRunTimeZone = spec.timeZone;
    } else if (!explicitInterval && !parsed?.intervalMs && Number.isFinite(existing.intervalMs) && existing.intervalMs > 0) {
      // Keep legacy elapsed cadence when only the standing brief changes.
    } else {
      delete existing.schedule;
      delete existing.nextRunAt;
      delete existing.nextRunTimeZone;
      if (Number.isFinite(intervalMs) && intervalMs > 0) existing.intervalMs = intervalMs;
    }
    if (spec.name) existing.name = spec.name;
    if (spec.groupKey) existing.groupKey = spec.groupKey;
    if (typeof spec.enabled === "boolean") existing.enabled = spec.enabled;
    else if (existing.enabled === false && !spec.forceNew) existing.enabled = true;
    existing.updatedAt = Date.now();
    if (spec.solo !== false && !spec.forceNew) {
      bot.routines = bot.routines.filter((r) => r.id === existing.id);
    }
    return { routine: existing, merged: true };
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
  bot.routines.push(routine);
  return { routine, merged: false };
}

export function dueRoutines(bot, now = Date.now(), { timeZone } = {}) {
  return (bot.routines || []).filter((r) => {
    if (r.enabled === false) return false;
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
    "These fire automatically. Default is ONE standing routine. Update that routine (same id) when the mission changes. Only create another if the user explicitly asks for a second job. Instruction text must be a standing brief (who you are, current mission, workspace paths, next checkpoint) — never a paste of the user's last chat line.",
    ...lines,
    "",
  ].join("\n");
}
