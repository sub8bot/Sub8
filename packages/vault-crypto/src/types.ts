/**
 * On-the-wire shapes for the vault's encryption. Everything here is safe to
 * store on a server or sync to the cloud: it is all ciphertext plus the public
 * parameters needed to derive keys from a passphrase the server never sees.
 */

/** A byte string, base64 (standard, padded). */
export type B64 = string;

/**
 * Key-derivation parameters. Public — they say HOW to turn a passphrase into
 * the master key, not what the passphrase is. Versioned so the KDF can be
 * hardened later (e.g. to Argon2id) without breaking existing vaults.
 */
export interface KdfParams {
  /** Only value today. */
  kdf: "PBKDF2-SHA256";
  /** Iteration count. */
  iters: number;
  /** Random per-vault salt. */
  salt: B64;
}

/** One AES-256-GCM box: iv + ciphertext (the GCM tag is appended to ct by WebCrypto). */
export interface Sealed {
  /** Envelope version. */
  v: 1;
  /** Only value today. */
  alg: "A256GCM";
  /** 12-byte random nonce. */
  iv: B64;
  /** Ciphertext with the 16-byte GCM tag appended. */
  ct: B64;
}

/**
 * The public header of a vault: enough to unlock it with the passphrase, and
 * the wrapped data key. Holds NO plaintext and NO passphrase. This is what
 * syncs between local and cloud.
 */
export interface VaultHeader {
  v: 1;
  kdf: KdfParams;
  /** The random vault key, sealed under the passphrase-derived master key. */
  wrappedVaultKey: Sealed;
  /**
   * The same vault key, sealed under the cloud escrow key, present only when the
   * user has turned on unattended cloud autofill for at least one login. Lets a
   * cloud desk decrypt escrowed items without the user present. Absent ⇒ the
   * whole vault is present-to-approve only (pure zero-knowledge).
   */
  escrowedVaultKey?: Sealed | undefined;
}
