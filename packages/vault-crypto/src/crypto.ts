/**
 * Low-level WebCrypto primitives. Everything is AES-256-GCM for data and
 * PBKDF2-SHA256 for the passphrase, using only `globalThis.crypto.subtle` so
 * the exact same code runs in Node, a Cloudflare Worker, and a browser.
 */

import type { B64, KdfParams, Sealed } from "./types.js";

/** OWASP's floor for PBKDF2-HMAC-SHA256. Recorded per-vault so it can rise later. */
export const DEFAULT_PBKDF2_ITERS = 600_000;

const subtle: SubtleCrypto = globalThis.crypto.subtle;

/** WebCrypto wants BufferSource; TS 5.7's `Uint8Array<ArrayBufferLike>` doesn't
 * auto-satisfy it. This is a widening assertion over a byte view, not a copy. */
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function b64encode(bytes: Uint8Array): B64 {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  // btoa exists in Node ≥16, Workers, and browsers.
  return btoa(s);
}

export function b64decode(s: B64): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Fresh KDF parameters for a brand-new vault. */
export function newKdfParams(iters: number = DEFAULT_PBKDF2_ITERS): KdfParams {
  return { kdf: "PBKDF2-SHA256", iters, salt: b64encode(randomBytes(16)) };
}

/**
 * Turn a passphrase into the master key (an AES-GCM key used only to wrap the
 * vault key). The passphrase and this key never leave the device.
 */
export async function deriveMasterKey(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  if (params.kdf !== "PBKDF2-SHA256") throw new Error(`unsupported kdf: ${params.kdf}`);
  const base = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bs(b64decode(params.salt)), iterations: params.iters },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** A fresh random 256-bit data key. Extractable so it can be wrapped (never exported in the clear). */
export function newVaultKey(): Promise<CryptoKey> {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/**
 * A fresh random 256-bit wrapping key — used as the cloud escrow key. Unlike the
 * vault key it carries wrap/unwrap usage (not encrypt/decrypt) and is exportable
 * so the cloud side can persist it in a protected store.
 */
export function newWrappingKey(): Promise<CryptoKey> {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["wrapKey", "unwrapKey"]);
}

/** Export a wrapping/escrow key to base64 raw bytes for storage. */
export async function exportKeyRaw(key: CryptoKey): Promise<B64> {
  return b64encode(new Uint8Array(await subtle.exportKey("raw", key)));
}

/** Import a base64 raw wrapping/escrow key produced by {@link exportKeyRaw}. */
export function importWrappingKey(raw: B64): Promise<CryptoKey> {
  return subtle.importKey("raw", bs(b64decode(raw)), { name: "AES-GCM" }, true, ["wrapKey", "unwrapKey"]);
}

/** Seal a data key under a wrapping key (master or escrow). */
export async function wrapKey(key: CryptoKey, wrappingKey: CryptoKey): Promise<Sealed> {
  const iv = randomBytes(12);
  const wrapped = await subtle.wrapKey("raw", key, wrappingKey, { name: "AES-GCM", iv: bs(iv) });
  return { v: 1, alg: "A256GCM", iv: b64encode(iv), ct: b64encode(new Uint8Array(wrapped)) };
}

/** Open a data key sealed by {@link wrapKey}. Throws if the wrapping key is wrong or the box was tampered with. */
export function unwrapKey(sealed: Sealed, wrappingKey: CryptoKey): Promise<CryptoKey> {
  return subtle.unwrapKey(
    "raw",
    bs(b64decode(sealed.ct)),
    wrappingKey,
    { name: "AES-GCM", iv: bs(b64decode(sealed.iv)) },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt bytes or a string with a data key. `aad` is authenticated but not
 * encrypted — bind a box to its context (e.g. an item id) so it can't be
 * lifted and replayed elsewhere.
 */
export async function seal(plaintext: string | Uint8Array, key: CryptoKey, aad?: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const data = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const params: AesGcmParams = { name: "AES-GCM", iv: bs(iv) };
  if (aad) params.additionalData = bs(enc.encode(aad));
  const ct = await subtle.encrypt(params, key, bs(data));
  return { v: 1, alg: "A256GCM", iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

/** Decrypt a box from {@link seal}. Throws on a wrong key, wrong `aad`, or any tampering. */
export async function open(sealed: Sealed, key: CryptoKey, aad?: string): Promise<Uint8Array> {
  const params: AesGcmParams = { name: "AES-GCM", iv: bs(b64decode(sealed.iv)) };
  if (aad) params.additionalData = bs(enc.encode(aad));
  const pt = await subtle.decrypt(params, key, bs(b64decode(sealed.ct)));
  return new Uint8Array(pt);
}

/** {@link open} then decode as UTF-8. */
export async function openText(sealed: Sealed, key: CryptoKey, aad?: string): Promise<string> {
  return dec.decode(await open(sealed, key, aad));
}
