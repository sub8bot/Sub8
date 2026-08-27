/** The harnesses this module has copy for. Anything else falls back to "This harness". */
export type HarnessId =
  | "grok-build"
  | "hermes"
  | "claude"
  | "codex"
  | "ollama"
  | "lmstudio"
  | "spacexai";

/** What `claude auth status` says, once the JSON and the prose agree. */
export interface ClaudeAuthStatus {
  signedIn: boolean;
  email: string;
  /** The session was there and lapsed — worth saying so, unlike "never signed in". */
  expired: boolean;
}

/**
 * One row of the Settings → Harness list, as server/harness-status.mjs builds
 * it. Only the fields `applyAuthAlert` reads or rewrites are named; the rest of
 * the row rides through untouched.
 */
export interface HarnessRow {
  id?: string;
  label?: string;
  signedIn?: boolean;
  ready?: boolean;
  expired?: boolean;
  /** This row was proved signed-in just now, not remembered from a probe. */
  liveAuth?: boolean;
  detail?: string;
  hint?: string;
  extra?: { email?: string; [key: string]: unknown };
  [key: string]: unknown;
}
