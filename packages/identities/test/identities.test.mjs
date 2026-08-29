import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttach,
  catalog,
  isIdentityProvider,
  kindForProvider,
  listByPlace,
  migrateProviderToIdentity,
  normalizeIdentity,
  resolveAttach,
} from "../dist/index.js";

test("catalog includes cursor and API providers", () => {
  const ids = catalog().map((row) => row.id);
  assert.ok(ids.includes("cursor"));
  assert.ok(ids.includes("openrouter"));
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("custom"));
  assert.equal(ids.includes("sub8"), false);
});

test("kindForProvider", () => {
  assert.equal(kindForProvider("claude"), "cli-oauth");
  assert.equal(kindForProvider("lmstudio"), "local-openai");
  assert.equal(kindForProvider("spacexai"), "api-key");
  assert.equal(kindForProvider("sub8"), "sub8-metered");
});

test("normalizeIdentity drops unknown providers", () => {
  assert.equal(normalizeIdentity({ id: "x", provider: "nope" }), null);
  const row = normalizeIdentity({ id: "a", provider: "claude", subject: "dan@x.com" });
  assert.equal(row?.kind, "cli-oauth");
  assert.equal(row?.runtimeRef, "host");
  assert.match(row?.label || "", /Claude/);
});

test("migrateProviderToIdentity wraps a host login", () => {
  const row = migrateProviderToIdentity("claude", { subject: "a@b.com" });
  assert.equal(row.provider, "claude");
  assert.equal(row.runtimeRef, "host");
  assert.equal(row.place, "local");
  assert.ok(isIdentityProvider(row.provider));
});

test("resolveAttach prefers identityId then provider alias", () => {
  const claude = migrateProviderToIdentity("claude", { id: "id-claude" });
  const grok = migrateProviderToIdentity("grok-build", { id: "id-grok" });
  const fromId = resolveAttach({ identityId: "id-claude" }, [claude, grok]);
  assert.equal(fromId?.identityId, "id-claude");
  const fromProvider = resolveAttach({ harness: { provider: "grok-build", model: "grok-4.6" } }, [claude, grok]);
  assert.equal(fromProvider?.identityId, "id-grok");
  assert.equal(fromProvider?.model, "grok-4.6");
});

test("canAttach and listByPlace", () => {
  const local = migrateProviderToIdentity("claude", { id: "l" });
  const cloud = migrateProviderToIdentity("claude", { id: "c", place: "cloud", runtimeRef: "cmp_1" });
  assert.equal(canAttach(local, "signed_in"), true);
  assert.equal(canAttach(local, "signed_out"), false);
  const metered = migrateProviderToIdentity("sub8", { id: "s" });
  assert.equal(canAttach(metered), false);
  assert.equal(listByPlace([local, cloud], "cloud").length, 1);
});
