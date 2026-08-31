// The switch between the two worlds the app can be looking at.
//
// Local: bots are Docker containers on this machine and their routines live in
// data/bots.json. Cloud: bots are screens on a shared desk and their routines
// live in Worker KV. isCloudPlace() is the branch that decides which, and
// nearly every painter and handler in the shell asks it.
//
// Every function here takes its world explicitly — `ctx` is the app's `state`
// object, and the desk list is passed in — so none of it reads a module global
// and all of it can be exercised without a browser.

/** A brain, wherever it is attached: on the bot, or shared on the draft. */
export interface Brain {
  connected?: boolean;
  grokSignedIn?: boolean;
  apiKeySet?: boolean;
}

export interface Account {
  enabled?: boolean;
  cloudProduct?: boolean;
  comingSoon?: boolean;
  view?: string;
  signedIn?: boolean;
  mockAuth?: boolean;
}

/** The app's `state`, narrowed to what this file is allowed to look at. */
export interface PlaceCtx {
  account?: Account | null;
  cloudDraft?: { brain?: Brain } | null;
}

export interface Desk {
  id?: string;
  status?: string;
  ipv4?: string;
}

export interface PlaceBot {
  id?: string;
  brain?: Brain;
  harness?: { signedIn?: boolean; apiKeySet?: boolean };
  teamRole?: string;
  computerId?: string;
  desk?: Desk;
  vm?: { computerId?: string; hint?: string; streamUrl?: string } | null;
}

export function cloudOn(ctx: PlaceCtx | null | undefined): boolean {
  return ctx?.account?.enabled === true;
}

export function cloudProductOn(ctx: PlaceCtx | null | undefined): boolean {
  return cloudOn(ctx) && ctx?.account?.cloudProduct === true;
}

/** Local "Move to Cloud" — SUB8_CLOUD product flag, and we are not already in Cloud. Packaged builds default the flag off. */
export function canMoveToCloud(ctx: PlaceCtx | null | undefined): boolean {
  return cloudProductOn(ctx) && !isCloudPlace(ctx);
}

export function cloudComingSoon(ctx: PlaceCtx | null | undefined): boolean {
  return cloudOn(ctx) && ctx?.account?.comingSoon === true;
}

/** A bot's own brain wins; otherwise the draft's shared brain answers for it. */
export function cloudBrainReady(ctx: PlaceCtx | null | undefined, bot: PlaceBot | null | undefined): boolean {
  const b = bot?.brain || ctx?.cloudDraft?.brain;
  return Boolean(b?.connected || b?.grokSignedIn || b?.apiKeySet || bot?.harness?.signedIn || bot?.harness?.apiKeySet);
}

/** Cloud has to be bought, chosen in the switcher, and signed into — all three. */
export function isCloudPlace(ctx: PlaceCtx | null | undefined) {
  return cloudProductOn(ctx) && ctx?.account?.view === "cloud" && ctx?.account?.signedIn;
}

/** Cloud against the real Worker, not the mock account used for local UI work. */
export function isLiveCloud(ctx: PlaceCtx | null | undefined) {
  return isCloudPlace(ctx) && !ctx?.account?.mockAuth;
}

function deskOf(bot: PlaceBot | null | undefined, computers: Desk[] | null | undefined): Desk | undefined {
  return bot?.desk || (computers || []).find((c) => c.id === bot?.computerId || c.id === bot?.vm?.computerId);
}

/** Local bots are always "ready"; a cloud bot needs a desk that is up and reachable. */
export function cloudDeskReady(
  ctx: PlaceCtx | null | undefined,
  bot: PlaceBot | null | undefined,
  computers: Desk[] | null | undefined,
): boolean {
  if (!isCloudPlace(ctx)) return true;
  const desk = deskOf(bot, computers);
  const st = desk?.status || bot?.vm?.hint || "";
  return (st === "assigned" || st === "warm") && Boolean(desk?.ipv4 || bot?.vm?.streamUrl);
}

export function cloudDeskIdOf(bot: PlaceBot | null | undefined): string {
  return bot?.computerId || bot?.vm?.computerId || bot?.desk?.id || "";
}

export function isCloudChief(bot: PlaceBot | null | undefined): boolean {
  if (!bot) return false;
  if (bot.teamRole === "chief") return true;
  const desk = cloudDeskIdOf(bot);
  return Boolean(desk && bot.id === `cloud-${desk}`);
}

// A Cloud routine arrives as {intervalMinutes, lastRun, nextRun}. Reshape it to
// the local routine fields the painter already understands (intervalMs,
// lastRunAt) so one renderer serves both places. lastRun/nextRun of 0 mean
// "never run" and must stay 0 — as a date they would read as 1970.
export interface CloudRoutine {
  id?: string;
  name?: string;
  instruction?: string;
  enabled?: boolean;
  botId?: string;
  intervalMinutes?: number;
  lastRun?: number;
  nextRun?: number;
}

/** The local routine shape the painter already understands. */
export interface NormalizedRoutine {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
  botId: string;
  intervalMinutes: number;
  intervalMs: number;
  lastRunAt: number;
  nextRunAt: number;
  cloud: true;
}

export function normalizeCloudRoutine(r: CloudRoutine | null | undefined): NormalizedRoutine | null {
  if (!r?.id) return null;
  const minutes = Math.max(5, Number(r.intervalMinutes) || 60);
  return {
    id: r.id,
    name: r.name || "Routine",
    instruction: r.instruction || "",
    enabled: r.enabled !== false,
    botId: r.botId || "",
    intervalMinutes: minutes,
    intervalMs: minutes * 60_000,
    lastRunAt: Number(r.lastRun) || 0,
    nextRunAt: Number(r.nextRun) || 0,
    cloud: true,
  };
}

// Cloud routines only fire on an interval — the Worker cron has no cron
// expression and floors the interval at 5 minutes. normalizeTrigger is the
// shell's own trigger parser, passed in so this file stays free of it.
export function cloudIntervalFromTriggers(
  triggers: unknown[] | null | undefined,
  normalizeTrigger: (trigger: unknown) => { kind?: string; intervalMs?: number } | null | undefined,
): number | null {
  const first = (triggers || []).map(normalizeTrigger).filter(Boolean)[0];
  if (!first) return null;
  if (first.kind !== "interval" && first.kind !== "hourly") return null;
  return Math.max(5, Math.round(Number(first.intervalMs) / 60_000) || 60);
}
