export type { ClaudeAuthStatus, HarnessId, HarnessRow } from "./types.js";
export type { IdentityProbeStatus } from "./harness-auth.js";

export {
  HARNESS_LABELS,
  applyAuthAlert,
  clearAuthFailure,
  friendlyHarnessFailure,
  harnessLabel,
  hasAuthFailure,
  looksLikeAuthFailure,
  noteAuthFailure,
  parseClaudeAuthStatus,
  rewriteHarnessOutput,
  statusForIdentity,
} from "./harness-auth.js";
