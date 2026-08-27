/**
 * The POST /turn request body.
 *
 * Producer: harnessTurn() in cloud/src/harness-client.mjs.
 * Consumer: normalizeTurn() in server/desk-harness/harness.mjs.
 *
 * normalizeTurn accepts TWO shapes — the canonical executor shape the Worker
 * sends, and an older simple shape ({ botId, text, model: "<id>", provider }).
 * Both are typed here because "the harness also accepts this" is part of the
 * contract; deleting the simple shape without checking is how it breaks.
 */

import { isClaudeProvider, isOAuthProvider } from "./provider.js";

export type ChatRole = "user" | "assistant" | "system";

/** One prior message. harnessTurn sends the last 16, stripped to these fields. */
export interface HistoryMessage {
  role: ChatRole;
  content: string;
  ts?: number;
}

/**
 * Which model to run and how to authenticate it.
 * `apiKey` is "" on both OAuth and Claude-subscription turns — empty is normal,
 * absent is not.
 */
export interface ModelSpec {
  provider: string;
  /**
   * Never a grok id when provider is Claude: the desk spawns the claude CLI and
   * `--model grok-4.6` just fails. turnRequestProblems() enforces this.
   */
  id: string;
  apiKey: string;
  baseUrl: string;
}

/** Where the droplet POSTs state tools back to. */
export interface TurnCallback {
  /** Absolute https URL, e.g. https://sub8.bot/api/brain/executor-tool */
  url: string;
  computerId: string;
  botId: string;
}

/**
 * One record of grok-build's ~/.grok/auth.json, keyed `${issuer}::${clientId}`.
 * grok-build 1.0.5 ignores a flat {access_token} blob, and treats the record as
 * unsigned unless BOTH user_id (a UUID) and create_time (ISO) are present.
 */
export interface GrokAuthRecord {
  auth_mode: "oidc";
  key: string;
  refresh_token: string;
  expires_at: string;
  oidc_issuer: string;
  oidc_client_id: string;
  user_id: string;
  create_time: string;
}

export type GrokAuthFile = Record<string, GrokAuthRecord>;

/**
 * Account-level Claude subscription credential, passed through verbatim to
 * claudeImportCredentials on the desk. Opaque to this contract on purpose — the
 * shape belongs to the Claude CLI, not to Sub8.
 */
export type ClaudeCredentials = Record<string, unknown>;

/** The canonical body harnessTurn() sends. */
export interface TurnRequest {
  botId: string;
  content: string;
  history?: HistoryMessage[];
  system?: string;
  /** X display number to drive. Defaults to 1 on the desk when absent. */
  display?: number;
  provider: string;
  /** Present only on OAuth turns. */
  auth?: GrokAuthFile;
  /** Present only on Claude-subscription turns. */
  claudeAuth?: ClaudeCredentials;
  model: ModelSpec;
  callback?: TurnCallback;
}

/** The older shape normalizeTurn still accepts. `model` is a bare id string. */
export interface SimpleTurnRequest {
  botId?: string;
  text: string;
  model?: string;
  provider?: string;
  auth?: GrokAuthFile | string;
}

export type HarnessTurnBody = TurnRequest | SimpleTurnRequest;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (!isPlainObject(value)) return false;
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "system") return false;
  if (!isString(value.content)) return false;
  return value.ts === undefined || (typeof value.ts === "number" && Number.isFinite(value.ts));
}

export function isModelSpec(value: unknown): value is ModelSpec {
  if (!isPlainObject(value)) return false;
  if (!isString(value.provider)) return false;
  if (!isString(value.id) || !value.id) return false;
  return isString(value.apiKey) && isString(value.baseUrl);
}

