import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  cloudBrainReady,
  cloudComingSoon,
  cloudDeskIdOf,
  cloudDeskReady,
  cloudIntervalFromTriggers,
  cloudOn,
  cloudProductOn,
  canMoveToCloud,
  isCloudChief,
  isCloudPlace,
  isLiveCloud,
  normalizeCloudRoutine,
} from "../web/cloud-place.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The three flags that have to line up before the app is "in" Cloud. */
function ctx(account = {}, rest = {}) {
  return { account, ...rest };
}
const inCloud = ctx({ enabled: true, cloudProduct: true, view: "cloud", signedIn: true });

// --- the gates ------------------------------------------------------------
assert.equal(cloudOn(ctx({ enabled: true })), true);
assert.equal(cloudOn(ctx({ enabled: "yes" })), false, "enabled is strict true, not truthy");
assert.equal(cloudOn(ctx({})), false);
assert.equal(cloudOn(undefined), false, "no state yet must not throw");

assert.equal(cloudProductOn(ctx({ enabled: true, cloudProduct: true })), true);
assert.equal(cloudProductOn(ctx({ enabled: false, cloudProduct: true })), false, "cloudProduct alone is not enough");
assert.equal(cloudProductOn(ctx({ enabled: true })), false);

assert.equal(canMoveToCloud(ctx({ enabled: true, cloudProduct: true, view: "local" })), true, "dev flag on, still local");
assert.equal(canMoveToCloud(ctx({ enabled: true, cloudProduct: false, view: "local" })), false, "packaged release flag off");
assert.equal(canMoveToCloud(inCloud), false, "already in Cloud place");
assert.equal(canMoveToCloud(ctx({ enabled: true, comingSoon: true, cloudProduct: false })), false);
assert.equal(canMoveToCloud(undefined), false);

assert.equal(cloudComingSoon(ctx({ enabled: true, comingSoon: true })), true);
assert.equal(cloudComingSoon(ctx({ comingSoon: true })), false);

assert.equal(isCloudPlace(inCloud), true);
assert.equal(isCloudPlace(ctx({ ...inCloud.account, view: "local" })), false, "the switcher decides the place");
assert.equal(isCloudPlace(ctx({ ...inCloud.account, signedIn: false })), false);
assert.equal(isCloudPlace(ctx({ ...inCloud.account, cloudProduct: false })), false);
assert.equal(isCloudPlace(ctx({})), false);
assert.equal(isCloudPlace(undefined), false);

assert.equal(isLiveCloud(inCloud), true);
assert.equal(isLiveCloud(ctx({ ...inCloud.account, mockAuth: true })), false, "mock accounts are not live Cloud");
assert.equal(isLiveCloud(ctx({ view: "local" })), false);

// --- brain ----------------------------------------------------------------
const draftBrain = ctx({}, { cloudDraft: { brain: { grokSignedIn: true } } });
assert.equal(cloudBrainReady(draftBrain, {}), true, "the desk's shared brain answers for a bot with none");
assert.equal(cloudBrainReady(draftBrain, { brain: { connected: false } }), false, "a bot's own brain wins over the draft");
assert.equal(cloudBrainReady(ctx({}), { brain: { apiKeySet: true } }), true);
assert.equal(cloudBrainReady(ctx({}), { harness: { signedIn: true } }), true);
assert.equal(cloudBrainReady(ctx({}), { harness: { apiKeySet: true } }), true);
assert.equal(cloudBrainReady(ctx({}), {}), false);
assert.equal(cloudBrainReady(ctx({}), null), false);

// --- desk readiness -------------------------------------------------------
const desks = [
  { id: "cmp_a", status: "assigned", ipv4: "10.0.0.4" },
  { id: "cmp_warm", status: "warm", ipv4: "10.0.0.5" },
  { id: "cmp_cold", status: "warming" },
  { id: "cmp_noip", status: "assigned" },
];

// Local bots never wait on a desk.
assert.equal(cloudDeskReady(ctx({ view: "local" }), { computerId: "cmp_cold" }, desks), true);

assert.equal(cloudDeskReady(inCloud, { computerId: "cmp_a" }, desks), true);
assert.equal(cloudDeskReady(inCloud, { vm: { computerId: "cmp_warm" } }, desks), true, "warm counts as ready");
assert.equal(cloudDeskReady(inCloud, { computerId: "cmp_cold" }, desks), false, "a warming desk is not ready");
assert.equal(cloudDeskReady(inCloud, { computerId: "cmp_noip" }, desks), false, "assigned without a route is not ready");
assert.equal(
  cloudDeskReady(inCloud, { computerId: "cmp_noip", vm: { streamUrl: "https://s/1" } }, desks),
  true,
  "a stream URL stands in for the desk's ipv4",
);
assert.equal(cloudDeskReady(inCloud, { desk: { status: "assigned", ipv4: "10.0.0.9" } }, desks), true, "an inlined desk wins");
assert.equal(cloudDeskReady(inCloud, { computerId: "nope" }, desks), false);
assert.equal(cloudDeskReady(inCloud, { vm: { hint: "assigned", streamUrl: "https://s/1" } }, desks), true, "vm.hint stands in for status");
assert.equal(cloudDeskReady(inCloud, null, desks), false);
assert.equal(cloudDeskReady(inCloud, { computerId: "cmp_a" }, undefined), false, "no desk list, no desk");

