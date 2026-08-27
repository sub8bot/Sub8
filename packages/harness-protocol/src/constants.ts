/**
 * Wire constants for the desk-harness HTTP service.
 *
 * The port is currently written down in four places that must agree or a desk
 * silently becomes unreachable:
 *   cloud/src/harness-client.mjs      HARNESS_PORT
 *   cloud/src/digitalocean.mjs        HARNESS_PORT (firewall + bake)
 *   server/desk-client.mjs            DESK_HARNESS_CONTAINER_PORT
 *   server/desk-harness/server.mjs    DESK_HARNESS_PORT default
 */

/** Deliberately NOT 3010 — that is the older pi executor, which may coexist. */
export const HARNESS_PORT = 3011;

export const HEALTH_PATH = "/health";
export const TURN_PATH = "/turn";
export const STOP_PATH = "/stop";

/** POST /turn responds with this content type, one JSON object per line. */
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * Every event type POST /turn may stream. A receiver that sees anything else is
 * looking at a harness newer (or older) than it is — see isTurnEvent.
 */
export const TURN_EVENT_TYPES = ["tool", "delta", "done", "error"] as const;

export type TurnEventType = (typeof TURN_EVENT_TYPES)[number];
