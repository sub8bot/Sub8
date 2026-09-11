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
  process.env.SUB8_CLOUD = "0";
  const g = account.publicAccount({ place: "local", session: null }, { requireAccount: false });
  assert.equal(g.enabled, true);
  assert.equal(g.comingSoon, true);
  assert.equal(g.cloudProduct, false);
  assert.equal(g.ready, true);
  assert.equal(g.needsChoice, false);
  assert.equal(g.xLogin, false);
  process.env.SUB8_CLOUD = prev;
});

await test("an invited session unlocks Cloud even when SUB8_CLOUD is off", () => {
  const prev = process.env.SUB8_CLOUD;
  process.env.SUB8_CLOUD = "0";
  const g = account.publicAccount(
    {
      place: "local",
      session: {
        email: "beta@test.com",
        handle: "",
        userId: "usr_beta",
        token: "tok",
        expiresAt: Date.now() + 60_000,
        photo: "",
        cloudAccess: true,
        admin: false,
      },
    },
    { requireAccount: false },
  );
  assert.equal(g.comingSoon, false);
  assert.equal(g.cloudProduct, true);
  assert.equal(g.cloudAccess, true);
  process.env.SUB8_CLOUD = prev;
});

await test("an admin session unlocks Cloud even when SUB8_CLOUD is off", () => {
  const prev = process.env.SUB8_CLOUD;
  process.env.SUB8_CLOUD = "0";
  const g = account.publicAccount(
    {
      place: "local",
      session: {
        email: "elchileno@gmail.com",
        handle: "Daniel_Farinax",
        userId: "usr_admin",
        token: "tok",
        expiresAt: Date.now() + 60_000,
        photo: "",
        cloudAccess: true,
        admin: true,
      },
    },
    { requireAccount: false },
  );
  assert.equal(g.cloudProduct, true);
  assert.equal(g.comingSoon, false);
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

await test("http startMagic persists a Worker session including expiresAt", async () => {
  const prevUrl = process.env.SUB8_CLOUD_URL;
  const prevFetch = globalThis.fetch;
  process.env.SUB8_CLOUD_URL = "https://api.example.test";
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        signedIn: true,
        token: "tok_live",
        email: "dan@example.com",
        userId: "usr_live",
        expiresAt,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  try {
    await account.logout();
    const magic = await account.startMagic("dan@example.com");
    assert.equal(magic.mock, false);
    assert.equal(magic.signedIn, true);
    assert.equal(magic.email, "dan@example.com");
    const raw = JSON.parse(await fs.readFile(account.accountPath(), "utf8"));
    assert.equal(raw.session.token, "tok_live");
    assert.equal(raw.session.userId, "usr_live");
    assert.equal(raw.session.expiresAt, expiresAt);
    const pub = account.publicAccount(await account.loadAccount(), { requireAccount: false });
    assert.equal(pub.signedIn, true);
    assert.equal(pub.mockAuth, false);
  } finally {
    globalThis.fetch = prevFetch;
    process.env.SUB8_CLOUD_URL = prevUrl || "mock";
  }
});

await test("waitlist 403 maps to a friendly error", async () => {
  const prevUrl = process.env.SUB8_CLOUD_URL;
  const prevFetch = globalThis.fetch;
  process.env.SUB8_CLOUD_URL = "https://api.example.test";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Magic email is only for the operator." }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await assert.rejects(() => account.startMagic("nope@example.com"), (err) => {
      assert.equal(err.code, "WAITLIST");
      assert.equal(err.status, 403);
      assert.match(err.message, /on the list/i);
      assert.doesNotMatch(err.message, /operator|Magic email/i);
      return true;
    });
  } finally {
    globalThis.fetch = prevFetch;
    process.env.SUB8_CLOUD_URL = prevUrl || "mock";
  }
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
  process.env.SUB8_CLOUD = "0";
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

await test("withNovncAutoconnect adds autoconnect to a bare vnc.html URL", () => {
  const out = account.withNovncAutoconnect("http://10.0.0.9:3000/vnc.html");
  assert.match(out, /autoconnect=true/);
  assert.match(out, /resize=scale/);
  assert.match(out, /#autoconnect=true/);
});

await test("cloudStreamProbeUrl uses the desk IPv4 and display port", () => {
  assert.equal(account.cloudStreamProbeUrl({ ipv4: "203.0.113.9" }), "http://203.0.113.9:3000/vnc.html");
  assert.equal(account.cloudStreamProbeUrl({ ipv4: "203.0.113.9" }, ":2"), "http://203.0.113.9:3002/vnc.html");
  assert.equal(account.cloudStreamProbeUrl({}), "");
});

await test("cloud teammate identityId drives harness", () => {
  const computer = {
    id: "cmp_abc",
    status: "assigned",
    sku: "vm.4g",
    ipv4: "1.2.3.4",
    streamUrl: "http://1.2.3.4:3000/vnc.html",
    userId: "u1",
  };
  const brain = { grokSignedIn: true, provider: "grok-oauth", model: "grok-4.6", claudeCredentials: true };
  const grok = account.botFromCloudMember(computer, { id: "cloud-cmp_abc", name: "Chief", role: "chief", display: 1 }, brain);
  assert.equal(grok.identityId, "cloud-grok");
  assert.equal(grok.harness.provider, "grok-build");
  const claude = account.botFromCloudMember(
    computer,
    { id: "cloud-cmp_abc-scout", name: "Scout", role: "worker", display: 2, identityId: "cloud-claude" },
    brain,
  );
  assert.equal(claude.identityId, "cloud-claude");
  assert.equal(claude.harness.provider, "claude");
});

await test("live cloud desk bot id is CSS-safe and has an octopus", () => {
  const bot = account.botFromComputer({
    id: "cmp_abc",
    status: "assigned",
    sku: "vm.4g",
    ipv4: "1.2.3.4",
    streamUrl: "http://1.2.3.4:3000/vnc.html",
  });
  assert.equal(bot.id, "cloud-cmp_abc");
  assert.equal(account.cloudBotId("cmp_abc"), "cloud-cmp_abc");
  assert.equal(account.cloudBotId("cloud:cmp_abc"), "cloud-cmp_abc");
  assert.match(bot.name, /^4G desk · abc$/);
  assert.notEqual(
    account.mapLiveComputer({ id: "cmp_e749ebcccbaa", sku: "vm.4g" }).name,
    account.mapLiveComputer({ id: "cmp_96bace00973f", sku: "vm.4g" }).name,
  );
  assert.equal(bot.place, "cloud");
  assert.equal(bot.avatar.body, "rounder");
  assert.equal(bot.avatar.expression, "think");
  assert.ok(!bot.id.includes(":"));
  assert.match(bot.vm.streamUrl, /autoconnect=true/);
});

await test("cloud desk control ids include chief and the selected teammate", () => {
  const computerId = "cmp_aa11bb";
  const chief = "cloud-cmp_aa11bb";
  const piper = "cloud-cmp_aa11bb-piper";
  assert.deepEqual(account.cloudDeskBotIds(computerId, piper).sort(), [chief, piper].sort());
  assert.deepEqual(account.cloudDeskBotIds(computerId, "").sort(), [chief]);
  const extras = account.cloudDeskBotIds(computerId, chief, [piper, "cloud-cmp_other-x", "cloud-cmp_aa11bbcc"]);
  assert.ok(extras.includes(chief));
  assert.ok(extras.includes(piper));
  assert.ok(!extras.includes("cloud-cmp_other-x"));
  assert.ok(!extras.includes("cloud-cmp_aa11bbcc"));
});

await test("cloud message identity prefers body computerId and botId", () => {
  const body = account.cloudMessageIdentity(
    { computerId: "cmp_deadbeef", botId: "cloud-cmp_deadbeef-piper", content: "hi" },
    "cloud-cmp_deadbeef",
  );
  assert.equal(body.computerId, "cmp_deadbeef");
  assert.equal(body.botId, "cloud-cmp_deadbeef-piper");
  const chiefBody = account.cloudMessageIdentity(
    { computerId: "cmp_deadbeef", botId: "cloud-cmp_deadbeef", content: "hi" },
    "ignored",
  );
  assert.equal(chiefBody.botId, "cloud-cmp_deadbeef");
});

await test("cloud message identity falls back from the route id", () => {
  const chief = account.cloudMessageIdentity({ content: "hi" }, "cloud-cmp_aabbcc");
  assert.equal(chief.computerId, "cmp_aabbcc");
  assert.equal(chief.botId, "");
  const mate = account.cloudMessageIdentity({ content: "hi" }, "cloud-cmp_aabbcc-piper");
  assert.equal(mate.computerId, "cmp_aabbcc");
  assert.equal(mate.botId, "cloud-cmp_aabbcc-piper");
  const local = account.cloudMessageIdentity({ content: "hi" }, "cloud-cmp_harness_local-scout");
  assert.equal(local.computerId, "cmp_harness_local");
  assert.equal(local.botId, "cloud-cmp_harness_local-scout");
});

await test("live mode blocks draft bot PATCH/DELETE with CHAT_TEAM", () => {
  process.env.SUB8_PACKAGED = "1";
  delete process.env.SUB8_CLOUD_URL;
  assert.equal(account.useMockAuth(), false);
  assert.equal(account.liveDraftBotCrudBlocked(), true);
  assert.equal(account.CHAT_TEAM.code, "CHAT_TEAM");
  assert.equal(account.CHAT_TEAM.error, "Cloud teammates live on the desk, not the local draft store.");
  delete process.env.SUB8_PACKAGED;
  process.env.SUB8_CLOUD_URL = "mock";
  assert.equal(account.liveDraftBotCrudBlocked(), false);
});

await test("liveCreateMate requires a signed-in session", async () => {
  await assert.rejects(() => account.liveCreateMate({ name: "Scout" }), (err) => {
    assert.equal(err.code, "SIGN_IN");
    return true;
  });
  await assert.rejects(() => account.liveDeleteMate({ botId: "cloud-cmp_x-scout" }), (err) => {
    assert.equal(err.code, "SIGN_IN");
    return true;
  });
  await assert.rejects(() => account.livePatchMate({ botId: "cloud-cmp_x-scout", name: "X" }), (err) => {
    assert.equal(err.code, "SIGN_IN");
    return true;
  });
});

await test("created desk is the attached computer not computers[0]", () => {
  const snap = {
    computers: [
      account.mapLiveComputer({ id: "cmp_old", sku: "vm.4g", status: "assigned" }),
      account.mapLiveComputer({ id: "cmp_new", sku: "vm.8g", status: "attaching" }),
    ],
  };
  const desk = account.createdDeskFromLive(
    { computer: { id: "cmp_new", sku: "vm.8g", status: "attaching" } },
    snap,
  );
  assert.equal(desk.id, "cmp_new");
  assert.equal(desk.ram, "8 GB");
  assert.notEqual(desk.id, snap.computers[0].id);
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
