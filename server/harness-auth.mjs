/** Shared login/expiry copy so chat and Settings stay in sync. */

export const HARNESS_LABELS = {
  "grok-build": "Grok Build",
  hermes: "Hermes",
  claude: "Claude",
  codex: "Codex",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  spacexai: "SpaceXAI",
};

const AUTH_FAIL =
  /oauth session expired|failed to authenticate|authentication (failed|required|error)|not logged in|not signed in|please (log|sign) in|log in again|unauthorized|invalid.?api.?key|api key.*(missing|invalid|not set)|could not be refreshed|401\b|token expired|refresh.?token|login expired|session expired/i;

const alerts = new Map();

export function looksLikeAuthFailure(text) {
  return AUTH_FAIL.test(String(text || ""));
}

export function harnessLabel(provider) {
  return HARNESS_LABELS[provider] || "This harness";
}

export function friendlyHarnessFailure(provider, text = "") {
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

export function rewriteHarnessOutput(provider, text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  if (!looksLikeAuthFailure(raw)) return raw;
  noteAuthFailure(provider);
  return friendlyHarnessFailure(provider, raw);
}

export function noteAuthFailure(provider) {
  if (!provider) return;
  alerts.set(provider, Date.now());
}

export function clearAuthFailure(provider) {
  alerts.delete(provider);
}

export function hasAuthFailure(provider, maxAgeMs = 30 * 60_000) {
  const at = alerts.get(provider);
  if (!at) return false;
  if (Date.now() - at > maxAgeMs) {
    alerts.delete(provider);
    return false;
  }
  return true;
}

export function parseClaudeAuthStatus(out) {
  const t = String(out || "");
  let loggedIn = false;
  let email = "";
  const jsonBlob = t.match(/\{[\s\S]*\}/);
  if (jsonBlob) {
    try {
      const j = JSON.parse(jsonBlob[0]);
      if (typeof j.loggedIn === "boolean") loggedIn = j.loggedIn;
      email = String(j.email || j.account?.email || "").trim();
    } catch {
      loggedIn = /loggedIn["']?\s*:\s*true/i.test(t) && !/loggedIn["']?\s*:\s*false/i.test(t);
    }
  } else {
    loggedIn = /loggedIn["']?\s*:\s*true/i.test(t) && !/loggedIn["']?\s*:\s*false/i.test(t);
  }
  const em = t.match(/Email:\s*(\S+@\S+)/i);
  if (em) email = em[1].replace(/[.,;]+$/, "");
  const expired = /expired|log in again|not logged in|unauthenticated/i.test(t);
  if (expired) loggedIn = false;
  return { signedIn: Boolean(loggedIn), email, expired };
}

export function applyAuthAlert(row) {
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
