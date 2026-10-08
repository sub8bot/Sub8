/**
 * Harness usage limits, end to end on the desktop side.
 *
 * KekiusBot (2026-10-01..02): a Claude identity out of weekly quota and a
 * routine every 10 minutes left 60+ identical "You've hit your weekly limit"
 * rows. Switching the Claude account did not help either: the desk kept its
 * old, still-logged-in credential because it only adopted the account's when
 * it was logged OUT.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUsageLimit, parseResetAt, isUsageLimitNotice, activeBotLimit, routinePausedNotice, USAGE_LIMIT_RE } from "../server/usage-limit.mjs";
import { shouldAdoptClaudeCredentials, isUsageLimitNotice as deskIsLimit } from "../server/desk-harness/harness.mjs";
import { applyCloudTurns } from "../server/account.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.UTC(2026, 9, 2, 17, 0);
const LIMIT = "You've hit your weekly limit · resets Oct 3, 4pm (UTC)";

/* --- the line, and when it lifts --- */
assert.equal(new Date(parseUsageLimit(LIMIT, now).until).toISOString(), "2026-10-03T16:00:00.000Z");
assert.equal(parseUsageLimit(LIMIT, now).message, LIMIT);
assert.equal(new Date(parseResetAt("You've hit your weekly limit · resets 4pm (UTC)", now)).toISOString(), "2026-10-03T16:00:00.000Z", "a bare time already past today is tomorrow");
assert.equal(new Date(parseResetAt("resets 6pm (UTC)", now)).toISOString(), "2026-10-02T18:00:00.000Z", "later today stays today");
assert.equal(new Date(parseResetAt("5-hour limit reached ∙ resets 3am (America/New_York)", now)).toISOString(), "2026-10-03T07:00:00.000Z");
assert.equal(new Date(parseResetAt("resets Jan 2, 9am (UTC)", Date.UTC(2026, 11, 30))).toISOString(), "2027-01-02T09:00:00.000Z", "a January reset read in December is next year");
assert.equal(parseUsageLimit("Claude AI usage limit reached|1790964000", now).until, 1790964000_000);
assert.equal(parseUsageLimit("Claude AI usage limit reached|1790964000", now).message, "Claude AI usage limit reached");
assert.equal(parseUsageLimit("You've reached your usage limit.", now).until, now + 3600_000, "unreadable reset: look again in an hour");
assert.ok(parseUsageLimit("You've hit your weekly limit · resets Oct 9, 4pm (UTC)", now).until <= now + 8 * 86400_000, "never parked for more than a week-ish");
for (const benign of ["hi", "The site says I'm rate limited, trying again later.", "Your weekly report is ready.", "x".repeat(700) + " You've hit your weekly limit"]) {
  assert.equal(parseUsageLimit(benign, now), null, `not a quota notice: ${benign.slice(0, 40)}`);
}
assert.ok(isUsageLimitNotice(LIMIT));
assert.ok(USAGE_LIMIT_RE.test("You’ve hit your session limit"), "curly apostrophe");

/* --- a record applies only to the identity that hit it --- */
const record = { until: now + 3600_000, message: LIMIT, at: now, identityId: "id-claude-host", provider: "claude" };
const bot = { identityId: "id-claude-host", harness: { provider: "claude" }, usageLimit: record };
assert.ok(activeBotLimit(bot, now));
assert.equal(activeBotLimit(bot, now + 3600_001), null, "past the reset");
assert.equal(activeBotLimit({ ...bot, identityId: "id-codex-host", harness: { provider: "codex" } }, now), null, "switched identity");
assert.equal(activeBotLimit({ ...bot, harness: { provider: "grok-build" } }, now), null, "switched harness");
assert.equal(activeBotLimit({ ...bot, usageLimit: null }, now), null);
assert.match(routinePausedNotice(record, now), /paused my routines/);
assert.match(routinePausedNotice(record, now), /another identity/);
assert.doesNotMatch(routinePausedNotice(record, now), /[\u2013\u2014]/, "no dashes in UI copy");

