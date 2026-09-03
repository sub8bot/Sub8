/**
 * @sub8/vault-crypto — the vault's end-to-end encryption core.
 *
 * Model (how 1Password/LastPass work, applied here):
 *   passphrase --PBKDF2--> masterKey  (never leaves the device)
 *   masterKey  --wraps-->  vaultKey   (random; the real data key)
 *   vaultKey   --seals-->  each secret (AES-256-GCM)
 * The server stores only the {@link VaultHeader} (wrapped keys + KDF params)
 * and the sealed items. Neither the passphrase nor any plaintext is ever sent.
 *
 * A `VaultKeyset` is the unlocked, in-memory result: hold it only while the
 * user is active, drop it on lock. Sealing/opening individual secrets is done
 * with {@link seal}/{@link open} against `keyset.vaultKey`.
 */

import type { KdfParams, Sealed, VaultHeader } from "./types.js";
import { deriveMasterKey, newKdfParams, newVaultKey, open, openText, seal, unwrapKey, wrapKey } from "./crypto.js";

export type { B64, KdfParams, Sealed, VaultHeader } from "./types.js";
export {
  DEFAULT_PBKDF2_ITERS,
  randomBytes,
  b64encode,
  b64decode,
  newKdfParams,
  deriveMasterKey,
  newVaultKey,
  newWrappingKey,
  exportKeyRaw,
  importWrappingKey,
  importVaultKey,
  wrapKey,
  unwrapKey,
  seal,
  open,
  openText,
} from "./crypto.js";

/** The unlocked keys, in memory only. Never serialize a keyset. */
export interface VaultKeyset {
  kdf: KdfParams;
  /** The data key. Seal/open every secret with this. */
  vaultKey: CryptoKey;
}

/**
 * Create a brand-new vault from a passphrase: fresh KDF salt, a fresh random
 * vault key, and the header to persist. Returns the header (safe to store) and
 * the unlocked keyset (keep in memory).
 */
export async function createVault(passphrase: string, iters?: number): Promise<{ header: VaultHeader; keyset: VaultKeyset }> {
  const kdf = newKdfParams(iters);
  const masterKey = await deriveMasterKey(passphrase, kdf);
  const vaultKey = await newVaultKey();
  const wrappedVaultKey = await wrapKey(vaultKey, masterKey);
  return { header: { v: 1, kdf, wrappedVaultKey }, keyset: { kdf, vaultKey } };
}

/**
 * Unlock a stored vault with the passphrase. Throws (wrong passphrase / tampered
 * header) rather than leaking which — the caller reports "wrong passphrase".
 */
export async function unlockVault(passphrase: string, header: VaultHeader): Promise<VaultKeyset> {
  const masterKey = await deriveMasterKey(passphrase, header.kdf);
  const vaultKey = await unwrapKey(header.wrappedVaultKey, masterKey).catch(() => {
    throw new Error("Wrong passphrase.");
  });
  return { kdf: header.kdf, vaultKey };
}

/**
 * Change the passphrase without touching any secret: re-derive the master key
 * from the new passphrase and re-wrap the SAME vault key. Existing sealed items
 * stay valid. Requires the vault already unlocked (so we hold the real key).
 */
export async function rewrapVault(header: VaultHeader, keyset: VaultKeyset, newPassphrase: string, iters?: number): Promise<VaultHeader> {
  const kdf = newKdfParams(iters);
  const masterKey = await deriveMasterKey(newPassphrase, kdf);
  const wrappedVaultKey = await wrapKey(keyset.vaultKey, masterKey);
  return { ...header, v: 1, kdf, wrappedVaultKey };
}

/**
 * Turn on unattended cloud autofill: add a copy of the vault key wrapped under
 * the cloud escrow key, so a cloud desk can decrypt escrowed items with the
 * user away. This is the explicit, per-user step out of pure zero-knowledge.
 */
export async function addEscrow(header: VaultHeader, keyset: VaultKeyset, escrowKey: CryptoKey): Promise<VaultHeader> {
  return { ...header, escrowedVaultKey: await wrapKey(keyset.vaultKey, escrowKey) };
}

/** Remove escrow — back to present-to-approve only. */
export function removeEscrow(header: VaultHeader): VaultHeader {
  const { escrowedVaultKey: _drop, ...rest } = header;
  return rest;
}

/**
 * The cloud side's unlock path: recover the vault key from the escrowed copy
 * using the escrow key — no passphrase. Only works when the user enabled escrow.
 */
export async function unlockWithEscrow(header: VaultHeader, escrowKey: CryptoKey): Promise<VaultKeyset> {
  if (!header.escrowedVaultKey) throw new Error("This vault has no escrowed key.");
  const vaultKey = await unwrapKey(header.escrowedVaultKey, escrowKey).catch(() => {
    throw new Error("Wrong escrow key.");
  });
  return { kdf: header.kdf, vaultKey };
}

/** Seal a secret under an unlocked keyset. `aad` binds it to a context (e.g. the item id). */
export function sealSecret(plaintext: string, keyset: VaultKeyset, aad?: string): Promise<Sealed> {
  return seal(plaintext, keyset.vaultKey, aad);
}

/** Open a secret sealed by {@link sealSecret}. */
export function openSecret(sealed: Sealed, keyset: VaultKeyset, aad?: string): Promise<string> {
  return openText(sealed, keyset.vaultKey, aad);
}
