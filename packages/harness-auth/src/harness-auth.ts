/** Shared login/expiry copy so chat and Settings stay in sync. */

import type { ClaudeAuthStatus, HarnessRow } from "./types.js";

export const HARNESS_LABELS: Record<string, string> = {
  "grok-build": "Grok Build",
  hermes: "Hermes",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  spacexai: "SpaceXAI",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  custom: "Custom API",
  sub8: "Sub8",
};

/**
 * `401` has to look like an HTTP status, not like money or a retirement plan.
 * A bare `401\b` matched "401(k)", "$2401" and "AA401", and host-cli.mjs runs
 * every finished turn through rewriteHarnessOutput — so one answer about 401(k)
 * plans was replaced wholesale with "Claude is signed out" and the harness was
 * marked expired in Settings for the next 30 minutes. Strictly narrowing: it
 * only drops matches where 401 is glued to a word character or a "(".
 */
const AUTH_FAIL =
  /oauth session expired|failed to authenticate|authentication (failed|required|error)|not logged in|not signed in|please (log|sign) in|log in again|unauthorized|invalid.?api.?key|api key.*(missing|invalid|not set)|could not be refreshed|(?<![\w.$])401\b(?!\()|token expired|refresh.?token|login expired|session expired/i;

const alerts = new Map<string, number>();

export function looksLikeAuthFailure(text: unknown): boolean {
  return AUTH_FAIL.test(String(text || ""));
}

export function harnessLabel(provider: string): string {
  return HARNESS_LABELS[provider] || "This harness";
}

export function friendlyHarnessFailure(provider: string, text: unknown = ""): string {
  const label = harnessLabel(provider);
  const raw = String(text || "");
  if (/oauth session expired|could not be refreshed|session expired|token expired|log in again/i.test(raw)) {
    return `${label} signed out — the login expired. Open Settings → Harness → ${label} and sign in, then send this again.`;
  }
  if (/invalid.?api.?key|api key.*(missing|invalid|not set)/i.test(raw) || provider === "spacexai") {
    if (provider === "spacexai" || /api key/i.test(raw)) {
      return `${label} needs an API key. Open Settings → Harness → ${label}, paste a key, then send this again.`;
    }
  }
  if (/ollama|lm studio|ECONNREFUSED|not running/i.test(raw) && (provider === "ollama" || provider === "lmstudio")) {
    return `${label} is not running. Start it, then send this again.`;
  }
  return `${label} is signed out. Open Settings → Harness → ${label} and sign in, then send this again.`;
}

export function rewriteHarnessOutput(provider: string, text: unknown): string {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  if (!looksLikeAuthFailure(raw)) return raw;
  noteAuthFailure(provider);
  return friendlyHarnessFailure(provider, raw);
}

export function noteAuthFailure(provider: string | undefined): void {
  if (!provider) return;
  alerts.set(provider, Date.now());
}

export function clearAuthFailure(provider: string): void {
  alerts.delete(provider);
}

export function hasAuthFailure(provider: string, maxAgeMs = 30 * 60_000): boolean {
  const at = alerts.get(provider);
  if (!at) return false;
  if (Date.now() - at > maxAgeMs) {
    alerts.delete(provider);
    return false;
  }
  return true;
}

export function parseClaudeAuthStatus(out: unknown): ClaudeAuthStatus {
  const t = String(out || "");
  let loggedIn = false;
  let email = "";
  const jsonBlob = t.match(/\{[\s\S]*\}/);
  if (jsonBlob) {
    try {
      const j: { loggedIn?: unknown; email?: unknown; account?: { email?: unknown } } = JSON.parse(jsonBlob[0] as string);
      if (typeof j.loggedIn === "boolean") loggedIn = j.loggedIn;
      email = String(j.email || j.account?.email || "").trim();
    } catch {
      loggedIn = /loggedIn["']?\s*:\s*true/i.test(t) && !/loggedIn["']?\s*:\s*false/i.test(t);
    }
  } else {
    loggedIn = /loggedIn["']?\s*:\s*true/i.test(t) && !/loggedIn["']?\s*:\s*false/i.test(t);
  }
  const em = t.match(/Email:\s*(\S+@\S+)/i);
  if (em) email = (em[1] as string).replace(/[.,;]+$/, "");
  const expired = /expired|log in again|not logged in|unauthenticated/i.test(t);
  if (expired) loggedIn = false;
  return { signedIn: Boolean(loggedIn), email, expired };
}

export type IdentityProbeStatus = "signed_in" | "signed_out" | "expired" | "not_running" | "not_installed";

export function statusForIdentity(row: HarnessRow | null | undefined): IdentityProbeStatus {
  if (!row) return "not_installed";
  if (row.expired) return "expired";
  if (row.installed === false) return "not_installed";
  if (row.signedIn && row.ready) return "signed_in";
  const kind = String(row.kind || "");
  if ((kind === "openai-local" || row.id === "ollama" || row.id === "lmstudio") && !row.ready) return "not_running";
  if (!row.signedIn) return "signed_out";
  return row.ready ? "signed_in" : "signed_out";
}

export function applyAuthAlert(row: HarnessRow | null | undefined): HarnessRow | null | undefined {
  if (!row?.id) return row;
  if (row.liveAuth && row.signedIn) {
    clearAuthFailure(row.id);
    return row;
  }
  if (!hasAuthFailure(row.id) && !row.expired) return row;
  const label = row.label || harnessLabel(row.id);
  return {
    ...row,
    signedIn: false,
    ready: false,
    expired: true,
    detail: row.extra?.email
      ? `Session expired. Sign in again (last account: ${row.extra.email}).`
      : `${label} is signed out. Sign in again.`,
    hint: row.hint || `Open Settings → Harness → ${label} and sign in.`,
  };
}
