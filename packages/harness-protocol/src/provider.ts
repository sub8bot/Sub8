/**
 * Provider predicates. Both sides branch on the provider string, and today they
 * branch DIFFERENTLY:
 *
 *   cloud/src/harness-client.mjs   `row.provider === "claude"`   (exact)
 *   server/desk-harness/harness.mjs `/^claude/.test(provider)`   (prefix)
 *
 * A provider like "claude-max" is therefore Claude to the desk and NOT Claude to
 * the Worker — which is the exact shape of the bug where a user on a Claude
 * subscription had their turn sent as provider "grok-oauth" and silently ran
 * grok. One definition, imported by both, is the fix.
 */

/** True when this turn should run the Claude Code CLI instead of grok. */
export function isClaudeProvider(provider: unknown): boolean {
  return /^claude/.test(String(provider ?? "").toLowerCase());
}

/** True when auth is an injected auth.json file rather than an API key. */
export function isOAuthProvider(provider: unknown): boolean {
  return /oauth/.test(String(provider ?? "").toLowerCase());
}
