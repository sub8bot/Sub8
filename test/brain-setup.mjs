import assert from "node:assert/strict";
import {
  API_PRESETS,
  HARNESS_INSTALL,
  HARNESS_SETUP_IDS,
  applySimulate,
  brainSetupHtml,
  harnessAction,
  harnessSetupBannerHtml,
  needsBrainSetup,
} from "../web/brain-setup.mjs";

function fakeStatus(overrides = {}) {
  const harnesses = {};
  for (const id of HARNESS_SETUP_IDS) {
    harnesses[id] = {
      id,
      label: id,
      installed: false,
      ready: false,
      signedIn: false,
      detail: `${id} is not installed.`,
    };
  }
  Object.assign(harnesses, overrides);
  return { harnesses, catalog: HARNESS_SETUP_IDS.map((id) => ({ id, label: id })) };
}

assert.equal(needsBrainSetup({ harness: { setupComplete: true } }, fakeStatus()), false);
assert.equal(needsBrainSetup({ harness: { setupSkipped: true } }, fakeStatus()), false);
assert.equal(needsBrainSetup({ harness: { provider: "grok-build" } }, fakeStatus()), true);
assert.equal(
  needsBrainSetup(
    { harness: { provider: "grok-build" } },
    fakeStatus({ "grok-build": { id: "grok-build", label: "Grok Build", ready: true, installed: true, signedIn: true } }),
  ),
  false,
);

const missing = applySimulate(fakeStatus({ "grok-build": { id: "grok-build", label: "Grok Build", installed: true, ready: true, signedIn: true } }), "none");
assert.equal(missing.harnesses["grok-build"].installed, false);
assert.equal(missing.harnesses["grok-build"].ready, false);

assert.equal(harnessAction({ ready: true, label: "Grok Build" }).kind, "use");
assert.equal(harnessAction({ id: "grok-build", installed: true, signedIn: false, ready: false }).kind, "signin");
assert.equal(harnessAction({ installed: false, ready: false }).kind, "install");

const htmlNone = brainSetupHtml({ tab: "harness", harnesses: missing.harnesses, catalog: missing.catalog });
assert.match(htmlNone, /How should Sub8 think/);
assert.match(htmlNone, /AI Harness/);
assert.match(htmlNone, /data-act="brain-tab" data-id="api"/);
for (const id of HARNESS_SETUP_IDS) {
  assert.match(htmlNone, new RegExp(`data-act="brain-install" data-id="${id}"`));
}
assert.doesNotMatch(htmlNone, /Sign in to Grok/);

const grokInstalled = fakeStatus({
  "grok-build": { id: "grok-build", label: "Grok Build", installed: true, signedIn: false, ready: false, detail: "Needs login" },
});
const htmlSign = brainSetupHtml({ tab: "harness", harnesses: grokInstalled.harnesses, catalog: grokInstalled.catalog });
assert.match(htmlSign, /data-act="brain-signin" data-id="grok-build"/);
assert.match(htmlSign, /Needs sign-in/);

const grokReady = fakeStatus({
  "grok-build": { id: "grok-build", label: "Grok Build", installed: true, signedIn: true, ready: true, detail: "Ready" },
});
const htmlUse = brainSetupHtml({ tab: "harness", harnesses: grokReady.harnesses, catalog: grokReady.catalog });
assert.match(htmlUse, /data-act="brain-use" data-id="grok-build"/);
assert.match(htmlUse, /Use Grok Build/);

const htmlApi = brainSetupHtml({ tab: "api", api: { preset: "openrouter" } });
assert.match(htmlApi, /OpenRouter/);
assert.match(htmlApi, /openrouter\.ai\/api\/v1/);
assert.match(htmlApi, /chat\/completions/);
assert.match(htmlApi, /data-act="brain-api-save"/);
for (const p of API_PRESETS) assert.match(htmlApi, new RegExp(p.label));

const htmlCustom = brainSetupHtml({ tab: "api", api: { preset: "custom", baseUrl: "https://my.llm/v1", model: "foo" } });
assert.match(htmlCustom, /https:\/\/my\.llm\/v1/);
assert.match(htmlCustom, /value="foo"/);

const bannerMissing = harnessSetupBannerHtml({ id: "grok-build", label: "Grok Build", installed: false, signedIn: false, detail: "Grok Build is not installed." });
assert.match(bannerMissing, /Grok Build is not installed/);
assert.match(bannerMissing, /data-act="open-brain-setup"/);
assert.match(bannerMissing, /class="pill accent"/);
assert.doesNotMatch(bannerMissing, /Open Settings/);
assert.doesNotMatch(bannerMissing, /update-strip/);

const bannerSign = harnessSetupBannerHtml({ id: "grok-build", label: "Grok Build", installed: true, signedIn: false, detail: "Needs login" });
assert.match(bannerSign, /needs a sign-in/);
assert.match(bannerSign, />Sign in</);

assert.equal(HARNESS_INSTALL["grok-build"].url, "https://x.ai/cli");
assert.match(HARNESS_INSTALL["grok-build"].cmd, /x\.ai\/cli\/install\.sh/);
assert.doesNotMatch(HARNESS_INSTALL["grok-build"].url, /docs\.x\.ai\/docs\//);

console.log("ok brain-setup");
