import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Every assertion below is about how the dispatch table is WRITTEN — where
// bindDelegated() starts and ends, which keys the ACTIONS object literal
// declares, which `act === "…"` branches survive in the if-chain — so it reads
// web/app.ts, the source, rather than the JS tsc emits from it. The emit is
// re-indented and re-wrapped by tsc's printer, which would make the slicing
// below assert the printer instead of this codebase. web/app.js is checked for
// what it ships, in test/app-boot.mjs.
const app = readFileSync(path.join(root, "web", "app.ts"), "utf8");

// Every data-act value the delegated click handler answered to before it started
// moving into the ACTIONS dispatch table. Captured mechanically from the chain at
// 6a93899 (the commit before the table landed). The handler is mid-migration: a
// branch lives either as an ACTIONS entry or as a surviving `act === "…"` block in
// bindDelegated, and the two together must cover exactly this set. A branch that is
// silently dropped on the way into the table is invisible until a user clicks it,
// so pin the set rather than trusting the diff.
const HANDLED = [
  "account-billing",
  "account-cloud-later",
  "account-cloud-never",
  "account-local",
  "account-logout",
  "account-magic",
  "account-settings",
  "account-x",
  "add-login-cloud",
  "add-login-open",
  "add-routine",
  "advanced",
  "attach-files",
  "avatar-anim",
  "avatar-body",
  "avatar-edit",
  "avatar-face",
  "avatar-photo-clear",
  "avatar-type",
  "bot-color",
  "bot-notify",
  "bot-settings",
  "brain-api-save",
  "brain-install",
  "brain-later",
  "brain-preset",
  "brain-signin",
  "brain-tab",
  "brain-use",
  "chat-more",
  "check-update",
  "claude-code-submit",
  "claude-login",
  "claude-login-cancel",
  "claude-logout",
  "close-modal",
  "close-teach",
  "cloud-brain-grok",
  "cloud-brain-key-save",
  "cloud-harness-grok",
  "cloud-harness-key",
  "cloud-new-computer",
  "collapse-full",
  "collapse-pane",
  "computer-act",
  "computer-attach",
  "computer-attach-open",
  "computer-move-cloud",
  "computer-place",
  "computer-select",
  "computer-view",
  "computers",
  "confirm-create",
  "confirm-create-team",
  "copy-link",
  "create",
  "create-face",
  "create-pay-back",
  "create-sku",
  "create-team",
  "ctx-close",
  "ctx-copy",
  "ctx-create-section",
  "ctx-del",
  "ctx-del-msg",
  "ctx-delete-section",
  "ctx-dup",
  "ctx-edit",
  "ctx-hide",
  "ctx-move",
  "ctx-move-cloud",
  "ctx-move-open",
  "ctx-new-section",
  "ctx-pin",
  "ctx-rename-section",
  "ctx-rename-section-open",
  "ctx-rename-tab",
  "ctx-rename-tab-open",
  "ctx-rename-team",
  "ctx-rename-team-open",
  "ctx-snapshots",
  "ctx-tab-remove",
  "ctx-team-del",
  "ctx-team-dup",
  "ctx-team-hide",
  "ctx-unread",
  "cycle-desk",
  "delete-bot",
  "delete-bot-go",
  "delete-routine",
  "delete-routine-editor",
  "desk-image-del",
  "desk-restore",
  "desk-snap",
  "desk-start-new",
  "dictate",
  "dismiss-choice",
  "dismiss-docker-gate",
  "dismiss-harness-banner",
  "dismiss-job",
  "dismiss-update",
  "docker-desktop-docs",
  "drop-attach",
  "edit-bot",
  "edit-routine",
  "expand-pane",
  "grok-auth-later",
  "grok-auth-now",
  "grok-oauth",
  "harness-ctx",
  "harness-default",
  "harness-menu",
  "harness-open",
  "harness-place",
  "hidden-restore",
  "hide-team-brief",
  "identity-add",
  "identity-remove",
  "install-docker",
  "install-update",
  "lightbox-close",
  "lol",
  "lol-create",
  "lol-send",
  "mention",
  "open-brain-setup",
  "open-computer",
  "open-computer-bot",
  "open-desk",
  "open-harness",
  "open-passwords",
  "open-site",
  "open-url",
  "open-vm-browser",
  "pick-choice",
  "picker",
  "place",
  "plugin-connect",
  "plus-menu",
  "profile",
  "reboot-vm",
  "recover-docker",
  "refresh-cloud-plugins",
  "refresh-harness-status",
  "refresh-local-harness",
  "refresh-plugins",
  "refresh-stream",
  "release-control",
  "reload-vm",
  "reset-vm",
  "routine-enabled",
  "routine-group",
  "save-bot",
  "save-routine",
  "sched-add-time",
  "sched-advanced-add",
  "sched-edit",
  "sched-interval-add",
  "sched-kind",
  "sched-kind-open",
  "sched-open",
  "sched-remove",
  "sched-time",
  "sec",
  "select",
  "select-channel",
  "select-team",
  "send",
  "send-choice",
  "set-harness",
  "set-pref",
  "settings",
  "shot-open",
  "show-team-brief",
  "start-teach",
  "stop-teach",
  "stop-turn",
  "take-control",
  "teach-task",
  "team-channel",
  "team-tab",
  "test-harness",
  "test-routine",
  "toggle-computer",
  "toggle-routine",
  "vault",
  "vault-add-account",
  "vault-add-group",
  "vault-always-on",
  "vault-cancel",
  "vault-cloud-cancel",
  "vault-cloud-cancel-bg",
  "vault-cloud-disable",
  "vault-cloud-disable-cancel",
  "vault-cloud-disable-confirm",
  "vault-cloud-enable",
  "vault-cloud-enable-open",
  "vault-cloud-forgot",
  "vault-cloud-lock",
  "vault-cloud-unlock",
  "vault-cloud-unlock-open",
  "vault-delete",
  "vault-edit",
  "vault-export",
  "vault-fill-approve",
  "vault-fill-deny",
  "vault-group",
  "vault-import",
  "vault-reveal",
  "vault-save",
  "vault-share-bot",
  "vault-share-pack",
  "vault-share-toggle",
];

