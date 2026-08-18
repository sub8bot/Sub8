/**
 * Encrypted vault: isolation, redaction, no secret in tool results.
 * Run: node test/vault.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-vault-"));
process.env.SUB8BOT_DATA = tmp;
process.env.SUB8BOT_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

const vault = await import(path.join(root, "server/vault.mjs"));

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

await test("roundtrip encrypts on disk", async () => {
  const acc = await vault.upsertAccount({
    label: "Gmail work",
    site: "https://mail.google.com",
    username: "dan@example.com",
    password: "s3cret-PASS-99",
  });
  const raw = await fs.readFile(path.join(tmp, "vault.enc"), "utf8");
  assert.equal(raw.includes("s3cret-PASS-99"), false);
  assert.equal(raw.includes("dan@example.com"), false);
  const snap = await vault.snapshot();
  assert.equal(snap.accounts.length, 1);
  assert.equal(snap.accounts[0].username, "dan@example.com");
  assert.equal(snap.accounts[0].hasPassword, true);
  assert.equal("password" in snap.accounts[0], false);
  const revealed = await vault.revealAccount(acc.id);
  assert.equal(revealed.password, "s3cret-PASS-99");
});

await test("bot without grant cannot read a field", async () => {
  const acc = (await vault.snapshot()).accounts[0];
  const denied = await vault.fieldForBot("bot-a", acc.id, "password");
  assert.equal(denied.ok, false);
  assert.match(denied.error, /cannot use/i);
  await vault.setGrants("bot-a", [acc.id]);
  const ok = await vault.fieldForBot("bot-a", acc.id, "password");
  assert.equal(ok.ok, true);
  assert.equal(ok.value, "s3cret-PASS-99");
  const other = await vault.fieldForBot("bot-b", acc.id, "password");
  assert.equal(other.ok, false);
});

await test("granted list never includes the password", async () => {
  const rows = await vault.grantedAccounts("bot-a");
  assert.equal(rows.length, 1);
  assert.equal("password" in rows[0], false);
  assert.ok(!JSON.stringify(rows).includes("s3cret-PASS-99"));
});

await test("redact strips secrets from chat-like text", async () => {
  const secrets = await vault.listSecrets();
  const leaked = "I typed s3cret-PASS-99 into the box";
  assert.equal(vault.redactSecrets(leaked, secrets), "I typed [secret] into the box");
});

await test("groups and grants persist after delete of unused group", async () => {
  const g = await vault.upsertGroup({ name: "Work" });
  const acc = (await vault.snapshot()).accounts[0];
  await vault.upsertAccount({ id: acc.id, groupId: g.id });
  await vault.deleteGroup(g.id);
  const snap = await vault.snapshot();
  assert.equal(snap.groups.find((x) => x.id === g.id), undefined);
  assert.equal(snap.accounts[0].groupId, "");
});

await test("prompt block names accounts but not passwords", async () => {
  const block = await vault.promptBlock("bot-a");
  assert.match(block, /Gmail work/);
  assert.equal(block.includes("s3cret-PASS-99"), false);
  const empty = await vault.promptBlock("nobody");
  assert.match(empty, /no saved logins/i);
});

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
