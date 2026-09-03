import { cloudBaseUrl, useMockAuth } from "./env.mjs";
import * as dummy from "./dummy.mjs";
import * as http from "./http.mjs";

export {
  accountEnabled,
  cloudBaseUrl,
  cloudFeaturesEnabled,
  cloudProductEnabled,
  isPackaged,
  requireAccount,
  useMockAuth,
} from "./env.mjs";

/** Bearer token for the signed-in Cloud session. Absent on the mock path. */
export interface TokenOptions {
  token?: string | undefined;
}

export interface ComputerIdOptions extends TokenOptions {
  computerId?: string | undefined;
}

export function authBackend(): typeof dummy | typeof http {
  if (useMockAuth()) return dummy;
  return http;
}

function needBase(): string {
  const base = cloudBaseUrl();
  if (!base || base === "mock") {
    // Same shape as cloud/http.mts throws: a plain Error with `code` stapled on,
    // which is what the desktop UI reads. The assertion adds no runtime step.
    const err = new Error("Cloud sign-in is not configured.") as http.CloudError;
    err.code = "NO_CLOUD";
    throw err;
  }
  return base;
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  const backend = authBackend();
  if (backend.kind === "dummy") return;
  await http.revokeSession(token, { baseUrl: needBase() });
}

export async function startMagic(email: string) {
  const backend = authBackend();
  if (backend.kind === "dummy") return backend.startMagic(email);
  return backend.startMagic(email, { baseUrl: needBase() });
}

export async function startX() {
  const backend = authBackend();
  if (backend.kind === "dummy") return backend.startX();
  return backend.startX({ baseUrl: needBase() });
}

export async function waitX(state?: string | null) {
  const backend = authBackend();
  if (backend.kind === "dummy") return { signedIn: true };
  return backend.waitX(state, { baseUrl: needBase() });
}

export async function liveComputers({ token }: TokenOptions = {}) {
  if (useMockAuth()) return { computers: [] };
  return http.cloudApi("/api/computers", { baseUrl: needBase(), token });
}

export async function liveCreateComputer({ token, sku }: TokenOptions & { sku?: string | undefined } = {}) {
  if (useMockAuth()) {
    const err = new Error("Mock Cloud has no live desks.") as http.CloudError;
    err.code = "CLOUD";
    throw err;
  }
  return http.cloudApi("/api/computers", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { sku: sku || "vm.4g" },
  });
}

export async function liveDestroyComputer({ token, id }: TokenOptions & { id?: string | undefined } = {}) {
  if (useMockAuth()) return { computer: null };
  // `as string`, not a guard: every caller passes an id, and an absent one has
  // always been encoded into the path as the literal "undefined" for the Worker
  // to reject. A `|| ""` here (as the sibling calls below do) would change the
  // request this has always made.
  return http.cloudApi(`/api/computers/${encodeURIComponent(id as string)}`, {
    baseUrl: needBase(),
    token,
    method: "DELETE",
  });
}

export async function liveBrain({ token }: TokenOptions = {}) {
  if (useMockAuth()) return { connected: false, grokSignedIn: false, apiKeySet: false, claudeOAuth: false };
  return http.cloudApi("/api/brain", { baseUrl: needBase(), token });
}

export async function liveBrainStartGrok({ token }: TokenOptions = {}) {
  if (useMockAuth()) {
    const err = new Error("Sign in to Cloud to use Grok OAuth.") as http.CloudError;
    err.code = "CLOUD";
    throw err;
  }
  return http.cloudApi("/api/brain/grok/start", { baseUrl: needBase(), token, method: "POST", body: {} });
}

/**
 * Claude subscription login, per DESK (not per account) -- the desktop twin of
 * the iOS flow. `start` parks `claude auth login` on the droplet and answers a
 * claude.com URL; `code` feeds back what claude.com showed the user. Both are
 * slow: the CLI spawn and the parked child's exit are on the far side, so these
 * must be allowed to run long.
 *
 * The desktop had NO Claude sign-in at all, while a fresh desk defaults to
 * provider "claude" -- so a desktop-only user got a desk that could not answer
 * and no in-app way to fix it.
 */
export interface ClaudeAuthOptions extends TokenOptions {
  computerId?: string | undefined;
}