// --- identity -------------------------------------------------------------
assert.equal(cloudDeskIdOf({ computerId: "a", vm: { computerId: "b" }, desk: { id: "c" } }), "a");
assert.equal(cloudDeskIdOf({ vm: { computerId: "b" }, desk: { id: "c" } }), "b");
assert.equal(cloudDeskIdOf({ desk: { id: "c" } }), "c");
assert.equal(cloudDeskIdOf({}), "");
assert.equal(cloudDeskIdOf(null), "");

assert.equal(isCloudChief({ teamRole: "chief" }), true);
assert.equal(isCloudChief({ id: "cloud-cmp_a", computerId: "cmp_a" }), true, "the bot named after its desk is the chief");
assert.equal(isCloudChief({ id: "cloud-cmp_b", computerId: "cmp_a" }), false);
assert.equal(isCloudChief({ id: "cloud-cmp_a" }), false, "no desk, no chief");
assert.equal(isCloudChief(null), false);

// --- routine reshaping ----------------------------------------------------
assert.equal(normalizeCloudRoutine(null), null);
assert.equal(normalizeCloudRoutine({ name: "no id" }), null);

const r = normalizeCloudRoutine({ id: "r1", intervalMinutes: 30, lastRun: 1700, nextRun: 1900, botId: "b1" });
assert.equal(r.intervalMinutes, 30);
assert.equal(r.intervalMs, 30 * 60_000, "the local painter reads intervalMs");
assert.equal(r.lastRunAt, 1700);
assert.equal(r.nextRunAt, 1900);
assert.equal(r.enabled, true, "enabled defaults on");
assert.equal(r.cloud, true);
assert.equal(r.name, "Routine");
assert.equal(r.botId, "b1");

// Never run stays 0 — as a date, 0 would render as 1970.
const never = normalizeCloudRoutine({ id: "r2", lastRun: 0, nextRun: 0 });
assert.equal(never.lastRunAt, 0);
assert.equal(never.nextRunAt, 0);
assert.equal(never.intervalMinutes, 60, "no interval means hourly");
assert.equal(normalizeCloudRoutine({ id: "r3", intervalMinutes: 1 }).intervalMinutes, 5, "the Worker cron floors at 5 minutes");
assert.equal(normalizeCloudRoutine({ id: "r4", enabled: false }).enabled, false);

// --- triggers -> one interval --------------------------------------------
// Stands in for the shell's normalizeClientTrigger, which is passed in.
const normalize = (t) => (t && t.kind ? t : null);
assert.equal(cloudIntervalFromTriggers([{ kind: "interval", intervalMs: 900_000 }], normalize), 15);
assert.equal(cloudIntervalFromTriggers([{ kind: "hourly", intervalMs: 3600_000 }], normalize), 60);
assert.equal(cloudIntervalFromTriggers([{ kind: "interval", intervalMs: 60_000 }], normalize), 5, "floored at 5 minutes");
assert.equal(cloudIntervalFromTriggers([{ kind: "daily", times: [] }], normalize), null, "Cloud has no calendar triggers");
assert.equal(cloudIntervalFromTriggers([{ kind: "cron", cron: "* * * * *" }], normalize), null);
assert.equal(cloudIntervalFromTriggers([], normalize), null);
assert.equal(cloudIntervalFromTriggers(undefined, normalize), null);
assert.equal(cloudIntervalFromTriggers([null, { kind: "interval", intervalMs: 600_000 }], normalize), 10, "unparseable triggers drop out");

// --- the seam stays sealed -------------------------------------------------
const mod = readFileSync(path.join(root, "web", "cloud-place.mjs"), "utf8");
assert.doesNotMatch(mod, /(^|[^.\w])state\./m, "cloud-place.mjs must take its world as an argument, never read a global");
assert.doesNotMatch(mod, /\b(document|window|localStorage|fetch)\b/, "these predicates must stay browser-free");

const app = readFileSync(path.join(root, "web", "app.js"), "utf8");
assert.match(app, /import \* as cloudPlace from "\.\/cloud-place\.mjs";/);
for (const name of ["cloudOn", "cloudProductOn", "canMoveToCloud", "cloudComingSoon", "cloudBrainReady", "isCloudPlace", "isLiveCloud", "cloudDeskReady", "cloudDeskIdOf", "isCloudChief", "normalizeCloudRoutine", "cloudIntervalFromTriggers"]) {
  assert.match(app, new RegExp(`return cloudPlace\\.${name}\\(`), `app.js must delegate ${name} to cloud-place.mjs`);
}

console.log("ok cloud-place");
