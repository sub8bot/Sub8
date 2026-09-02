/**
 * Spend guard for standing routines.
 *
 * Today routines fire on their schedule no matter what — so a bot can burn
 * turns (and cloud/model spend) for hours while nobody is watching. This mirrors
 * the "you've been away — keep routines running?" safety valve: when the user
 * has been away past a threshold AND routines have fired more than a budget in
 * the recent window, pause automation and nudge once. The user's next
 * interaction auto-resumes (they're back); an explicit "Pause all" stays off
 * until they explicitly resume.
 *
 * Pure, injectable state so it unit-tests without a clock or the server.
 */
export interface SpendGuardConfig {
  awayMs: number;
  windowMs: number;
  maxFiresPerWindow: number;
  renudgeMs: number;
}

export const DEFAULT_CONFIG: SpendGuardConfig = {
  awayMs: 30 * 60_000, // "away" after 30 min with no interaction
  windowMs: 60 * 60_000, // budget measured over the last hour
  maxFiresPerWindow: 12, // more than this while away → pause + nudge
  renudgeMs: 30 * 60_000, // do not re-nudge more than twice an hour
};

let cfg: SpendGuardConfig = { ...DEFAULT_CONFIG };
let lastUserActivityAt = Date.now();
let fireTimes: number[] = [];
let pausedByGuard = false;
let pausedByUser = false;
let lastNudgeAt = 0;

export function configure(partial: Partial<SpendGuardConfig> = {}): void {
  cfg = { ...cfg, ...partial };
}

export function resetForTest(partial: Partial<SpendGuardConfig> = {}, now = Date.now()): void {
  cfg = { ...DEFAULT_CONFIG, ...partial };
  lastUserActivityAt = now;
  fireTimes = [];
  pausedByGuard = false;
  pausedByUser = false;
  lastNudgeAt = 0;
}

/** The user did something — reset the away clock and lift a guard pause. */
export function noteUserActivity(now = Date.now()): void {
  lastUserActivityAt = now;
  pausedByGuard = false;
}

export function noteFire(now = Date.now()): void {
  fireTimes.push(now);
}

export function firesInWindow(now = Date.now()): number {
  fireTimes = fireTimes.filter((t) => now - t < cfg.windowMs);
  return fireTimes.length;
}

export function isAway(now = Date.now()): boolean {
  return now - lastUserActivityAt > cfg.awayMs;
}

export function isPaused(): boolean {
  return pausedByGuard || pausedByUser;
}

/** "Pause all" from the nudge card — stays off until an explicit resume. */
export function pauseByUser(): void {
  pausedByUser = true;
}

/** "Keep running" / explicit resume — clear both pause flags. */
export function resume(now = Date.now()): void {
  pausedByGuard = false;
  pausedByUser = false;
  lastNudgeAt = 0;
  lastUserActivityAt = now;
}

export interface Snapshot {
  away: boolean;
  paused: boolean;
  pausedByUser: boolean;
  firesInWindow: number;
  lastUserActivityAt: number;
  config: SpendGuardConfig;
}

export function snapshot(now = Date.now()): Snapshot {
  return {
    away: isAway(now),
    paused: isPaused(),
    pausedByUser,
    firesInWindow: firesInWindow(now),
    lastUserActivityAt,
    config: { ...cfg },
  };
}

export type GuardAction = "fire" | "skip-paused" | "nudge";

/**
 * What to do about a routine that is due right now. The caller fires only on
 * "fire" (and calls noteFire), posts the nudge card on "nudge", and skips on
 * "skip-paused". "nudge" is returned at most once per renudge window and flips
 * the guard to paused.
 */
export function decide(now = Date.now()): { action: GuardAction; reason: string } {
  if (isPaused()) return { action: "skip-paused", reason: pausedByUser ? "paused by you" : "paused (awaiting your answer)" };
  if (isAway(now) && firesInWindow(now) >= cfg.maxFiresPerWindow) {
    if (now - lastNudgeAt >= cfg.renudgeMs) {
      lastNudgeAt = now;
      pausedByGuard = true;
      return { action: "nudge", reason: `${firesInWindow(now)} routine runs in the last hour while you were away` };
    }
    pausedByGuard = true;
    return { action: "skip-paused", reason: "awaiting your answer" };
  }
  return { action: "fire", reason: "" };
}
