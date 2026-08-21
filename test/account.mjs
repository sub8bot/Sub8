import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-account-"));
process.env.SUB8BOT_DATA = tmp;
process.env.SUB8_CLOUD = "1";
process.env.SUB8_CLOUD_URL = "mock";
delete process.env.SUB8_ACCOUNT;
delete process.env.SUB8_REQUIRE_ACCOUNT;
delete process.env.SUB8_PACKAGED;
delete process.env.SUB8_MOCK_AUTH;

const account = await import(path.join(root, "server/account.mjs"));

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

await test("account flag off returns a local-only account", () => {
  const prev = process.env.SUB8_ACCOUNT;
  process.env.SUB8_ACCOUNT = "0";
  const g = account.disabledAccount();
  assert.equal(g.enabled, false);
  assert.equal(g.ready, true);
  assert.equal(g.needsChoice, false);
  assert.equal(g.needsCloudPrompt, false);
  if (prev == null) delete process.env.SUB8_ACCOUNT;
  else process.env.SUB8_ACCOUNT = prev;
});

await test("without SUB8_CLOUD, login is on and desks are coming soon", () => {
  const prev = process.env.SUB8_CLOUD;
  delete process.env.SUB8_CLOUD;
  const g = account.publicAccount({ place: "local", session: null }, { requireAccount: false });
  assert.equal(g.enabled, true);
  assert.equal(g.comingSoon, true);
  assert.equal(g.cloudProduct, false);
  assert.equal(g.ready, true);
  assert.equal(g.needsChoice, false);
  assert.equal(g.xLogin, false);
  process.env.SUB8_CLOUD = prev;
});

await test("empty new user needs a choice", () => {
  const g = account.decideGate({ place: null, session: null }, { requireAccount: false, hasLocalBots: false });
  assert.equal(g.ready, false);
  assert.equal(g.needsChoice, true);
  assert.equal(g.hideLocal, false);
  assert.equal(g.place, null);
});

await test("existing local bots are grandfathered", () => {
  const g = account.decideGate({ place: null, session: null }, { requireAccount: false, hasLocalBots: true });
  assert.equal(g.ready, true);
  assert.equal(g.place, "local");
  assert.equal(g.inferred, true);
  assert.equal(g.needsChoice, false);
  assert.equal(g.needsCloudPrompt, true);
});

await test("don't-show-again silences the cloud invite", () => {
  const g = account.decideGate(
    { place: "local", session: null, cloudPromptDismissed: true },
    { requireAccount: false, hasLocalBots: true },
  );
  assert.equal(g.ready, true);
  assert.equal(g.needsCloudPrompt, false);
});

await test("this Mac is ready without a vendor login", () => {
  const g = account.decideGate({ place: "local", session: null }, { requireAccount: false });
  assert.equal(g.ready, true);
  assert.equal(g.signedIn, false);
  assert.equal(g.cloudEnabled, false);
});

await test("cloud place without session is not ready", () => {
  const g = account.decideGate({ place: "cloud", session: null }, { requireAccount: false });
  assert.equal(g.ready, false);
  assert.equal(g.needsChoice, true);
});

await test("cloud place with live session is ready", () => {
  const g = account.decideGate(
    { place: "cloud", session: { email: "dan@example.com", userId: "usr_1", token: "x" } },
    { requireAccount: false },
  );
  assert.equal(g.ready, true);
  assert.equal(g.signedIn, true);
  assert.equal(g.email, "dan@example.com");
  assert.equal(g.cloudEnabled, true);
});

await test("require-account hides this-Mac on a blank install", () => {
  const g = account.decideGate({ place: null, session: null }, { requireAccount: true, hasLocalBots: false });
  assert.equal(g.ready, false);
  assert.equal(g.hideLocal, true);
  assert.equal(g.needsChoice, true);
});

await test("require-account still grandfathers a Mac that already has bots", () => {
  const g = account.decideGate({ place: null, session: null }, { requireAccount: true, hasLocalBots: true });
  assert.equal(g.ready, true);
  assert.equal(g.place, "local");
  assert.equal(g.hideLocal, false);
});

await test("expired session is signed out", () => {
  assert.equal(
    account.sessionLive({ email: "a@b.co", expiresAt: Date.now() - 1000 }),
    false,
  );
  assert.equal(account.sessionLive({ email: "a@b.co", expiresAt: Date.now() + 60_000 }), true);
});

await test("loadAccount writes inferred local when bots exist", async () => {
  const row = await account.loadAccount({ hasLocalBots: true });
  assert.equal(row.place, "local");
  assert.equal(row.inferred, true);
  const disk = JSON.parse(await fs.readFile(account.accountPath(), "utf8"));
  assert.equal(disk.place, "local");
  assert.equal(disk.session, null);
});

