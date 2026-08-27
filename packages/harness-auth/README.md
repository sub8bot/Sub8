# @sub8/harness-auth

Whether a harness is signed in, and the one line the user is shown when it is
not — the same line in chat and in Settings.

Moved verbatim from `server/harness-auth.mjs` (111 lines, zero internal
imports). The emitted JS is token-for-token the original.

## What is here

- **Detection** — `looksLikeAuthFailure`. One regex over harness stdout. It has
  to catch every dialect (`401`, `invalid api key`, `OAuth session expired`,
  `not logged in`) without firing on a Bot that merely typed the word
  "unauthorized" into a browser.
- **Copy** — `harnessLabel`, `friendlyHarnessFailure`, `rewriteHarnessOutput`.
  A stack trace is never shown; what the user gets is which harness, what
  happened, and where to fix it (`Settings → Harness → <name>`). Ollama and LM
  Studio get "not running" instead of "signed out", because that is what is
  actually wrong.
- **Memory** — `noteAuthFailure` / `hasAuthFailure` / `clearAuthFailure`. A
  failure seen in a turn stays remembered for 30 minutes so the Settings row
  agrees with what chat just said, and is cleared the moment a live probe proves
  the session is good.
- **`parseClaudeAuthStatus`** — `claude auth status` prints a JSON blob, or
  prose, or both disagreeing. When they disagree the prose wins: a stale
  `"loggedIn": true` next to `Login: Expired` is signed out.
- **`applyAuthAlert`** — folds all of the above into one Settings row.
  `liveAuth && signedIn` always wins over a remembered failure.

## What is deliberately NOT here

Signing in. `server/harness-status.mjs` runs the probes, `server/vm.mjs` pushes
credentials to the desk, and neither belongs in a package. This only decides
what the state is and what to say about it.
