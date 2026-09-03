/**
 * The shapes this package reads off and writes to disk.
 *
 * Every row here is JSON that older builds wrote, so almost everything is
 * optional and each record keeps an index signature: a field this version does
 * not know about must survive a read/modify/write round trip, not be dropped.
 */

/** One chat row in `data/conversations/<botId>.json` (and mirrored on the bot). */
export interface Message {
  id: string;
  /** `"choices"` is the only kind `unionMessages` reasons about. */
  kind?: string | undefined;
  /** A choices card the human already answered is `false` and must stay `false`. */
  pending?: boolean | undefined;
  ts?: number | undefined;
  [key: string]: unknown;
}

/** The three-part look the renderer needs; `loadBots` fills in whatever is missing. */
export interface BotAvatar {
  expression: string;
  animation: string;
  body: string;
  /** A user-chosen picture (data URL, downscaled client-side) shown instead of the drawn look. */
  photo?: string | undefined;
}

/** The bot's computer, as the host last saw it. */
export interface BotVm {
  status?: string | undefined;
  container?: string | null | undefined;
  novncPort?: number | null | undefined;
  display?: string | undefined;
  error?: string | null | undefined;
  [key: string]: unknown;
}

/** Which harness runs this bot's turns. `provider` is the only field always set. */
export interface BotHarness {
  provider?: string | undefined;
  model?: string | undefined;
  [key: string]: unknown;
}

/** One entry in a routine's rolling run log. */
export interface RoutineRun {
  ts: number;
  [key: string]: unknown;
}

/** The wall-clock part of a routine, as `preserveRoutineRunMarker` reads it. */
export interface StoredSchedule {
  type?: string | undefined;
  hour?: number | undefined;
  minute?: number | undefined;
  [key: string]: unknown;
}

/**
 * A routine as it sits on the bot. `@sub8/automations` owns the richer
 * `Routine` type; this is only the slice the merge in `upsertBot` touches,
 * plus `runs`, which that package does not model.
 */
export interface StoredRoutine {
  id: string;
  updatedAt?: number | undefined;
  lastRunAt?: number | undefined;
  nextRunAt?: number | null | undefined;
  nextRunTimeZone?: string | undefined;
  schedule?: StoredSchedule | undefined;
  runs?: RoutineRun[] | undefined;
  [key: string]: unknown;
}

/** A row in `data/bots.json`. Desk `profile.json` is the canonical identity. */
export interface Bot {
  id: string;
  name?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  color?: string | undefined;
  icon?: string | undefined;
  avatar?: BotAvatar | undefined;
  notificationsEnabled?: boolean | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  vm?: BotVm | undefined;
  messages?: Message[] | undefined;
  routines?: StoredRoutine[] | undefined;
  grokSessionId?: string | undefined;
  identityId?: string | undefined;
  harness?: BotHarness | undefined;
  pinned?: boolean | undefined;
  section?: string | undefined;
  unread?: boolean | undefined;
  hidden?: boolean | undefined;
  teamId?: string | undefined;
  teamRole?: string | undefined;
  /** Words (beyond name/role) this bot wakes on in the team channel. */
  channelKeywords?: readonly string[] | undefined;
  /** Team-channel coordination state; "hold" = parked by the chief. */
  channelState?: "active" | "hold" | undefined;
  [key: string]: unknown;
}

/** What `newBot` accepts: tool arguments and half-filled forms, so all optional. */
export interface BotSeed {
  name?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  color?: string | undefined;
  icon?: string | undefined;
  avatar?: Partial<BotAvatar> | undefined;
  harness?: BotHarness | undefined;
  identityId?: string | undefined;
  pinned?: boolean | undefined;
  section?: string | undefined;
  unread?: boolean | undefined;
  hidden?: boolean | undefined;
  teamId?: string | undefined;
  teamRole?: string | undefined;
  /** Words (beyond name/role) this bot wakes on in the team channel. */
  channelKeywords?: readonly string[] | undefined;
  /** Team-channel coordination state; "hold" = parked by the chief. */
  channelState?: "active" | "hold" | undefined;
  [key: string]: unknown;
}