export function isTurnCallback(value: unknown): value is TurnCallback {
  if (!isPlainObject(value)) return false;
  if (!isString(value.url) || !/^https?:\/\//.test(value.url)) return false;
  return isString(value.computerId) && isString(value.botId);
}

export function isGrokAuthRecord(value: unknown): value is GrokAuthRecord {
  if (!isPlainObject(value)) return false;
  if (value.auth_mode !== "oidc") return false;
  for (const k of [
    "key",
    "refresh_token",
    "expires_at",
    "oidc_issuer",
    "oidc_client_id",
    "user_id",
    "create_time",
  ] as const) {
    if (!isString(value[k])) return false;
  }
  return Boolean(value.key);
}

/** At least one `${issuer}::${clientId}` record, every one of them well-formed. */
export function isGrokAuthFile(value: unknown): value is GrokAuthFile {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  return keys.every((k) => k.includes("::") && isGrokAuthRecord(value[k]));
}

/**
 * Every reason `value` is not a valid canonical TurnRequest, in wire order.
 * An empty array means the desk will run the turn the Worker meant.
 *
 * The cross-field checks at the end are the ones that earn this package: they
 * are the invariants that have actually broken production, not type hygiene.
 */
export function turnRequestProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(value)) return ["body is not an object"];

  if (!isString(value.botId) || !value.botId.trim()) problems.push("botId must be a non-empty string");
  if (!isString(value.content)) problems.push("content must be a string");

  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) problems.push("history must be an array");
    else value.history.forEach((m, i) => {
      if (!isHistoryMessage(m)) problems.push(`history[${i}] must be {role,content,ts?}`);
    });
  }
  if (value.system !== undefined && !isString(value.system)) problems.push("system must be a string");
  if (value.display !== undefined) {
    const d = value.display;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1) problems.push("display must be an integer >= 1");
  }
  if (!isString(value.provider) || !value.provider.trim()) problems.push("provider must be a non-empty string");
  if (!isModelSpec(value.model)) problems.push("model must be {provider,id,apiKey,baseUrl} with a non-empty id");
  if (value.callback !== undefined && !isTurnCallback(value.callback)) {
    problems.push("callback must be {url,computerId,botId} with an http(s) url");
  }
  if (value.auth !== undefined && !isGrokAuthFile(value.auth)) {
    problems.push("auth must be a grok auth.json keyed `${issuer}::${clientId}`");
  }
  if (value.claudeAuth !== undefined && !isPlainObject(value.claudeAuth)) {
    problems.push("claudeAuth must be an object");
  }

  const provider = isString(value.provider) ? value.provider : "";
  const model = isModelSpec(value.model) ? value.model : null;

  // An OAuth turn with no auth.json runs grok signed out and comes back
  // "Not signed in" — indistinguishable from a model failure downstream.
  // Claude is exempt: it authenticates from claudeAuth or a ~/.claude login on
  // the desk and never carries a grok auth.json, so requiring one here fired on
  // every legitimate "claude-oauth" turn. A validator that cries wolf gets
  // ignored, which is worse than not having it.
  if (isOAuthProvider(provider) && !isClaudeProvider(provider) && value.auth === undefined) {
    problems.push(`provider "${provider}" requires auth (grok auth.json)`);
  }
  // The desk spawns the claude CLI for a claude provider; a grok model id there
  // is an immediate spawn failure with a useless message.
  if (isClaudeProvider(provider) && model && /^grok/i.test(model.id)) {
    problems.push(`provider "${provider}" cannot run model.id "${model.id}"`);
  }
  // model.provider and the top-level provider select DIFFERENT code paths on the
  // desk (normalizeTurn prefers the top level). Disagreeing is always a bug.
  if (model && provider && model.provider && model.provider !== provider) {
    problems.push(`model.provider "${model.provider}" disagrees with provider "${provider}"`);
  }
  return problems;
}

export function isTurnRequest(value: unknown): value is TurnRequest {
  return turnRequestProblems(value).length === 0;
}

/** Throwing form, for a boundary that should refuse rather than degrade. */
export function assertTurnRequest(value: unknown): TurnRequest {
  const problems = turnRequestProblems(value);
  if (problems.length) throw new TypeError(`invalid harness turn request: ${problems.join("; ")}`);
  return value as TurnRequest;
}

/** The older `{ botId, text, model:"<id>" }` shape normalizeTurn still accepts. */
export function isSimpleTurnRequest(value: unknown): value is SimpleTurnRequest {
  if (!isPlainObject(value)) return false;
  if (!isString(value.text) || !value.text.trim()) return false;
  if (value.model !== undefined && !isString(value.model)) return false;
  if (value.provider !== undefined && !isString(value.provider)) return false;
  if (value.botId !== undefined && !isString(value.botId)) return false;
  return true;
}

/** True for anything normalizeTurn() will run. */
export function isHarnessTurnBody(value: unknown): value is HarnessTurnBody {
  return isTurnRequest(value) || isSimpleTurnRequest(value);
}
