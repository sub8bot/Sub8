export type { ClaudeAuthStatus, HarnessId, HarnessRow } from "./types.js";

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
} from "./harness-auth.js";