/* --- the desk harness: adopt the account's NEW login over a stale one --- */
const cred = (refreshToken, expiresAt, accessToken = "at-" + refreshToken) => ({ claudeAiOauth: { refreshToken, accessToken, expiresAt } });
assert.equal(shouldAdoptClaudeCredentials(cred("new", 2000), null), true, "logged-out desk adopts");
assert.equal(shouldAdoptClaudeCredentials(cred("new", 2000), cred("old", 1000)), true, "a newer different login replaces the old one");
assert.equal(shouldAdoptClaudeCredentials(cred("same", 1000), cred("same", 3000)), false, "same login: the desk keeps its refreshed token");
assert.equal(shouldAdoptClaudeCredentials(cred("stale", 1000), cred("rotated", 3000)), false, "the desk refreshed past the account copy: keep it");
assert.equal(shouldAdoptClaudeCredentials({ claudeAiOauth: { accessToken: "", refreshToken: "" } }, cred("old", 1)), false, "a hollow account copy never replaces a login");
assert.equal(shouldAdoptClaudeCredentials(null, cred("old", 1)), false);
assert.equal(deskIsLimit(LIMIT), true);
assert.equal(deskIsLimit("Posted the update."), false);

/* --- cloud snapshot: busy is the Worker's truth, not a client poll --- */
{
  const cid = "cmp_e7e1d95225a0";
  const chief = { id: `cloud-${cid}`, harness: { provider: "claude" } };
  const worker = { id: `cloud-${cid}-freebotsmana`, harness: { provider: "claude" } };
  const idle = { id: `cloud-${cid}-idle`, harness: { provider: "grok-build" } };
  const until = Date.now() + 3600_000;
  applyCloudTurns([chief, worker, idle], cid, {
    turns: [
      // The Worker stores the chief as "" on routine fires.
      { turnId: "t1", botId: "", status: "running", display: 1, routine: true, createdAt: 1, startedAt: 2, position: 0 },
      { turnId: "t2", botId: `cloud-${cid}`, status: "queued", display: 1, routine: false, createdAt: 3, startedAt: 0, position: 1 },
      { turnId: "t3", botId: worker.id, status: "queued", display: 2, routine: false, createdAt: 4, startedAt: 0, position: 0 },
    ],
    usageLimits: { claude: { until, message: LIMIT } },
  });
  assert.equal(chief.cloudBusy, true);
  assert.equal(chief.cloudTurn.turnId, "t1", "the running turn is the one to show");
  assert.equal(worker.cloudBusy, true);
  assert.equal(idle.cloudBusy, false);
  assert.equal(idle.cloudTurn, null);
  assert.equal(chief.usageLimit.message, LIMIT);
  assert.equal(idle.usageLimit, null, "grok is not the out-of-quota identity");
  const untouched = { id: "x", harness: {} };
  applyCloudTurns([untouched], cid, null);
  assert.equal(untouched.cloudBusy, undefined, "no answer from the Worker: no claim either way");
}

/* --- wiring (driving these needs a live harness turn) --- */
const index = readFileSync(path.join(root, "server/index.mts"), "utf8");
const tick = index.slice(index.indexOf("async function tickRoutines"));
assert.match(tick, /if \(activeBotLimit\(bot, now\)\) continue;[\s\S]{0,80}packDue/, "routines skip, unstamped, while the identity is out of quota");
const run = index.slice(index.indexOf("async function runUserTurn"));
assert.match(run.slice(0, run.indexOf("finally {")), /await settleUsageLimit\(botId, bot, turnStart, hidden\)/, "every finished turn settles the limit record");
assert.match(index, /prevIdentity !== nextIdentity \|\| prevEffective !== nextEffective\) bot\.usageLimit = null/, "PATCH to another identity clears the limit");
const stop = index.slice(index.indexOf("function stopTurn"), index.indexOf("function stopTurn") + 900);
assert.match(stop, /releaseTurnLock\(botId\)/, "Stop frees the queue even if the aborted turn hangs");
assert.match(run, /TURN_WATCHDOG_MS/, "a turn that never settles is ended");
assert.match(run.slice(run.indexOf("finally {")), /inflightTurns\.get\(botId\) === bag/, "an old turn's finally must not clear a newer turn's state");

/* --- an identity switch actually switches: the in-desk grok harness is grok-only --- */
const agent = readFileSync(path.join(root, "server/agent.mts"), "utf8");
assert.match(
  agent,
  /harness\.provider === "grok-build"(?: && !ownGrokLogin)?\s*\?\s*await tryDeskBrain\(/,
  "a Claude/Codex/API bot must not be answered by the desk's grok (found live: a 'custom' bot replied via grok on the host login)",
);

/* --- the desk prompt: "hi" is conversation, not a tool demo --- */
const harness = readFileSync(path.join(root, "server/desk-harness/harness.mts"), "utf8");
assert.doesNotMatch(harness, /Use the sub8 tools\. Do not only send a plan\./, "the unconditional tool nudge made a greeting run screenshots");
assert.match(harness, /If this needs the computer, use the sub8 tools/);

console.log("ok usage-limit");
