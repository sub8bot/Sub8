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

export function isWeakRoutineInstruction(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (WEAK_JOB.test(t)) return true;
  if (t.length < 20 && !parseSchedule(t)) return true;
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
  if (/\b(every|each)\s+morning\b/.test(t)) return { intervalMs: 86400_000, label: "Daily morning" };
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

export function overlappingRoutine(bot, spec = {}) {
  const rows = bot?.routines || [];
  const key = spec.groupKey || groupKey(spec.instruction || spec.name || "");
  const parsed = parseSchedule(spec.instruction || spec.name || "");
  const intervalMs = spec.intervalMs || parsed?.intervalMs || 20 * 60_000;
  return (
    rows.find((r) => r.id !== spec.id && r.groupKey === key && similarInterval(r.intervalMs || intervalMs, intervalMs)) ||
    rows.find((r) => r.id !== spec.id && similarInterval(r.intervalMs || intervalMs, intervalMs)) ||
    null
  );
}

export function upsertRoutine(bot, spec) {
  if (!bot) throw new Error("upsertRoutine: bot missing");
  if (!Array.isArray(bot.routines)) bot.routines = [];
  const text = String(spec.instruction || spec.name || "").trim();
  const key = spec.groupKey || "general";
  const parsed = parseSchedule(text);
  const intervalMs = spec.intervalMs || parsed?.intervalMs || 20 * 60_000;
  const creating = !spec.id && !(bot.routines || []).length;
  if (creating && isWeakRoutineInstruction(text) && spec.forceNew !== true) {
    return {
      routine: null,
      merged: false,
      rejected: "need a standing job (what to watch, and how often), not a chat one-liner",
    };
  }
  const byId = spec.id ? bot.routines.find((r) => r.id === spec.id) : null;
  const primary = bot.routines.find((r) => r.groupKey === "general") || bot.routines[0] || null;
  const overlap = overlappingRoutine(bot, { ...spec, groupKey: key, intervalMs });
  if (spec.forceNew && overlap) {
    return {
      routine: overlap,
      merged: false,
      rejected: `overlaps "${overlap.name}" (${overlap.id}) every ${Math.round((overlap.intervalMs || intervalMs) / 60000)} min. Update that id instead of creating a second job.`,
    };
  }
  const existing = byId || (!spec.forceNew && (overlap || primary)) || null;
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
    if (Number.isFinite(intervalMs) && intervalMs > 0) existing.intervalMs = intervalMs;
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
    intervalMs,
    enabled: spec.enabled !== false,
    lastRunAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  bot.routines.push(routine);
  return { routine, merged: false };
}

export function dueRoutines(bot, now = Date.now()) {
  return (bot.routines || []).filter((r) => r.enabled !== false && now - (r.lastRunAt || 0) >= r.intervalMs);
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

export function promptBlock(bot, { compact = false } = {}) {
  const rows = (bot.routines || []).filter((r) => r.enabled !== false);
  if (!rows.length) return "";
  const lines = compact
    ? rows.map((r) => `- [${r.groupKey}] ${r.name} every ${Math.round(r.intervalMs / 60000)} min. The current user task is this job — do not paste the brief back.`)
    : rows.map(
        (r) =>
          `- [${r.groupKey}] ${r.name} every ${Math.round(r.intervalMs / 60000)} min: ${r.instruction.replace(/\n/g, " | ")}`,
      );
  return [
    "",
    "## Standing routines (master schedule)",
    "These fire automatically. You MAY edit them: list_routines, then upsert_routine with that id. When the operator asks to change the routine, that IS permission — pass the full new brief and force_replace. Default is ONE standing job. Do not create a second routine that overlaps (same group or a similar interval); update the existing id instead. Instruction text must be a standing brief, never a chat one-liner.",
    ...lines,
    "",
  ].join("\n");
}
