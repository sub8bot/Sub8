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
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi / lo <= 2.5;
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
  const sameGroup = bot.routines.find(
    (r) => r.groupKey === key && similarInterval(r.intervalMs || intervalMs, intervalMs),
  );
  const existing = byId || (!spec.forceNew && primary) || sameGroup;
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

export function promptBlock(bot) {
  const rows = (bot.routines || []).filter((r) => r.enabled !== false);
  if (!rows.length) return "";
  return [
    "",
    "## Standing routines (master schedule)",
    "These fire automatically. Default is ONE standing routine. Update that routine (same id) when the mission changes. Only create another if the user explicitly asks for a second job. Instruction text must be a standing brief (who you are, current mission, workspace paths, next checkpoint) — never a paste of the user's last chat line.",
    ...rows.map(
      (r) =>
        `- [${r.groupKey}] ${r.name} every ${Math.round(r.intervalMs / 60000)} min: ${r.instruction.replace(/\n/g, " | ")}`
    ),
    "",
  ].join("\n");
}
