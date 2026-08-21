import assert from "node:assert/strict";
import {
  applyAuthAlert,
  clearAuthFailure,
  friendlyHarnessFailure,
  looksLikeAuthFailure,
  noteAuthFailure,
  parseClaudeAuthStatus,
  rewriteHarnessOutput,
} from "../server/harness-auth.mjs";

const expiredJson = parseClaudeAuthStatus(`{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}`);
assert.equal(expiredJson.signedIn, false);

const expiredText = parseClaudeAuthStatus(`Login: Expired — log in again
Organization: Daniel Faeina
Email: elchileno@gmail.com
Not logged in. Run claude auth login to authenticate.`);
assert.equal(expiredText.signedIn, false);
assert.equal(expiredText.expired, true);
assert.equal(expiredText.email, "elchileno@gmail.com");

const staleTrue = parseClaudeAuthStatus(`{"loggedIn":true,"email":"a@b.com"}
Login: Expired — log in again`);
assert.equal(staleTrue.signedIn, false);
assert.equal(staleTrue.email, "a@b.com");

const ok = parseClaudeAuthStatus(`{"loggedIn":true,"email":"ok@x.com"}`);
assert.equal(ok.signedIn, true);
assert.equal(ok.email, "ok@x.com");

assert.equal(looksLikeAuthFailure("Failed to authenticate: OAuth session expired and could not be refreshed"), true);
assert.equal(looksLikeAuthFailure("Cheapest is $240 Frontier"), false);

const claudeMsg = friendlyHarnessFailure(
  "claude",
  "Failed to authenticate: OAuth session expired and could not be refreshed",
);
assert.match(claudeMsg, /Claude signed out/);
assert.match(claudeMsg, /Settings → Harness → Claude/);
assert.doesNotMatch(claudeMsg, /Failed to authenticate/);
assert.doesNotMatch(claudeMsg, /OAuth session expired/);

assert.match(friendlyHarnessFailure("grok-build", "not signed in"), /Grok Build is signed out/);
assert.match(friendlyHarnessFailure("codex", "unauthorized"), /Codex is signed out/);
assert.match(friendlyHarnessFailure("hermes", "please log in"), /Hermes is signed out/);
assert.match(friendlyHarnessFailure("spacexai", "invalid api key"), /API key/);
assert.match(friendlyHarnessFailure("ollama", "ECONNREFUSED not running"), /not running/);
assert.match(friendlyHarnessFailure("lmstudio", "LM Studio is not running"), /not running/);

const raw = "Failed to authenticate: OAuth session expired and could not be refreshed";
assert.equal(rewriteHarnessOutput("claude", raw), claudeMsg);
assert.equal(rewriteHarnessOutput("claude", "Frontier $240 1-stop"), "Frontier $240 1-stop");

clearAuthFailure("codex");
assert.equal(
  applyAuthAlert({ id: "codex", label: "Codex", signedIn: true, ready: true, extra: {} }).signedIn,
  true,
);
noteAuthFailure("codex");
const warned = applyAuthAlert({
  id: "codex",
  label: "Codex",
  signedIn: true,
  ready: true,
  extra: {},
});
assert.equal(warned.expired, true);
assert.equal(warned.signedIn, false);
const live = applyAuthAlert({
  id: "claude",
  label: "Claude",
  signedIn: true,
  ready: true,
  liveAuth: true,
  extra: { email: "a@b.com" },
});
assert.equal(live.signedIn, true);
assert.equal(live.expired, undefined);

console.log("ok harness-auth");
