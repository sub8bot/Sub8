/** The wake kinds the durable queue accepts. Anything else throws on enqueue. */
export type WakeType =
  | "peer"
  | "channel"
  | "subagent-complete"
  | "code-agent-complete"
  | "routine"
  | "shell"
  | "box-help-released";

/**
 * Per-type body. The keys below are the ones `turnPromptForWake` reads; the
 * index signature keeps the rest of a producer's payload intact on disk.
 */
export interface WakePayload {
  /** peer / channel: the note itself. */
  content?: string;
  /** peer / channel: who sent it. */
  fromId?: string;
  /** channel: the room. */
  channelId?: string;
  /** subagent / code-agent / shell: the job id. */
  id?: string;
  /** subagent-complete: whatever the task returned. */
  result?: unknown;
  /** code-agent-complete: the PR it opened, if any. */
  prUrl?: string;
  /** shell: done | failed. */
  status?: string;
  /** box-help-released: why Take control was asked for. */
  reason?: string;
  [key: string]: unknown;
}

/** One queued wake, as it sits in memory and in `wakes.json`. */
export interface Wake {
  id: string;
  type: WakeType;
  botId: string;
  payload: WakePayload;
  /** A wake is never the user unless a caller says so. */
  user: boolean;
  priority: boolean;
  createdAt: number;
}

/** What `enqueueWake` accepts. Producers are untyped `.mjs`, so keep it loose. */
export interface WakeSpec {
  type?: unknown;
  botId?: unknown;
  payload?: unknown;
  priority?: boolean;
  user?: boolean;
}

/** `subscribeWakes` hands every enqueued wake to its listeners. */
export type WakeListener = (wake: Wake) => void;

/** The subset of a chat row the reminder rules read. */
export interface TurnMessage {
  role?: string;
  kind?: string;
  name?: string;
  content?: string;
  hidden?: boolean;
  reminder?: boolean;
  [key: string]: unknown;
}

export type ReminderKind = "ack" | "delivery";

export interface Reminder {
  kind: ReminderKind;
  content: string;
}

export interface ReminderOptions {
  /** A hidden turn (a wake, a routine) never gets nagged. */
  hidden?: boolean;
}

/** The hidden user line `reminderMessage` injects into the transcript. */
export interface ReminderRow {
  id: string;
  role: "user";
  content: string;
  hidden: true;
  reminder: true;
  ts: number;
}
