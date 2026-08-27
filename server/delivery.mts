import { canonicalToolName } from "./tools-catalog.mjs";

/** One tool call as the turn recorder saw it. Callers pass far wider rows. */
export interface DeliveryEvent {
  name?: string | undefined;
  args?: object | undefined;
}

export interface DeliveryOptions {
  resultExpected?: boolean | undefined;
}

export interface DeliveryVerdict {
  ok: boolean;
  reason: string;
}

function isSendMessage(name: unknown): boolean {
  return canonicalToolName(name) === "send_message";
}

/**
 * User-opened turn: first send_message is the ack; last send_message is the result.
 */
export function assertUserTurnDelivery(
  events: readonly DeliveryEvent[],
  opts: boolean | DeliveryOptions = {},
): DeliveryVerdict {
  // `opts === true` short-circuits, so the assertion only ever describes the
  // `false | DeliveryOptions` half; `false?.resultExpected` is undefined, which
  // is what this expression has always relied on.
  const resultExpected = opts === true || (opts as DeliveryOptions)?.resultExpected === true;
  const list: readonly DeliveryEvent[] = Array.isArray(events) ? events : [];
  const sendIdx: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (isSendMessage(list[i]?.name)) sendIdx.push(i);
  }

  if (sendIdx.length === 0) {
    return { ok: false, reason: "no send_message" };
  }
  if (sendIdx[0] !== 0) {
    return { ok: false, reason: "first tool is not send_message" };
  }
  if (resultExpected && sendIdx.length < 2) {
    return { ok: false, reason: "ack is the only send_message; result expected" };
  }
  return { ok: true, reason: "" };
}