export async function liveBrainClaudeAuth({ token, computerId }: ClaudeAuthOptions = {}) {
  return http.cloudApi(`/api/brain/claude/auth?computerId=${encodeURIComponent(computerId || "")}`, {
    baseUrl: needBase(),
    token,
  });
}

/** GET /api/brain/plugins — the plugins a desk's harness exposes and their live status. */
export async function liveBrainPlugins({ token, computerId, provider, refresh }: ClaudeAuthOptions & { provider?: string | undefined; refresh?: boolean | undefined } = {}) {
  const q = `computerId=${encodeURIComponent(computerId || "")}&provider=${encodeURIComponent(provider || "claude")}${refresh ? "&refresh=1" : ""}`;
  return http.cloudApi(`/api/brain/plugins?${q}`, {
    baseUrl: needBase(),
    token,
  });
}

export async function liveBrainClaudeAuthStart({ token, computerId }: ClaudeAuthOptions = {}) {
  return http.cloudApi("/api/brain/claude/auth/start", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId },
  });
}

export async function liveBrainClaudeAuthCode({
  token,
  computerId,
  code,
}: ClaudeAuthOptions & { code?: string | undefined } = {}) {
  return http.cloudApi("/api/brain/claude/auth/code", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId, code },
  });
}

export async function liveBrainClaudeForget({ token }: { token?: string } = {}) {
  return http.cloudApi("/api/brain/claude", { baseUrl: needBase(), token, method: "DELETE" });
}

export async function liveBrainClaudeAuthLogout({ token, computerId }: ClaudeAuthOptions = {}) {
  return http.cloudApi("/api/brain/claude/auth/logout", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId },
  });
}

export async function liveBrainWaitGrok({ token, id }: TokenOptions & { id?: string | undefined } = {}) {
  return http.cloudApi(`/api/brain/grok/wait?id=${encodeURIComponent(id || "")}`, { baseUrl: needBase(), token });
}

export interface LiveBrainKeyOptions extends TokenOptions {
  provider?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
}

export async function liveBrainKey({ token, provider, apiKey, model, baseUrl }: LiveBrainKeyOptions = {}) {
  return http.cloudApi("/api/brain/key", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { provider, apiKey, model, baseUrl },
  });
}

// Cloud routines live in Worker KV per DESK (routines:<userId>:<computerId>),
// not per bot the way a local bot owns bot.routines. One list covers every bot
// on the desk; each row's botId names the screen that runs it.
export async function liveBrainRoutines({ token, computerId }: ComputerIdOptions = {}) {
  if (useMockAuth()) return { routines: [] };
  return http.cloudApi(`/api/brain/routines?computerId=${encodeURIComponent(computerId || "")}`, {
    baseUrl: needBase(),
    token,
  });
}

export interface LiveRoutineOptions extends ComputerIdOptions {
  id?: string | undefined;
  name?: string | undefined;
  instruction?: string | undefined;
  intervalMinutes?: number | undefined;
  enabled?: boolean | undefined;
  botId?: string | undefined;
}

export async function liveBrainRoutineCreate({ token, computerId, name, instruction, intervalMinutes, botId }: LiveRoutineOptions = {}) {
  return http.cloudApi("/api/brain/routines", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId, name, instruction, intervalMinutes, botId },
  });
}

// Undefined fields are dropped by JSON.stringify, and the Worker falls back to
// the stored row for anything absent — so a pause is {computerId, id, enabled}
// and leaves name/instruction/interval alone.
export async function liveBrainRoutinePatch({ token, computerId, id, name, instruction, intervalMinutes, enabled, botId }: LiveRoutineOptions = {}) {
  return http.cloudApi("/api/brain/routines", {
    baseUrl: needBase(),
    token,
    method: "PATCH",
    body: { computerId, id, name, instruction, intervalMinutes, enabled, botId },
  });
}

export async function liveBrainRoutineDelete({ token, computerId, id }: LiveRoutineOptions = {}) {
  return http.cloudApi("/api/brain/routines", {
    baseUrl: needBase(),
    token,
    method: "DELETE",
    body: { computerId, id },
  });
}

