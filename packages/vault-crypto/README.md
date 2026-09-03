# @sub8/vault-crypto

The vault's end-to-end encryption core. Pure WebCrypto (`crypto.subtle`), so the
same code runs on the Mac server, the Cloudflare Worker, and the browser. iOS
mirrors the same wire format with CryptoKit.

## Model

```
passphrase --PBKDF2-SHA256--> masterKey   (never leaves the device)
masterKey  --AES-GCM wrap-->  vaultKey    (random 256-bit data key)
vaultKey   --AES-GCM seal-->  each secret
```

The server stores only the **`VaultHeader`** (KDF params + the wrapped vault key)
and the sealed items — all ciphertext. The passphrase and every plaintext stay
on the device. A breach of the server/KV/droplet yields useless boxes.

## Zero-knowledge, with an explicit escape hatch

By default there is no way for the server to decrypt: no escrow, no recovery.
Forget the passphrase and the data is gone. That is the guarantee.

For **unattended cloud autofill** (a cloud desk filling a login with the user
away), the user can opt in per-login. `addEscrow` adds a copy of the vault key
wrapped under a **cloud escrow key**, so the cloud side can `unlockWithEscrow`
without the passphrase. `removeEscrow` takes it back to present-to-approve only.
Everything else stays sealed under the passphrase alone.

## API

- `createVault(passphrase)` → `{ header, keyset }`
- `unlockVault(passphrase, header)` → `keyset` (throws "Wrong passphrase.")
- `rewrapVault(header, keyset, newPassphrase)` — change passphrase, re-wrap the
  same vault key; secrets untouched.
- `sealSecret(text, keyset, aad?)` / `openSecret(sealed, keyset, aad?)` — bind a
  box to its context with `aad` (e.g. the item id).
- `addEscrow` / `removeEscrow` / `unlockWithEscrow` — the opt-in escrow path.
- Primitives: `deriveMasterKey`, `newVaultKey`, `wrapKey`, `unwrapKey`,
  `seal`, `open`, `openText`, `newKdfParams`, base64 + random helpers.

Keep a `keyset` in memory only while the user is active; drop it on lock. Never
serialize it.