await test("chooseLocal then mock magic signs into cloud", async () => {
  await account.chooseLocal();
  const afterLocal = account.publicAccount(await account.loadAccount(), { requireAccount: false });
  assert.equal(afterLocal.place, "local");
  assert.equal(afterLocal.signedIn, false);

  const magic = await account.startMagic("Dan@Example.COM");
  assert.equal(magic.mock, true);
  assert.equal(magic.signedIn, true);
  assert.equal(magic.email, "dan@example.com");

  const pub = account.publicAccount(await account.loadAccount(), { requireAccount: false });
  assert.equal(pub.ready, true);
  assert.equal(pub.place, "cloud");
  assert.equal(pub.signedIn, true);
  assert.equal(pub.email, "dan@example.com");
  const raw = JSON.parse(await fs.readFile(account.accountPath(), "utf8"));
  assert.ok(raw.session.token);
  assert.equal(pub.token, undefined);
});

await test("bad email is rejected", async () => {
  await assert.rejects(() => account.startMagic("not-an-email"), /valid email/);
});

await test("default cloud URL is sub8.bot and is not mock", () => {
  process.env.SUB8_PACKAGED = "1";
  delete process.env.SUB8_CLOUD_URL;
  assert.equal(account.useMockAuth(), false);
  assert.equal(account.cloudBaseUrl(), "https://sub8.bot");
  assert.equal(account.publicAccount({ place: "local", session: null }).xLogin, true);
  delete process.env.SUB8_PACKAGED;
  process.env.SUB8_CLOUD_URL = "mock";
});

await test("auth backend is dummy on mock URL and http otherwise", async () => {
  const cloud = await import(path.join(root, "server/cloud/index.mjs"));
  delete process.env.SUB8_PACKAGED;
  process.env.SUB8_CLOUD_URL = "mock";
  assert.equal(cloud.authBackend().kind, "dummy");
  process.env.SUB8_CLOUD_URL = "https://api.example.test";
  assert.equal(cloud.authBackend().kind, "http");
  assert.equal(cloud.useMockAuth(), false);
  process.env.SUB8_CLOUD_URL = "mock";
  const dummy = await cloud.startMagic("dev@example.com");
  assert.equal(dummy.mock, true);
  assert.equal(dummy.session.email, "dev@example.com");
  assert.match(dummy.session.token, /^dummy_/);
});

await test("dummy Sign in with X stores a session", async () => {
  await account.logout();
  const started = await account.startX();
  assert.equal(started.mock, true);
  assert.equal(started.signedIn, true);
  const pub = account.publicAccount(await account.loadAccount(), { requireAccount: false });
  assert.equal(pub.signedIn, true);
  assert.equal(pub.handle, "dev");
});

await test("waitX is a no-op once a session is already stored", async () => {
  const waited = await account.waitX("stale-state");
  assert.equal(waited.signedIn, true);
});

await test("setView cloud is blocked while desks are coming soon", async () => {
  const prev = process.env.SUB8_CLOUD;
  delete process.env.SUB8_CLOUD;
  await account.chooseLocal();
  await assert.rejects(() => account.setView("cloud"), /coming soon/);
  process.env.SUB8_CLOUD = prev;
});

await test("chooseLocal is blocked when account is required", async () => {
  process.env.SUB8_REQUIRE_ACCOUNT = "1";
  await assert.rejects(() => account.chooseLocal(), /requires a Sub8 account/);
  delete process.env.SUB8_REQUIRE_ACCOUNT;
});

await test("chooseLocal dismisses the launch invite", async () => {
  await fs.rm(account.accountPath(), { force: true });
  await account.chooseLocal();
  const pub = account.publicAccount(await account.loadAccount(), { requireAccount: false });
  assert.equal(pub.place, "local");
  assert.equal(pub.needsCloudPrompt, false);
  assert.equal(pub.cloudPromptDismissed, true);
});

await test("setView cloud requires a session", async () => {
  await account.chooseLocal();
  await assert.rejects(() => account.setView("cloud"), /Sign in/);
});

await test("logout drops the session and stays on this Mac when not required", async () => {
  process.env.SUB8_CLOUD_URL = "mock";
  await account.signInMock("out@example.com");
  const after = await account.logout();
  assert.equal(after.place, "local");
  assert.equal(after.session, null);
  process.env.SUB8_CLOUD_URL = "mock";
});

await fs.rm(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`${failed.length} failed`);
  process.exit(1);
}
console.log("ok account");
