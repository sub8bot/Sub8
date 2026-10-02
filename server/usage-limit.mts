/**
 * Harness usage limits ("You've hit your weekly limit · resets Oct 3, 4pm (UTC)").
 *
 * A subscription out of quota answers every turn in a second with the same
 * line. With a routine on a short clock that line was posted again and again
 * (KekiusBot: 60+ identical rows in two days), pushing the real conversation
 * out of the window while every fire spent a CLI start for nothing. This module
 * reads the line, and keeps the per-bot record that lets routines wait for the
 * reset and the user see one notice per condition.
 *
 * The Worker keeps a copy of the parser (cloud/src/usage-limit.ts); it cannot
 * import from this tree. Keep the two in step.
 */

export interface ParsedUsageLimit {
  /** Epoch ms when the harness says the quota comes back (best effort). */
  until: number;
  /** The harness's own line, for the one notice the user sees. */
  message: string;
}

/** What a bot row remembers about the limit its identity hit. */
export interface BotUsageLimit extends ParsedUsageLimit {
  /** When it was first seen. */
  at: number;
  /** The identity and provider the limit belongs to. Another one is another quota. */
  identityId: string;
  provider: string;
}

/** Longest reply that can be a bare limit notice. A bot narrating a site's rate limit is not one. */
const MAX_NOTICE_CHARS = 600;
/** When the reset time cannot be read: look again in an hour. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;
/** No harness quota window is longer than a week; never park a routine longer. */
const MAX_PARK_MS = 8 * 24 * 60 * 60 * 1000;

export const USAGE_LIMIT_RE =
  /\b(?:you(?:'|’)?ve|you have)\s+(?:hit|reached|used up)\s+your\s+(?:[a-z0-9-]+\s+){0,3}(?:usage\s+)?limit\b|\b(?:usage|weekly|daily|session|hourly|5-hour|five-hour|opus|sonnet)\s+limit\s+(?:reached|exceeded|hit)\b|\bclaude ai usage limit reached\b|\bout of (?:extra )?usage\b/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Offset of `timeZone` from UTC at `epoch`, in ms. Unknown zones read as UTC. */
function zoneOffsetMs(epoch: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(epoch));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value || 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return asUtc - Math.floor(epoch / 1000) * 1000;
  } catch {
    return 0;
  }
}

function zonedEpoch(y: number, mon: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, mon, d, h, min);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

function todayIn(now: number, timeZone: string): { y: number; mon: number; d: number } {
  const local = new Date(now + zoneOffsetMs(now, timeZone));
  return { y: local.getUTCFullYear(), mon: local.getUTCMonth(), d: local.getUTCDate() };
}

/** Read "resets Oct 3, 4pm (UTC)" / "resets 4pm (UTC)" / "...|1759507200". 0 when unreadable. */
export function parseResetAt(text: string, now: number = Date.now()): number {
  const raw = String(text || "");
  const epoch = /\|\s*(\d{10,13})\b/.exec(raw);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const m = /\bresets?\s+(?:at\s+|on\s+)?([^\n(]*?)\s*(?:\(([^)]+)\))?\s*(?:[.\n]|$)/i.exec(raw);
  if (!m) return 0;
  const when = String(m[1] || "").trim();
  const zone = String(m[2] || "UTC").trim() || "UTC";
  const timeZone = /^utc$|^gmt$/i.test(zone) ? "UTC" : zone;
  const t = /(?:\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(when);
  if (!t) return 0;
  let hour = Number(t[3]);
  const minute = Number(t[4] || 0);
  const ampm = String(t[5] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return 0;
  const today = todayIn(now, timeZone);
  const monIdx = t[1] ? MONTHS.indexOf(t[1].toLowerCase()) : -1;
  if (t[1] && monIdx < 0) return 0;
  if (monIdx >= 0) {
    const day = Number(t[2]);
    let at = zonedEpoch(today.y, monIdx, day, hour, minute, timeZone);
    if (at < now - 12 * 60 * 60 * 1000) at = zonedEpoch(today.y + 1, monIdx, day, hour, minute, timeZone);
    return at;
  }
  let at = zonedEpoch(today.y, today.mon, today.d, hour, minute, timeZone);
  if (at <= now) at = zonedEpoch(today.y, today.mon, today.d + 1, hour, minute, timeZone);
  return at;
}

/** True for a bare quota line. */
export function isUsageLimitNotice(text: unknown): boolean {
  const raw = String(text || "").trim();
  return raw.length > 0 && raw.length <= MAX_NOTICE_CHARS && USAGE_LIMIT_RE.test(raw);
}

/** A reply that is a harness usage-limit notice, or null. */
export function parseUsageLimit(text: unknown, now: number = Date.now()): ParsedUsageLimit | null {
  const raw = String(text || "").trim();
  if (!isUsageLimitNotice(raw)) return null;
  const reset = parseResetAt(raw, now);
  const until = reset > now ? Math.min(reset, now + MAX_PARK_MS) : now + UNKNOWN_RESET_MS;
  const message = raw.replace(/\|\s*\d{10,13}\b/, "").split("\n")[0]!.trim().slice(0, 240);
  return { until, message };
}

/** As much of a bot row as the limit checks read. */
export interface LimitBot {
  identityId?: string | undefined;
  harness?: { provider?: string | undefined } | null | undefined;
  usageLimit?: BotUsageLimit | null | undefined;
}

/**
 * The limit that still applies to this bot, or null: none on record, past its
 * reset, or recorded for an identity/provider the bot no longer uses (the user
 * switched it, which is exactly the "keep going" answer).
 */
export function activeBotLimit(bot: LimitBot | null | undefined, now: number = Date.now()): BotUsageLimit | null {
  const lim = bot?.usageLimit;
  if (!lim || !(Number(lim.until) > now)) return null;
  if (String(lim.identityId || "") !== String(bot?.identityId || "")) return null;
  if (String(lim.provider || "") !== String(bot?.harness?.provider || "")) return null;
  return lim;
}

/** The one line a paused routine leaves in the thread. */
export function routinePausedNotice(state: ParsedUsageLimit, now: number = Date.now()): string {
  const resume =
    state.until > now
      ? ` They resume after ${new Date(state.until).toISOString().replace("T", " ").slice(0, 16)} UTC,`
      : " They resume when it resets,";
  return `${state.message}\n\nI paused my routines until the limit resets.${resume} or as soon as you switch me to another identity.`;
}
