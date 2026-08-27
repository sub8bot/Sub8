/**
 * The NDJSON events streamed back from POST /turn.
 *
 * Producer: server/desk-harness/harness.mjs (feedGrokLine, feedClaudeLine,
 * runTurn) via the `emit` closure in server/desk-harness/server.mjs.
 * Consumers: cloud/src/harness-client.mjs (createNdjsonParser) and
 * server/desk-client.mjs (runDeskTurn).
 *
 * Both consumers today drop anything they do not recognise WITHOUT a sound. A
 * harness that starts emitting a shape the Worker has not been taught looks
 * exactly like a harness that has gone quiet, which is why these guards report
 * rejects rather than swallowing them.
 */

import { TURN_EVENT_TYPES } from "./constants.js";
import type { TurnEventType } from "./constants.js";

/** A tool call the agent made. Rendered as an activity row in chat. */
export interface ToolEvent {
  type: "tool";
  /** e.g. "computer", "browser", "shell". Never empty — the harness defaults to "tool". */
  name: string;
  /**
   * The tool's input. brain.mjs reads `args.action` / `args.browser_action` /
   * `args.command` for the summary line, so this must stay a plain object.
   */
  args: Record<string, unknown>;
}

/** Incremental assistant text. Concatenating every delta is NOT the final reply. */
export interface DeltaEvent {
  type: "delta";
  text: string;
}

/** Token accounting for the turn. Always emitted by runTurn, zeroed when unknown. */
export interface TurnUsage {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * The turn's final, folded reply. Exactly one `done` per successful turn, and it
 * is the LAST event. Both clients treat "stream ended with no done" as failure
 * ("harness turn ended without a result").
 */
export interface DoneEvent {
  type: "done";
  content: string;
  usage?: TurnUsage;
}

/**
 * The turn failed. cloud/src/harness-client.mjs throws on this; the desktop
 * client records it (deskTurnFailed) instead. Either way the turn is over.
 */
export interface ErrorEvent {
  type: "error";
  message: string;
}

export type TurnEvent = ToolEvent | DeltaEvent | DoneEvent | ErrorEvent;

/** Why a line was not accepted as a TurnEvent. Surfaced instead of swallowed. */
export type MalformedReason =
  | "not-json"
  | "not-object"
  | "missing-type"
  | "unknown-type"
  | "bad-shape";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolEvent(value: unknown): value is ToolEvent {
  if (!isPlainObject(value) || value.type !== "tool") return false;
  if (typeof value.name !== "string" || !value.name) return false;
  return isPlainObject(value.args);
}

export function isDeltaEvent(value: unknown): value is DeltaEvent {
  return isPlainObject(value) && value.type === "delta" && typeof value.text === "string";
}

export function isTurnUsage(value: unknown): value is TurnUsage {
  if (!isPlainObject(value)) return false;
  for (const k of ["llmCalls", "promptTokens", "completionTokens"] as const) {
    const n = value[k];
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  return true;
}

export function isDoneEvent(value: unknown): value is DoneEvent {
  if (!isPlainObject(value) || value.type !== "done") return false;
  if (typeof value.content !== "string") return false;
  return value.usage === undefined || isTurnUsage(value.usage);
}

export function isErrorEvent(value: unknown): value is ErrorEvent {
  return isPlainObject(value) && value.type === "error" && typeof value.message === "string";
}

export function isTurnEvent(value: unknown): value is TurnEvent {
  return isToolEvent(value) || isDeltaEvent(value) || isDoneEvent(value) || isErrorEvent(value);
}

/** Why `value` is not a TurnEvent, or null when it is one. */
export function turnEventReject(value: unknown): MalformedReason | null {
  if (!isPlainObject(value)) return "not-object";
  const type = value.type;
  if (typeof type !== "string" || !type) return "missing-type";
  if (!(TURN_EVENT_TYPES as readonly string[]).includes(type)) return "unknown-type";
  return isTurnEvent(value) ? null : "bad-shape";
}

/** Narrow an already-validated event by type without re-running every guard. */
export function eventType(event: TurnEvent): TurnEventType {
  return event.type;
}

/**
 * Parse ONE NDJSON line. Returns the event, or a reason it was rejected.
 * Blank lines are not an error: the stream is newline-terminated, so the tail
 * after the last `\n` is normally empty.
 */
export type ParsedLine =
  | { ok: true; event: TurnEvent }
  | { ok: false; reason: MalformedReason; line: string }
  | { ok: "blank" };

export function parseTurnEventLine(line: string): ParsedLine {
  const raw = String(line ?? "").trim();
  if (!raw) return { ok: "blank" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not-json", line: raw };
  }
  const reject = turnEventReject(parsed);
  if (reject) return { ok: false, reason: reject, line: raw };
  return { ok: true, event: parsed as TurnEvent };
}

/**
 * Serialise one event for the wire, newline-terminated — the exact string the
 * harness `emit` writes. Throws on an invalid event so a producer bug surfaces
 * where it happens instead of as a silently-dropped line on the far end.
 */
export function encodeTurnEvent(event: TurnEvent): string {
  const reject = turnEventReject(event);
  if (reject) throw new TypeError(`not a harness turn event (${reject}): ${JSON.stringify(event)}`);
  return `${JSON.stringify(event)}\n`;
}
