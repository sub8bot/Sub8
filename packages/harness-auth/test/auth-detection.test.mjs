/**
 * looksLikeAuthFailure decides whether a harness's output is REPLACED. Two
 * different kinds of damage hang off that one regex, and this file pins both
 * sides of it:
 *
 *  - a false negative leaves the raw provider error in the chat, which is where
 *    keys and tokens live ("invalid api key: xai-…").
 *  - a false positive is worse, because server/host-cli.mjs runs every finished
 *    turn through rewriteHarnessOutput. The bot's real answer is thrown away,
 *    replaced with "signed out", and noteAuthFailure then marks the harness
 *    expired in Settings for the next 30 minutes.
 *
 * The rest of the file pins that a remembered failure stays inside its own
 * provider, and that nothing here hands a caller a credential.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthAlert,
  clearAuthFailure,
  friendlyHarnessFailure,
  harnessLabel,
  hasAuthFailure,
  looksLikeAuthFailure,
  noteAuthFailure,
  parseClaudeAuthStatus,
  rewriteHarnessOutput,
} from "../dist/index.js";

test("an answer that merely contains the digits 401 is not an auth failure", () => {
  // Regression: `401\b` matched every one of these, so a turn that mentioned a
  // 401(k) or a $2401 total came back as "Claude is signed out".
  const answers = [
    "Your 401(k) contribution limit is $23,500 for 2026.",
    "Roll the old 401(k) into an IRA before December.",
    "The total came to $2401.",
    "That will be $401 up front.",
    "Flight AA401 departs at 9.",
    "We are on spec v1.401 of the protocol.",
  ];
  for (const text of answers) {
    assert.equal(looksLikeAuthFailure(text), false, `must not be an auth failure: ${text}`);
    assert.equal(rewriteHarnessOutput("claude", text), text, "the answer must survive untouched");
    assert.equal(hasAuthFailure("claude"), false, "and must not mark the harness signed out");
  }
});

test("a real 401 in any of its usual spellings is still caught", () => {
  for (const text of [
    "HTTP 401 Unauthorized",
    "Error: request failed with status code 401",
    "status=401 body={}",
    "got a 401 from the API",
    "request failed (401)",
    "401 Unauthorized",
  ]) {
    assert.equal(looksLikeAuthFailure(text), true, `must be an auth failure: ${text}`);
  }
  clearAuthFailure("claude");
});

test("the rewritten line never carries the raw failure, keys and tokens included", () => {
  // The whole point of the rewrite is that the provider's error text does not
  // reach the chat. These blobs are the shapes that actually carry a secret.
  const blobs = [
    'Error: 401 Unauthorized {"api_key":"xai-abcdef0123456789","org":"acme"}',
    "Failed to authenticate: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig could not be refreshed",
    "invalid api key: sk-ant-api03-SECRETVALUE-xyz",
    "OAuth session expired; refresh_token=rt_9f8e7d6c5b4a",
  ];
  const secrets = ["xai-abcdef0123456789", "eyJhbGciOiJIUzI1NiJ9", "sk-ant-api03-SECRETVALUE-xyz", "rt_9f8e7d6c5b4a"];
  for (const provider of ["claude", "grok-build", "codex", "spacexai"]) {
    for (const blob of blobs) {
      const out = rewriteHarnessOutput(provider, blob);
      assert.notEqual(out, blob, `${provider} must rewrite: ${blob}`);
      for (const secret of secrets) {
        assert.equal(out.includes(secret), false, `${out} still carries ${secret}`);
      }
      assert.match(out, /Settings → Harness/, "the replacement is the actionable line, nothing else");
    }
    clearAuthFailure(provider);
  }
});

test("a failure remembered for one harness never signs another one out", () => {
  for (const id of ["claude", "codex", "grok-build"]) clearAuthFailure(id);
  noteAuthFailure("claude");
  assert.equal(hasAuthFailure("claude"), true);
  assert.equal(hasAuthFailure("codex"), false);
  assert.equal(hasAuthFailure("grok-build"), false);
  assert.equal(hasAuthFailure(""), false);
  assert.equal(hasAuthFailure(undefined), false);

  const codex = applyAuthAlert({ id: "codex", label: "Codex", signedIn: true, ready: true, extra: {} });
  assert.equal(codex.signedIn, true, "Codex is not signed out because Claude is");
  assert.equal(codex.expired, undefined);

  clearAuthFailure("claude");
  assert.equal(hasAuthFailure("claude"), false);
});

test("forgetting an old alert is permanent, and a blank provider is never remembered", () => {
  clearAuthFailure("hermes");
  noteAuthFailure("hermes");
  // A negative window forces the age check without sleeping.
  assert.equal(hasAuthFailure("hermes", -1), false, "an alert past its window is not a failure");
  assert.equal(hasAuthFailure("hermes"), false, "and the expiry deletes it rather than hiding it");

  noteAuthFailure(undefined);
  noteAuthFailure("");
  noteAuthFailure(null);
  assert.equal(hasAuthFailure(""), false);
  clearAuthFailure("");
});

test("applyAuthAlert returns a new row and leaves the caller's row alone", () => {
  clearAuthFailure("codex");
  noteAuthFailure("codex");
  const row = Object.freeze({ id: "codex", label: "Codex", signedIn: true, ready: true, expired: false, extra: {} });
  const alerted = applyAuthAlert(row);
  assert.notEqual(alerted, row, "the status cache row must not be rewritten in place");
  assert.equal(row.signedIn, true, "the original is untouched");
  assert.equal(alerted.signedIn, false);
  assert.equal(alerted.ready, false);
  assert.equal(alerted.expired, true);
  assert.match(alerted.hint, /Settings → Harnesses → Codex/);
  clearAuthFailure("codex");

  // A row with nothing to key on rides straight through, rather than throwing
  // or being invented — harness-status builds rows before every id is known.
  assert.equal(applyAuthAlert(null), null);
  assert.equal(applyAuthAlert(undefined), undefined);
  const idless = { label: "Mystery" };
  assert.equal(applyAuthAlert(idless), idless);
});

test("liveAuth only clears the alert when the row is actually signed in", () => {
  clearAuthFailure("claude");
  noteAuthFailure("claude");
  // Proved signed-in just now: the remembered failure is stale and is dropped.
  const live = applyAuthAlert({ id: "claude", label: "Claude", signedIn: true, liveAuth: true, extra: {} });
  assert.equal(live.signedIn, true);
  assert.equal(hasAuthFailure("claude"), false, "the alert is really gone, not just skipped");

  // liveAuth with signedIn false is a live probe that says "signed out" — it
  // must not be read as proof of a session.
  noteAuthFailure("claude");
  const probedOut = applyAuthAlert({
    id: "claude",
    label: "Claude",
    signedIn: false,
    liveAuth: true,
    extra: { email: "a@b.com" },
  });
  assert.equal(probedOut.signedIn, false);
  assert.equal(probedOut.expired, true);
  assert.match(probedOut.detail, /a@b\.com/, "the last account is named so the user knows which login to redo");
  clearAuthFailure("claude");
});

test("parseClaudeAuthStatus answers three fields and carries none of the blob", () => {
  const out = parseClaudeAuthStatus(`{
    "loggedIn": true,
    "email": "dan@example.com",
    "accessToken": "sk-ant-oat01-LIVE-TOKEN",
    "refreshToken": "rt_live_value",
    "scopes": ["user:inference"]
  }`);
  assert.deepEqual(Object.keys(out), ["signedIn", "email", "expired"]);
  assert.equal(out.signedIn, true);
  assert.equal(out.email, "dan@example.com");
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes("sk-ant-oat01-LIVE-TOKEN"), false, "the status must never carry the token");
  assert.equal(serialized.includes("rt_live_value"), false);
});

test("signedIn is a boolean, and only a real boolean true counts as signed in", () => {
  for (const blob of [
    '{"loggedIn":"yes"}',
    '{"loggedIn":1}',
    '{"loggedIn":"true"}',
    '{"loggedIn":{"ok":true}}',
    "{}",
    "",
    "not json at all",
    "null",
  ]) {
    const parsed = parseClaudeAuthStatus(blob);
    assert.equal(typeof parsed.signedIn, "boolean", `${blob} must answer a boolean`);
    assert.equal(parsed.signedIn, false, `${blob} is not proof of a session`);
  }
  assert.equal(parseClaudeAuthStatus(null).signedIn, false);
  assert.equal(parseClaudeAuthStatus(undefined).signedIn, false);
  assert.equal(parseClaudeAuthStatus({}).signedIn, false);
});

test("prose beats JSON: expiry wins, and the printed email wins", () => {
  const mixed = parseClaudeAuthStatus(`{"loggedIn":true,"email":"stale@old.com"}
Account: Personal
Email: fresh@new.com,
Login: token expired`);
  assert.equal(mixed.signedIn, false, "an expired session is not a session, whatever the JSON says");
  assert.equal(mixed.expired, true);
  assert.equal(mixed.email, "fresh@new.com", "the trailing comma is stripped");

  // Two blobs in one output: the greedy {...} match spans both and fails to
  // parse, so the loose loggedIn scan is what answers.
  const twoBlobs = parseClaudeAuthStatus('{"cli":"2.1"} some noise {"loggedIn":true}');
  assert.equal(twoBlobs.signedIn, true);
  assert.equal(twoBlobs.expired, false);
  // …and a false anywhere in that same fallback wins, so a stale "true" cannot
  // outvote a fresh "false".
  assert.equal(parseClaudeAuthStatus('{"a":1} {"loggedIn":true} {"loggedIn":false}').signedIn, false);
});

test("an unknown harness gets generic copy, never another provider's name", () => {
  assert.equal(harnessLabel("some-future-engine"), "This harness");
  assert.equal(harnessLabel(""), "This harness");
  assert.equal(harnessLabel("claude"), "Claude");
  const generic = friendlyHarnessFailure("some-future-engine", "HTTP 401 Unauthorized");
  assert.match(generic, /^This harness is signed out/);
  for (const name of ["Claude", "Codex", "Grok Build", "Hermes", "Ollama"]) {
    assert.equal(generic.includes(name), false, `must not name ${name}`);
  }
});

test("spacexai is told to paste a key, except when the error reads like a lapsed login", () => {
  // spacexai is key-only — there is no interactive login — so the key line is
  // the right advice for everything it can actually fail with.
  for (const raw of ["", "unauthorized", "anything at all", "401"]) {
    assert.match(friendlyHarnessFailure("spacexai", raw), /needs an API key/);
  }
  // The expiry branch is checked first and does not know that, so a blob that
  // reads like a lapsed OAuth session sends a key-only harness to "sign in".
  assert.match(friendlyHarnessFailure("spacexai", "OAuth session expired"), /signed out — the login expired/);
  // The key-shaped copy is spacexai's alone; a CLI harness is told to sign in.
  assert.match(friendlyHarnessFailure("claude", "invalid api key"), /needs an API key/);
  assert.match(friendlyHarnessFailure("claude", "invalid_api_key"), /is signed out/);
  assert.match(friendlyHarnessFailure("ollama", "ECONNREFUSED"), /is not running/);
  assert.match(friendlyHarnessFailure("claude", "ECONNREFUSED"), /is signed out/);
});

test("rewriteHarnessOutput leaves empty and blank output exactly as it found it", () => {
  assert.equal(rewriteHarnessOutput("claude", ""), "");
  assert.equal(rewriteHarnessOutput("claude", "   \n  "), "");
  assert.equal(rewriteHarnessOutput("claude", null), "");
  assert.equal(rewriteHarnessOutput("claude", undefined), "");
  assert.equal(rewriteHarnessOutput("claude", "  ok  "), "ok");
  assert.equal(hasAuthFailure("claude"), false, "an empty turn is not an auth failure");
});