/** What `recoverMissingBots` is handed: a remembered bot, possibly partial. */
export interface BotHint extends BotSeed {
  id?: string | undefined;
  vm?: BotVm | undefined;
  routines?: StoredRoutine[] | undefined;
}

/** One user-made group in the sidebar rail. */
export interface SidebarSection {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** `settings.harness` — which model answers, and where it lives. */
export interface HarnessSettings {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  grokBuildCommand: string;
  setupComplete?: boolean | undefined;
  setupSkipped?: boolean | undefined;
  [key: string]: unknown;
}

/**
 * What `normalizeHarness` is handed: the `harness` object as it came off disk
 * or out of a PUT body, so every field is a guess until it has been checked.
 */
export interface HarnessInput {
  provider?: string | undefined;
  model?: unknown;
  baseUrl?: unknown;
  apiKeyEnv?: string | undefined;
  grokBuildCommand?: string | undefined;
  setupComplete?: unknown;
  setupSkipped?: unknown;
}

/** `data/settings.json`. */
export interface Settings {
  version: number;
  themePreference: string;
  hardwareAccelerationEnabled: boolean;
  userTimeZoneOverride: string | null;
  localExecPermission: string;
  autoReviewEnabled: boolean;
  allowInstructions: string[];
  blockInstructions: string[];
  autoUpdateWhenIdleOptIn: boolean;
  updateTrack: string;
  sidebarSections: SidebarSection[];
  harness: HarnessSettings;
  [key: string]: unknown;
}

/** `group.json` — the membership mirror written onto the desk. */
export interface GroupJson {
  version: number;
  memberIds: string[];
}

/** `profile.json` — the channel's display identity on the desk. */
export interface ProfileJson {
  name: string;
  description: string;
}

/** A channel exactly as it is persisted in `data/channels.json`. */
export interface PersistedChannel {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** A channel as callers see it: the persisted row plus its `group.json` view. */
export interface Channel extends PersistedChannel {
  group: GroupJson;
}

/**
 * A channel-shaped value from anywhere: a persisted row, a public row, or the
 * half-filled thing a desk listing hands back.
 */
export interface ChannelLike {
  id?: string | undefined;
  name?: string | undefined;
  description?: unknown;
  memberIds?: readonly string[] | undefined;
  group?: { version?: number | undefined; memberIds?: readonly string[] | undefined } | null | undefined;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** What `createChannel` accepts — an HTTP body or tool arguments. */
export interface ChannelSeed {
  name?: unknown;
  memberIds?: unknown;
  description?: unknown;
}

/** Anything `channelIdOf` accepts — an id, or a row carrying one. */
export type ChannelRef = string | { id?: string | undefined } | null | undefined;

/** What a desk listing has to look like for `isChannel` to say yes. */
export interface ChannelListing {
  groupJson?: unknown;
  group?: { version?: number | undefined; memberIds?: unknown } | null | undefined;
  memberIds?: unknown;
  [key: string]: unknown;
}

/** `syncGroupJsonToDesk`'s injected filesystem: A8 supplies vm mkdir/write. */
export type DeskWriter = (dest: string, text: string) => Promise<unknown> | unknown;

/** One line of `data/traces/<botId>.jsonl`. */
export interface TraceRecord {
  ts?: number | undefined;
  botId?: string | undefined;
  container?: string | null | undefined;
  tunnel?: string | undefined;
  op?: string | undefined;
  detail?: unknown;
  ms?: number | undefined;
  ok?: boolean | undefined;
  error?: string | undefined;
  [key: string]: unknown;
}

/** The slice of a bot a trace line records. */
export interface TraceBot {
  id: string;
  vm?: { container?: string | null } | null | undefined;
  [key: string]: unknown;
}
