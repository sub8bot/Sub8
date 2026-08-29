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

await test("export includes passwords, groups, and grants", async () => {
  const g = await vault.upsertGroup({ name: "Personal" });
  const acc = (await vault.snapshot()).accounts[0];
  await vault.upsertAccount({ id: acc.id, groupId: g.id });
  await vault.setGrants("bot-a", [acc.id]);
  const backup = await vault.exportVault();
  assert.equal(backup.kind, "sub8-vault");
  assert.equal(backup.version, 1);
  assert.ok(backup.groups.some((x) => x.id === g.id && x.name === "Personal"));
  const row = backup.accounts.find((a) => a.id === acc.id);
  assert.equal(row.password, "s3cret-PASS-99");
  assert.equal(row.groupId, g.id);
  assert.deepEqual(backup.grants["bot-a"], [acc.id]);
  const snap = await vault.snapshot();
  assert.equal("password" in snap.accounts[0], false);
});

await test("import replace restores secrets and drops extras", async () => {
  const extra = await vault.upsertAccount({ label: "Do not keep", password: "drop-me" });
  const backup = await vault.exportVault();
  backup.accounts = backup.accounts.filter((a) => a.id !== extra.id);
  backup.groups = backup.groups.filter((g) => g.name === "Personal");
  const other = {
    kind: "sub8-vault",
    version: 1,
    exportedAt: Date.now(),
    groups: backup.groups,
    accounts: backup.accounts.map((a) => ({ ...a, password: "restored-PASS" })),
    grants: backup.grants,
  };
  const snap = await vault.importVault(other, "replace");
  assert.equal(snap.accounts.some((a) => a.id === extra.id), false);
  assert.equal(snap.groups.length, 1);
  const kept = snap.accounts.find((a) => a.label === "Gmail work");
  assert.ok(kept);
  const revealed = await vault.revealAccount(kept.id);
  assert.equal(revealed.password, "restored-PASS");
  const allowed = await vault.fieldForBot("bot-a", kept.id, "password");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value, "restored-PASS");
});

await test("import merge keeps existing logins and unions grants", async () => {
  const incoming = {
    kind: "sub8-vault",
    version: 1,
    groups: [{ id: "g-merge", name: "Imported", createdAt: 1 }],
    accounts: [
      {
        id: "acc-merge",
        groupId: "g-merge",
        label: "GitHub",
        site: "github.com",
        username: "dan",
        password: "gh-token",
        notes: "",
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
      },
    ],
    grants: { "bot-b": ["acc-merge"] },
  };
  const snap = await vault.importVault(incoming, "merge");
  assert.ok(snap.accounts.some((a) => a.label === "Gmail work"));
  assert.ok(snap.accounts.some((a) => a.id === "acc-merge"));
  assert.ok(snap.groups.some((g) => g.id === "g-merge"));
  const revealed = await vault.revealAccount("acc-merge");
  assert.equal(revealed.password, "gh-token");
  const other = await vault.fieldForBot("bot-b", "acc-merge", "password");
  assert.equal(other.ok, true);
  assert.equal(other.value, "gh-token");
});

await test("import rejects a foreign backup kind", async () => {
  await assert.rejects(
    () => vault.importVault({ kind: "not-this", groups: [], accounts: [], grants: {} }),
    /not a sub8 vault backup/i,
  );
});

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
