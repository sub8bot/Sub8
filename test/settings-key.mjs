/**
 * PUT /api/settings used to hand the plaintext provider key back to the client
 * on every settings write — including writes that only toggle a sidebar section.
 * GET /api/settings has always masked it. These pin the two routes in agreement.
 *
 * Runs against a real server on a temp data dir (withTempData), never live data.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { withTempData } from "../testing/e2e/harness.mjs";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

const put = (base, body) =>
  fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const getSettings = (base) => fetch(`${base}/api/settings`).then((r) => r.json());

const SECRET = "xai-test-not-a-real-key-0123456789";

await withTempData(async ({ base }) => {
  await test("PUT does not echo the provider key back", async () => {
    const res = await put(base, { harness: { provider: "spacexai", apiKey: SECRET } });
    assert.equal(res.status, 200);
    const seen = JSON.stringify(res.body);
    assert.equal(seen.includes(SECRET), false, "PUT response must not contain the plaintext key");
    assert.equal(res.body.harness.apiKey, "••••");
  });

  await test("GET agrees with PUT on the mask", async () => {
    const s = await getSettings(base);
    assert.equal(s.settings.harness.apiKey, "••••");
    assert.equal(JSON.stringify(s.settings).includes(SECRET), false);
  });

  await test("masking is display-only — the real key is still stored and usable", async () => {
    // The sentinel round-trip is how the client saves without knowing the key:
    // it PUTs "••••" and the route restores the stored value. If masking had
    // clobbered storage, this write would persist the literal bullets.
    const res = await put(base, { harness: { provider: "spacexai", apiKey: "••••", model: "sonnet" } });
    assert.equal(res.body.harness.apiKey, "••••");
    assert.equal(res.body.harness.model, "sonnet");
    // Prove it is the real key underneath, not the sentinel: a write that omits
    // apiKey entirely must still leave a key set.
    const res2 = await put(base, { harness: { provider: "spacexai", model: "fable" } });
    assert.equal(res2.body.harness.apiKey, "••••", "a key is still set");
    assert.equal(res2.body.harness.model, "fable");
  });

  await test("a write that does not touch harness still masks", async () => {
    const res = await put(base, { sidebarSections: ["a", "b"] });
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false, "a sidebar toggle leaked the key");
    assert.equal(res.body.harness.apiKey, "••••");
  });

  await test("no key set reads as empty, not as bullets", async () => {
    const res = await put(base, { harness: { provider: "grok-build", apiKey: "" } });
    assert.equal(res.body.harness.apiKey, "");
  });

  // express 5 leaves req.body UNDEFINED for a request it did not parse (no JSON
  // content-type); express 4 gave {}. Fifteen routes in index.mts dereference
  // req.body.<prop> directly, so every one of them answered 500 with
  // "TypeError: Cannot read properties of undefined" on a request without the
  // header. A middleware now normalises req.body to {} once, for all of them.
  await test("a request with no JSON content-type does not 500", async () => {
    const raw = await fetch(`${base}/api/settings`, { method: "PUT", body: "x=1" });
    assert.notEqual(raw.status, 500, "PUT /api/settings crashed on an unparsed body");
    assert.equal(raw.status, 200);

    // Spot-check other routes in the same class: they may legitimately 400 or
    // 404, but never 500.
    for (const [method, url] of [
      ["POST", "/api/channels"],
      ["POST", "/api/bots/nope/pin"],
    ]) {
      const r = await fetch(`${base}${url}`, { method, body: "x=1" });
      assert.notEqual(r.status, 500, `${method} ${url} crashed on an unparsed body`);
    }
  });

  // And the parsed path is untouched.
  await test("a normal JSON body still round-trips", async () => {
    const res = await put(base, { sidebarSections: ["a", "b"] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.sidebarSections, ["a", "b"]);
  });

  // NOT a fix, a record of current behaviour. normalizeHarness falls back to
  // grok-build for an unlisted provider but KEEPS the baseUrl it arrived with,
  // and this route merges the stored apiKey back in — so a settings body naming
  // a foreign host leaves the real key pointed at that host. Narrowing it would
  // break a legitimate proxy baseUrl, so it is a product decision, not a bug
  // fix. This test exists so the behaviour cannot change silently.
  await test("KNOWN: a foreign baseUrl is accepted and keeps the stored key", async () => {
    await put(base, { harness: { provider: "spacexai", apiKey: SECRET } });
    const res = await put(base, { harness: { provider: "spacexai", baseUrl: "https://example.invalid/v1" } });
    assert.equal(res.body.harness.baseUrl, "https://example.invalid/v1");
    assert.equal(res.body.harness.apiKey, "••••", "the stored key rides along to the new host");
  });
});

await test("a key typed on a non-default harness tab is never persisted", async () => {
  // Settings.harness is ONE flat record. Writing a key typed on another tab
  // spread it over the DEFAULT provider's record, so the key went out to the
  // wrong provider's endpoint -- an OpenAI key sent to api.x.ai as a bearer
  // token, immediately, by the Test button beside the field. The guard used to
  // cover only `model`.
  const src = await fs.readFile(new URL("../web/app.ts", import.meta.url), "utf8");
  const guard = /if \(tab && tab !== \(state\.settings\?\.harness\?\.provider \|\| "grok-build"\)\) \{\s*\n\s*return;/;
  assert.match(src, guard, "the cross-tab guard must cover every field, not just `model`");
  assert.equal(
    /tab !== \(state\.settings\?\.harness\?\.provider \|\| "grok-build"\) && el\.dataset\.harnessText === "model"/.test(src),
    false,
    "the model-only form of the guard is back — apiKey and baseUrl fall through it",
  );
});


const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok settings-key");
process.exit(failed.length ? 1 : 0);
