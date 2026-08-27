/**
 * The boundary: bytes off the wire -> validated TurnEvents.
 *
 * Two rules this encodes, both of which have cost production time:
 *
 * 1. DECODE ONCE, ACROSS CHUNKS. A single TextDecoder in streaming mode holds a
 *    partial multi-byte sequence back until the rest of it arrives. Decoding
 *    each TCP read independently splits an em dash (U+2014, 3 bytes) into
 *    replacement characters and corrupts the JSON around it — which is how
 *    "every reply containing an em dash" broke. Callers that hand this decoder
 *    BYTES are safe by construction; callers that hand it strings have already
 *    made the decision themselves.
 *
 * 2. A LINE THAT DOES NOT VALIDATE IS REPORTED, NOT DROPPED. Both existing
 *    clients silently ignore unparseable lines, so a harness emitting a shape
 *    the client has not been taught is indistinguishable from a quiet turn.
 */

import { parseTurnEventLine } from "./events.js";
import type { DoneEvent, ErrorEvent, MalformedReason, TurnEvent } from "./events.js";

export interface MalformedLine {
  reason: MalformedReason;
  /** Truncated to 200 chars — these get logged, and a bad line can be huge. */
  line: string;
}

export interface TurnStreamResult {
  /**
   * The final reply: the last `done` event's content, trimmed. "" means the
   * stream ended without one, which both clients treat as a failed turn
   * ("harness turn ended without a result").
   */
  content: string;
  done: DoneEvent | null;
  /** The last `error` event seen, if any. The turn is over when one arrives. */
  error: ErrorEvent | null;
  /** Accepted events, by type and in total. */
  counts: { tool: number; delta: number; done: number; error: number; total: number };
  /** Every rejected line, capped; malformedCount is the true total. */
  malformed: MalformedLine[];
  malformedCount: number;
}

const MAX_RECORDED_MALFORMED = 8;

function newResult(): TurnStreamResult {
  return {
    content: "",
    done: null,
    error: null,
    counts: { tool: 0, delta: 0, done: 0, error: 0, total: 0 },
    malformed: [],
    malformedCount: 0,
  };
}

function record(result: TurnStreamResult, event: TurnEvent): void {
  result.counts[event.type] += 1;
  result.counts.total += 1;
  if (event.type === "done") {
    result.done = event;
    result.content = event.content.trim();
  }
  if (event.type === "error") result.error = event;
}

function reject(result: TurnStreamResult, reason: MalformedReason, line: string): void {
  result.malformedCount += 1;
  if (result.malformed.length < MAX_RECORDED_MALFORMED) {
    result.malformed.push({ reason, line: line.slice(0, 200) });
  }
}

export interface TurnEventDecoderOptions {
  onEvent?: (event: TurnEvent) => void | Promise<void>;
  onMalformed?: (line: string, reason: MalformedReason) => void;
}

export interface TurnEventDecoder {
  /**
   * Feed one chunk. Prefer Uint8Array: strings are appended as-is, which is
   * only correct if the caller decoded them with its own streaming decoder.
   */
  push(chunk: Uint8Array | string): Promise<void>;
  /** Flush the tail (including a trailing partial UTF-8 sequence) and settle. */
  finish(): Promise<TurnStreamResult>;
  /** Live view of the result so far. */
  readonly result: TurnStreamResult;
}

export function createTurnEventDecoder(options: TurnEventDecoderOptions = {}): TurnEventDecoder {
  const decoder = new TextDecoder();
  const result = newResult();
  let buffer = "";
  let finished = false;

  const consume = async (line: string): Promise<void> => {
    const parsed = parseTurnEventLine(line);
    if (parsed.ok === "blank") return;
    if (parsed.ok === false) {
      reject(result, parsed.reason, parsed.line);
      options.onMalformed?.(parsed.line, parsed.reason);
      return;
    }
    record(result, parsed.event);
    await options.onEvent?.(parsed.event);
  };

  const drain = async (): Promise<void> => {
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      await consume(line);
    }
  };

  return {
    result,
    async push(chunk: Uint8Array | string): Promise<void> {
      if (finished) throw new Error("turn event decoder already finished");
      if (typeof chunk === "string") buffer += chunk;
      else if (chunk && chunk.length) buffer += decoder.decode(chunk, { stream: true });
      await drain();
    },
    async finish(): Promise<TurnStreamResult> {
      if (!finished) {
        finished = true;
        // Flush any held-back partial sequence so a truncated tail cannot linger.
        buffer += decoder.decode();
        await drain();
        if (buffer.trim()) await consume(buffer);
        buffer = "";
      }
      return result;
    },
  };
}

/** Whole-body form, for a non-streaming response. Same validation, synchronous. */
export function decodeTurnEvents(
  input: string | Uint8Array,
  onEvent?: (event: TurnEvent) => void,
): TurnStreamResult {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const result = newResult();
  for (const line of text.split("\n")) {
    const parsed = parseTurnEventLine(line);
    if (parsed.ok === "blank") continue;
    if (parsed.ok === false) {
      reject(result, parsed.reason, parsed.line);
      continue;
    }
    record(result, parsed.event);
    onEvent?.(parsed.event);
  }
  return result;
}
