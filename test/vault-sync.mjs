/**
 * Cloud vault sync: a login saved on this Mac reaches cloud desks, with its grants.
 * Run: node test/vault-sync.mjs
 *
 * Cloud desks list logins from the escrow-sealed `index` in the synced envelope
 * (id, label, site, username, and the grant map). These cover the ways a new
 * login used to stay invisible to a cloud bot:
 *  - unlocked, but no local sync copy yet: every resync returned null, forever;
 *  - saved while locked: nothing is sent, and the status must say so;
 *  - a push that failed must show as pending, not "synced".
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-vault-sync-"));
process.env.SUB8BOT_DATA = tmp;
process.env.SUB8BOT_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");

const vault = await import(path.join(root, "server/vault.mjs"));
const sync = await import(path.join(root, "server/vault-sync.mjs"));
const crypto = await import("@sub8/vault-crypto");

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

const tick = () => new Promise((r) => setTimeout(r, 15));
const CLOUD_BOT = "cloud-cmp_test123-freebotsmana";
let escrowB64 = "";
const pushed = [];
const push = async (env) => {
  pushed.push(env);
};

/** What a cloud desk's vault_list would see for `botId` in this envelope (mirrors the Worker). */
async function cloudList(env, botId) {
  const ek = await crypto.importWrappingKey(escrowB64);
  const index = JSON.parse(await crypto.openText(env.index, ek, "sub8-vault-index"));
  const granted = new Set(index.grants?.[botId] || []);
  return (index.accounts || []).filter((a) => granted.has(a.id));
}

await test("unlocked with no local sync copy still seals and pushes", async () => {
  await vault.upsertAccount({ label: "Old", site: "old.example", username: "u", password: "p-old" });
  // Gate set up on another device (or the local copy was lost): the key is
  // unlocked in memory but vault-cloud.json does not exist.
  await sync.unlockWithKey(await sync.freshVaultKey());
  escrowB64 = await sync.freshEscrowKey();
  await assert.rejects(fs.access(sync._ENVELOPE_PATH));
  assert.equal(sync.isEnabled(), true, "holding the key means sync is on");
  const r = await sync.syncToCloud(push);
  assert.equal(r, "synced");
  assert.equal(pushed.length, 1);
  assert.ok(pushed[0].index, "escrow index present for cloud desks");
  await fs.access(sync._ENVELOPE_PATH);
});

await test("a new login granted to a cloud bot shows in that bot's cloud list after sync", async () => {
  const acc = await vault.upsertAccount({ label: "X Login Free Bots", site: "x.com", username: "freebots", password: "p-new" });
  await vault.setAccountGrants(acc.id, [CLOUD_BOT]);
  assert.equal(await sync.syncToCloud(push), "synced");
  const env = pushed.at(-1);
  const rows = await cloudList(env, CLOUD_BOT);
  assert.deepEqual(rows.map((a) => a.label), ["X Login Free Bots"]);
  assert.equal(JSON.stringify(env.index).includes("p-new"), false);
  assert.equal((await cloudList(env, "cloud-cmp_other")).length, 0, "grants stay per bot");
  const st = await sync.status();
  assert.equal(st.pending, false);
  assert.equal(st.lastError, null);
});

await test("saving while locked sends nothing and reports pending", async () => {
  sync.lock();
  await tick();
  const before = pushed.length;
  const acc = await vault.upsertAccount({ label: "While locked", site: "locked.example", username: "l", password: "p-l" });
  await vault.setAccountGrants(acc.id, [CLOUD_BOT]);
  assert.equal(await sync.syncToCloud(push), "locked");
  assert.equal(pushed.length, before);
  const st = await sync.status();
  assert.equal(st.unlocked, false);
  assert.equal(st.pending, true, "the UI must be able to say the change is waiting on unlock");
});

await test("unlocking then syncing delivers what was saved while locked", async () => {
  // The unlock route calls unlockWithKey then syncToCloud.
  const env0 = JSON.parse(await fs.readFile(sync._ENVELOPE_PATH, "utf8"));
  assert.ok(env0.data);
  await sync.unlockWithKey(await sync.freshVaultKey());
  await sync.setEscrowKey(escrowB64);
  assert.equal(await sync.syncToCloud(push), "synced");
  const labels = (await cloudList(pushed.at(-1), CLOUD_BOT)).map((a) => a.label).sort();
  assert.deepEqual(labels, ["While locked", "X Login Free Bots"]);
  assert.equal((await sync.status()).pending, false);
});

await test("a failed push is reported, and the next success clears it", async () => {
  await tick();
  await vault.upsertAccount({ label: "Flaky", site: "flaky.example", username: "f", password: "p-f" });
  const r = await sync.syncToCloud(async () => {
    throw new Error("worker 503");
  });
  assert.equal(r, "failed");
  let st = await sync.status();
  assert.equal(st.pending, true);
  assert.equal(st.lastError, "worker 503");
  assert.equal(await sync.syncToCloud(push), "synced");
  st = await sync.status();
  assert.equal(st.pending, false);
  assert.equal(st.lastError, null);
});

await test("concurrent syncs push in call order, newest last", async () => {
  const order = [];
  const slowPush = async (env) => {
    await new Promise((r) => setTimeout(r, 30));
    order.push(env.updatedAt);
  };
  const fastPush = async (env) => {
    order.push(env.updatedAt);
  };
  const [a, b] = await Promise.all([sync.syncToCloud(slowPush), sync.syncToCloud(fastPush)]);
  assert.equal(a, "synced");
  assert.equal(b, "synced");
  assert.equal(order.length, 2);
  assert.ok(order[0] <= order[1], "an older envelope must never land after a newer one");
});

await test("applyPulled with no local copy keeps local edits and the remote always-on list", async () => {
  const acc = (await vault.snapshot()).accounts.find((a) => a.label === "X Login Free Bots");
  const remote = await sync.setAlwaysOn(acc.id, true);
  assert.deepEqual(remote.alwaysOn, [acc.id]);
  // Lose the local copy, then edit locally so this Mac is newer than the remote.
  await fs.unlink(sync._ENVELOPE_PATH);
  await tick();
  await vault.upsertAccount({ label: "After remote", site: "after.example", username: "a", password: "p-a" });
  await sync.applyPulled(remote);
  const labels = (await vault.snapshot()).accounts.map((a) => a.label);
  assert.ok(labels.includes("After remote"), "the local edit survives the pull");
  assert.equal(await sync.syncToCloud(push), "synced");
  assert.deepEqual(pushed.at(-1).alwaysOn, [acc.id], "always-on carried forward");
  assert.ok(pushed.at(-1).escrow[acc.id], "escrowed secret re-sealed");
});

await fs.rm(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