function bindDelegatedSource() {
  const start = app.indexOf("function bindDelegated(): void {");
  assert.notEqual(start, -1, "bindDelegated() not found in web/app.ts");
  const end = app.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "bindDelegated() has no top-level closing brace");
  return app.slice(start, end);
}

function actionTableKeys() {
  const start = app.indexOf("\nconst ACTIONS: Record<string, ActHandler> = {");
  assert.notEqual(start, -1, "const ACTIONS table not found in web/app.ts");
  const end = app.indexOf("\n};\n", start);
  assert.notEqual(end, -1, "const ACTIONS table is not closed at top level");
  return [...app.slice(start, end).matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
}

const delegated = bindDelegatedSource();
const keys = actionTableKeys();
const chain = [...delegated.matchAll(/act === "([^"]+)"/g)].map((m) => m[1]);

// The table has to be the lookup the handler actually uses.
assert.match(delegated, /Object\.hasOwn\(ACTIONS, act\)/, "the delegated click handler must look act up in ACTIONS");
assert.match(delegated, /!== FALL_THROUGH\) return;/, "a handler that does not fall through must end the click handler");
assert.match(app, /const FALL_THROUGH = Symbol\(/, "FALL_THROUGH sentinel missing");
assert.match(
  app,
  /const chainActs = \(\.\.\.fns: ActHandler\[\]\): ActHandler =>/,
  "chainActs composer missing - acts whose branch was split in two need it",
);

// A repeated key silently drops the earlier handler.
const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
assert.deepEqual(dupes, [], "duplicate ACTIONS keys: " + dupes.join(", "));

// The proof: table keys plus whatever is still in the if-chain must equal the set
// the chain handled before the conversion started. Not more, not fewer.
const covered = [...new Set([...keys, ...chain])].sort();
const expected = [...HANDLED].sort();
const missing = expected.filter((a) => !covered.includes(a));
const extra = covered.filter((a) => !expected.includes(a));
assert.deepEqual(missing, [], "data-act values no longer handled anywhere: " + missing.join(", "));
assert.deepEqual(extra, [], "data-act values handled that were not before: " + extra.join(", "));
assert.deepEqual(covered, expected);

// Guard the guard: an empty pin would make every assertion above vacuous.
// 173 -> 175: ctx-move-cloud / computer-move-cloud.
// 175 -> 176: team-channel (the lead's tab is the team channel).
// 176 -> 177: identity-remove (Identities → Remove a login).
// 177 -> 178: copy-link (card hints with a URL: Copy link).
assert.equal(HANDLED.length, 213);
assert.equal(covered.length, 213);

console.log(
  "ok delegated-acts (" + keys.length + " in ACTIONS, " + new Set(chain).size +
    " still in the if-chain, " + covered.length + " covered)",
);
