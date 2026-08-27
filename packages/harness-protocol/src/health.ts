/**
 * GET /health and POST /stop.
 *
 * /health is the readiness probe every caller gates on, and it is the reason the
 * three-day toolless outage went undetected: it answered `{ok:true,harness:true,
 * grok:true}` from the HTTP layer alone, so a harness whose mcp-sub8 died on a
 * missing import was indistinguishable from a healthy one.
 *
 * `mcp` / `tools` are that missing signal, and they are the additive change this
 * file was written to anticipate: the desk now runs a REAL mcp-sub8 handshake
 * (initialize + tools/list, cached) and reports the verdict plus the tool count.
 * Both are OPTIONAL. A desk running the old harness sends neither, and absence
 * means "unknown", never "down" — see harnessToolsState.
 */

/** Producer: server/desk-harness/server.mjs. Consumers: harnessHealthy() on both sides. */
export interface HarnessHealth {
  /** The HTTP service answered. Says nothing about the agent underneath. */
  ok: boolean;
  /** This is the grok-build harness (:3011), not the older pi executor (:3010). */
  harness: boolean;
  /**
   * `grok --version` exited 0 on the desk. NOT a check that a turn can run, and
   * OPTIONAL: a Claude desk has no grok installed, and an older harness may not
   * send the field at all. Absence means "unknown", never "down".
   */
  grok?: boolean;
  /**
   * The desk spawned mcp-sub8 exactly the way a turn does and it completed an
   * `initialize` + `tools/list` handshake with at least one tool. This is the
   * only field that can see the toolless outage: a dead mcp-sub8 (missing
   * import, EACCES on the data dir) makes it `false` while ok/harness/grok all
   * stay true.
   *
   * OPTIONAL, exactly like `grok`. Absent = the harness predates the probe, or
   * its first probe has not landed yet = UNKNOWN. Never treat absence as down;
   * that would bench every desk in production the day this ships.
   */
  mcp?: boolean;
  /**
   * How many tools that handshake listed. Evidence for `mcp`, not a second
   * verdict: 0 accompanies `mcp:false`. Also OPTIONAL — a count without `mcp`
   * is still only a hint, so gate on `mcp` and read this for the log line.
   */
  tools?: number;
}

/**
 * What a /health body says about the desk's TOOLS, which is deliberately
 * three-valued.
 *
 * - `"up"`      — a real mcp-sub8 handshake succeeded.
 * - `"down"`    — the desk is down, or the handshake failed. Bench it.
 * - `"unknown"` — the harness does not send `mcp` (old desk, or first probe
 *                 still in flight), or the body is not a health at all.
 *
 * The split between `"down"` and `"unknown"` is the whole backward-compatibility
 * story: consumers may bench on `"down"` and MUST NOT bench on `"unknown"`.
 */
export type HarnessToolsState = "up" | "down" | "unknown";

/** Response to POST /stop: how many in-flight turns were killed on this desk. */
export interface StopResponse {
  ok: boolean;
  stopped: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `ok` and `harness` are liveness; `grok`, `mcp` and `tools` are capabilities
 * and are OPTIONAL here. Requiring one made a harness that omits the field look
 * DOWN, which would take a working desk out of service — and since Claude runs
 * on the desk with no grok installed, that field is not a liveness signal at
 * all. Callers that genuinely need grok use harnessCanTurn; callers that need
 * tools use harnessHasTools.
 */
export function isHarnessHealth(value: unknown): value is HarnessHealth {
  if (!isPlainObject(value)) return false;
  if (typeof value.ok !== "boolean" || typeof value.harness !== "boolean") return false;
  if (value.grok !== undefined && typeof value.grok !== "boolean") return false;
  if (value.mcp !== undefined && typeof value.mcp !== "boolean") return false;
  if (value.tools !== undefined && (typeof value.tools !== "number" || !Number.isFinite(value.tools) || value.tools < 0)) {
    return false;
  }
  return true;
}

export function isStopResponse(value: unknown): value is StopResponse {
  if (!isPlainObject(value)) return false;
  return typeof value.ok === "boolean" && typeof value.stopped === "number" && Number.isFinite(value.stopped);
}

/** The desk is up and is the harness. Matches harnessHealthy() on both sides. */
export function harnessIsUp(value: unknown): boolean {
  return isHarnessHealth(value) && value.ok && value.harness;
}

/** Additionally: grok is installed, so a /turn is worth attempting (harnessCanTurn). */
export function harnessCanTurn(value: unknown): boolean {
  return harnessIsUp(value) && (value as HarnessHealth).grok === true;
}

/**
 * Tools, three-valued. Anything that is not a health at all is `"unknown"`, not
 * `"down"`: a body we cannot read tells us nothing about mcp-sub8, and the
 * caller already has harnessIsUp for "is this thing answering".
 */
export function harnessToolsState(value: unknown): HarnessToolsState {
  if (!isHarnessHealth(value)) return "unknown";
  if (!value.ok || !value.harness) return "down";
  if (value.mcp === undefined) return "unknown";
  return value.mcp ? "up" : "down";
}

/**
 * This desk can actually run tools: it is up AND a real mcp-sub8 handshake
 * succeeded. Strictly stronger than harnessIsUp, and FALSE for a harness that
 * does not report `mcp` — so route on `harnessToolsState(...) !== "down"`, and
 * keep this for "prove it works", never for "bench it".
 */
export function harnessHasTools(value: unknown): boolean {
  return harnessToolsState(value) === "up";
}

/** Parse a /health body defensively. Returns null on anything unexpected. */
export function parseHarnessHealth(body: unknown): HarnessHealth | null {
  if (typeof body === "string") {
    try {
      return parseHarnessHealth(JSON.parse(body || "{}"));
    } catch {
      return null;
    }
  }
  return isHarnessHealth(body) ? body : null;
}
