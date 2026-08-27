import type { BoxHelpReleasedWake, BoxHelpRequest, CodedError, ControlRelease } from "./types.js";

/** In-memory: human is driving this Bot's computer. */
const held = new Set<string>();
/** Spec `request_box_help` → Take control. Never host FS (External* is out). */
const help = new Map<string, BoxHelpRequest>();

export function setHumanControl(botId: string, on: unknown): boolean {
  if (!botId) return false;
  if (on) held.add(botId);
  else held.delete(botId);
  return held.has(botId);
}

export function isHumanControl(botId: string): boolean {
  return Boolean(botId && held.has(botId));
}

/**
 * Ask the human to Take control (login / 2FA / captcha / payment).
 * Does not flip `held` — that is the Take control button. Does not grant `/Users`.
 */
export function requestBoxHelp(botId: unknown, { reason }: { reason?: unknown } = {}): BoxHelpRequest {
  const id = String(botId || "").trim();
  if (!id) {
    const err: CodedError = new Error("botId required");
    err.code = "NEED_BOT";
    throw err;
  }
  const row: BoxHelpRequest = {
    botId: id,
    action: "take_control",
    reason:
      String(reason || "").trim() ||
      "Need you to Take control (login, 2FA, captcha, or payment).",
    at: Date.now(),
    hostFs: false,
    external: false,
  };
  help.set(id, row);
  return row;
}

export function pendingBoxHelp(botId: unknown): BoxHelpRequest | null {
  const id = String(botId || "").trim();
  return (id && help.get(id)) || null;
}

export function clearBoxHelp(botId: unknown): void {
  const id = String(botId || "").trim();
  if (id) help.delete(id);
}

/** Release Take control. Caller durable-wakes the parent with `boxHelpReleasedWake`. */
export function releaseHumanControl(botId: unknown): ControlRelease {
  const id = String(botId || "").trim();
  if (!id) {
    const err: CodedError = new Error("botId required");
    err.code = "NEED_BOT";
    throw err;
  }
  const pending = pendingBoxHelp(id);
  const wasHeld = isHumanControl(id);
  setHumanControl(id, false);
  clearBoxHelp(id);
  return { botId: id, wasHeld, pending };
}

export function boxHelpReleasedWake({ botId, pending }: Partial<ControlRelease> = {}): BoxHelpReleasedWake {
  const id = String(botId || "").trim();
  if (!id) {
    const err: CodedError = new Error("botId required");
    err.code = "NEED_BOT";
    throw err;
  }
  return {
    type: "box-help-released",
    botId: id,
    payload: { reason: pending?.reason || "" },
  };
}

/** Spec External* (host Mac filesystem) is out of scope. */
export function requestExternal(): never {
  const err: CodedError = new Error("External* (host Mac filesystem) is out of scope");
  err.code = "EXTERNAL_OUT";
  throw err;
}

export function resetControlForTest(): void {
  held.clear();
  help.clear();
}
