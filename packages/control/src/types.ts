/** Errors this module throws carry a code the HTTP layer maps to a status. */
export interface CodedError extends Error {
  code?: string;
}

/**
 * A pending `request_box_help`. `hostFs` and `external` are pinned false and
 * serialized on purpose: spec External* (the host Mac filesystem) is out of
 * scope, and the row is the record that this ask never claimed otherwise.
 */
export interface BoxHelpRequest {
  botId: string;
  action: "take_control";
  reason: string;
  at: number;
  hostFs: false;
  external: false;
}

/** What `releaseHumanControl` hands back so the caller can wake the parent. */
export interface ControlRelease {
  botId: string;
  wasHeld: boolean;
  pending: BoxHelpRequest | null;
}

/** The durable wake the host enqueues once the human hands the desk back. */
export interface BoxHelpReleasedWake {
  type: "box-help-released";
  botId: string;
  payload: { reason: string };
}
