import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createVault,
  unlockVault,
  rewrapVault,
  addEscrow,
  removeEscrow,
  unlockWithEscrow,
  sealSecret,
  openSecret,
  newVaultKey,
  newWrappingKey,
  exportKeyRaw,
  importWrappingKey,
  seal,
  open,
  openText,
  wrapKey,
  unwrapKey,
  deriveMasterKey,
  newKdfParams,
  b64encode,
  b64decode,
  randomBytes,
} from "../dist/index.js";

// Low iterations so the suite is fast; production uses the 600k default.
const FAST = 1000;

test("seal/open round-trips text and bytes; a wrong key or tampering fails", async () => {
  const key = await newVaultKey();
  const box = await seal("hunter2", key);
  assert.equal(await openText(box, key), "hunter2");

  const other = await newVaultKey();
  await assert.rejects(open(box, other), "wrong key must fail");

  const tampered = { ...box, ct: b64encode((() => { const b = b64decode(box.ct); b[0] ^= 1; return b; })()) };
  await assert.rejects(open(tampered, key), "a flipped bit must fail the GCM tag");
});

test("aad binds a box to its context", async () => {
  const key = await newVaultKey();
  const box = await seal("s3cret", key, "item:abc");
  assert.equal(await openText(box, key, "item:abc"), "s3cret");
  await assert.rejects(open(box, key, "item:xyz"), "different aad must fail");
  await assert.rejects(open(box, key), "missing aad must fail");
});

test("create → unlock with the right passphrase; wrong passphrase is rejected without a hint", async () => {
  const { header, keyset } = await createVault("correct horse battery staple", FAST);
  const secret = await sealSecret("my-bank-password", keyset, "acct:1");

  const opened = await unlockVault("correct horse battery staple", header);
  assert.equal(await openSecret(secret, opened, "acct:1"), "my-bank-password");

  await assert.rejects(unlockVault("wrong passphrase", header), /Wrong passphrase\./);
});

test("the header carries no plaintext and no passphrase", async () => {
  const { header } = await createVault("s3kr1t-passphrase", FAST);
  const json = JSON.stringify(header);
  assert.ok(!json.includes("s3kr1t-passphrase"), "passphrase must not be in the header");
  assert.equal(header.kdf.kdf, "PBKDF2-SHA256");
  assert.ok(header.kdf.salt && header.wrappedVaultKey?.ct, "header has salt + wrapped key");
  assert.equal(header.escrowedVaultKey, undefined, "no escrow by default (zero-knowledge)");
});

test("changing the passphrase keeps every secret readable and invalidates the old one", async () => {
  const { header, keyset } = await createVault("old-pass", FAST);
  const secret = await sealSecret("token-123", keyset);

  const rewrapped = await rewrapVault(header, keyset, "new-pass", FAST);
  const withNew = await unlockVault("new-pass", rewrapped);
  assert.equal(await openSecret(secret, withNew), "token-123", "same secret opens under the new passphrase");
  await assert.rejects(unlockVault("old-pass", rewrapped), "old passphrase no longer unlocks the re-wrapped header");
});

test("escrow lets the cloud side unlock without the passphrase; removing it restores zero-knowledge", async () => {
  const { header, keyset } = await createVault("user-pass", FAST);
  const secret = await sealSecret("always-on-secret", keyset, "acct:9");
  const escrowKey = await newWrappingKey(); // the cloud escrow key (wrap/unwrap usage, exportable)

  const escrowed = await addEscrow(header, keyset, escrowKey);
  assert.ok(escrowed.escrowedVaultKey, "header now carries the escrowed key");

  // Cloud desk path: recover the vault key from escrow, no passphrase.
  const cloudSide = await unlockWithEscrow(escrowed, escrowKey);
  assert.equal(await openSecret(secret, cloudSide, "acct:9"), "always-on-secret");

  // A different escrow key cannot.
  await assert.rejects(unlockWithEscrow(escrowed, await newWrappingKey()), /Wrong escrow key\./);

  // The escrow key survives export/import (it is stored server-side).
  const reimported = await importWrappingKey(await exportKeyRaw(escrowKey));
  const viaReimport = await unlockWithEscrow(escrowed, reimported);
  assert.equal(await openSecret(secret, viaReimport, "acct:9"), "always-on-secret");

  // Remove escrow → no key to recover from.
  const back = removeEscrow(escrowed);
  assert.equal(back.escrowedVaultKey, undefined);
  await assert.rejects(unlockWithEscrow(back, escrowKey), /no escrowed key/);

  // The passphrase still works throughout.
  const viaPass = await unlockVault("user-pass", escrowed);
  assert.equal(await openSecret(secret, viaPass, "acct:9"), "always-on-secret");
});

test("wrapKey/unwrapKey round-trips a data key so it seals/opens the same secret", async () => {
  const params = newKdfParams(FAST);
  const wrappingKey = await deriveMasterKey("kek-pass", params);
  const dataKey = await newVaultKey();
  const boxed = await seal("payload", dataKey);

  const wrapped = await wrapKey(dataKey, wrappingKey);
  const back = await unwrapKey(wrapped, wrappingKey);
  assert.equal(await openText(boxed, back), "payload");
});

test("deriveMasterKey is deterministic for the same passphrase + params", async () => {
  const params = newKdfParams(FAST);
  const dataKey = await newVaultKey();
  const k1 = await deriveMasterKey("same", params);
  const k2 = await deriveMasterKey("same", params);
  const w = await wrapKey(dataKey, k1);
  // If k1 and k2 are the same key, k2 unwraps what k1 wrapped.
  const back = await unwrapKey(w, k2);
  const box = await seal("x", dataKey);
  assert.equal(await openText(box, back), "x");
});

test("randomBytes and base64 round-trip", () => {
  const b = randomBytes(32);
  assert.equal(b.length, 32);
  assert.deepEqual([...b64decode(b64encode(b))], [...b]);
});