export async function liveBrainThread({ token, computerId, botId }: ComputerIdOptions & { botId?: string | undefined } = {}) {
  if (useMockAuth()) return { messages: [] };
  const q = new URLSearchParams({ computerId: computerId || "default" });
  if (botId) q.set("botId", botId);
  return http.cloudApi(`/api/brain/thread?${q}`, {
    baseUrl: needBase(),
    token,
  });
}

export interface LiveBrainChatOptions extends ComputerIdOptions {
  content?: string | undefined;
  botId?: string | undefined;
  display?: unknown;
  persistUser?: boolean | undefined;
  identityId?: string | undefined;
}

export async function liveBrainChat({ token, computerId, content, botId, display, persistUser, identityId }: LiveBrainChatOptions = {}) {
  return http.cloudApi("/api/brain/chat", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId, content, botId, display, persistUser, identityId },
  });
}

export async function liveBrainTurn({ token, computerId, id }: ComputerIdOptions & { id?: string | undefined } = {}) {
  const q = new URLSearchParams({ computerId: computerId || "default", id: id || "" });
  return http.cloudApi(`/api/brain/turn?${q}`, { baseUrl: needBase(), token });
}

export async function liveBrainAbort({ token, computerId, turnId, all }: ComputerIdOptions & { turnId?: string | undefined; all?: unknown } = {}) {
  return http.cloudApi("/api/brain/abort", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId, turnId, all: Boolean(all) },
  });
}

export async function liveBrainTeam({ token, computerId }: ComputerIdOptions = {}) {
  return http.cloudApi(`/api/brain/team?computerId=${encodeURIComponent(computerId || "")}`, {
    baseUrl: needBase(),
    token,
  });
}

export interface LiveMateOptions extends ComputerIdOptions {
  botId?: string | undefined;
  name?: string | undefined;
  job?: string | undefined;
  identityId?: string | undefined;
  /** A user photo (data URL); "" clears it. */
  photo?: string | undefined;
}

export async function liveBrainCreateMate({ token, computerId, name, job }: LiveMateOptions = {}) {
  return http.cloudApi("/api/brain/team", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId, name, job },
  });
}

export async function liveDeskAction({
  token,
  computerId,
  action,
}: ComputerIdOptions & { action?: Record<string, unknown> | undefined } = {}) {
  return http.cloudApi("/api/brain/desk-action", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId, ...(action || {}) },
  });
}

export async function liveBrainPatchMate({ token, computerId, botId, name, job, identityId, photo }: LiveMateOptions = {}) {
  return http.cloudApi("/api/brain/team", {
    baseUrl: needBase(),
    token,
    method: "PATCH",
    body: { computerId, botId, name, job, identityId, ...(photo !== undefined ? { photo } : {}) },
  });
}

export async function liveBrainDeleteMate({ token, computerId, botId }: LiveMateOptions = {}) {
  const q = new URLSearchParams({ computerId: computerId || "", botId: botId || "" });
  return http.cloudApi(`/api/brain/team?${q}`, {
    baseUrl: needBase(),
    token,
    method: "DELETE",
  });
}

export async function liveBrainControl({ token, computerId, on }: ComputerIdOptions & { on?: unknown } = {}) {
  return http.cloudApi("/api/brain/control", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { computerId, on },
  });
}

export async function liveBillingSummary({ token }: TokenOptions = {}) {
  if (useMockAuth()) return { skus: [], subscription: null, totalCents: 0 };
  return http.cloudApi("/api/billing/summary", { baseUrl: needBase(), token });
}

export async function liveBillingPortal({ token }: TokenOptions = {}) {
  if (useMockAuth()) {
    const err = new Error("Billing needs a live Cloud session.") as http.CloudError;
    err.code = "CLOUD";
    throw err;
  }
  return http.cloudApi("/api/billing/portal", { baseUrl: needBase(), token, method: "POST", body: {} });
}

export async function liveBillingCheckout({ token, items }: TokenOptions & { items?: unknown } = {}) {
  if (useMockAuth()) {
    const err = new Error("Billing needs a live Cloud session.") as http.CloudError;
    err.code = "CLOUD";
    throw err;
  }
  return http.cloudApi("/api/billing/checkout", {
    baseUrl: needBase(),
    token,
    method: "POST",
    body: { items },
  });
}
