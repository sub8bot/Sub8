/**
 * Cloud vault: the end-to-end-encrypted, syncable layer over the local vault.
 *
 * The local vault (vault.mts) stays exactly as it is — Keychain-encrypted, no
 * passphrase, works offline. This module adds an OPT-IN cloud copy: the whole
 * vault sealed under a passphrase-derived key (see @sub8/vault-crypto), so the
 * ciphertext can sync to the Worker and be read on other devices and by cloud
 * desks. The passphrase and the plaintext never leave this process.
 *
 * Storage: the sealed envelope lives at `vault-cloud.json` locally (the sync
 * copy) and, when signed in, is pushed to the Worker's KV. Only the local Mac
 * holds the unlocked keyset, in memory, until it locks.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.mjs";
import {
  createVault,
  unlockVault,
  rewrapVault,
  sealSecret,
  openSecret,
  seal,
  openText,
  newWrappingKey,
  importWrappingKey,
  exportKeyRaw,
  type VaultHeader,
  type VaultKeyset,
  type Sealed,
} from "@sub8/vault-crypto";
import type { VaultFile } from "./vault.mjs";
import { _decryptedVaultFile, _replaceVaultFile } from "./vault.mjs";

/** The synced blob. Everything here is ciphertext except the public id lists and timestamp. */
export interface CloudVaultEnvelope {
  v: 1;
  header: VaultHeader;
  /** The whole VaultFile JSON, sealed under the passphrase-derived vault key. */
  data: Sealed;
  /** account id -> that account's password, sealed under the cloud ESCROW key. Present only for always-on logins. */
  escrow: Record<string, Sealed>;
  /** account ids the user marked "always-on" for unattended cloud autofill. Just ids. */
  alwaysOn: string[];
  updatedAt: number;
}

/** What the vault pane needs to render the cloud row without revealing anything. */
export interface CloudVaultStatus {
  enabled: boolean;
  unlocked: boolean;
  alwaysOn: string[];
  updatedAt: number | null;
}

const ENVELOPE_PATH = path.join(dataDir, "vault-cloud.json");
const AAD = "sub8-vault-file";

let keyset: VaultKeyset | null = null;
/** The cloud escrow key, imported into memory while we hold it (to seal always-on items). */
let escrowKey: Awaited<ReturnType<typeof importWrappingKey>> | null = null;
let writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(() => {}, () => {});
  return run;
}

async function readEnvelope(): Promise<CloudVaultEnvelope | null> {
  if (!fsSync.existsSync(ENVELOPE_PATH)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(ENVELOPE_PATH, "utf8"));
    if (raw && raw.header && raw.data) {
      return { v: 1, header: raw.header, data: raw.data, escrow: raw.escrow || {}, alwaysOn: Array.isArray(raw.alwaysOn) ? raw.alwaysOn : [], updatedAt: Number(raw.updatedAt) || 0 };
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function writeEnvelope(env: CloudVaultEnvelope): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${ENVELOPE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
  await fs.rename(tmp, ENVELOPE_PATH);
}

export function isEnabled(): boolean {
  return fsSync.existsSync(ENVELOPE_PATH);
}

export function isUnlocked(): boolean {
  return keyset !== null;
}

export async function status(): Promise<CloudVaultStatus> {
  const env = await readEnvelope();
  return { enabled: Boolean(env), unlocked: isUnlocked(), alwaysOn: env?.alwaysOn || [], updatedAt: env?.updatedAt || null };
}

/** Seal the current local vault into a fresh envelope, re-sealing always-on items under the escrow key. */
async function buildEnvelope(header: VaultHeader, ks: VaultKeyset, alwaysOn: string[]): Promise<CloudVaultEnvelope> {
  const file = await _decryptedVaultFile();
  const data = await sealSecret(JSON.stringify(file), ks, AAD);
  const escrow: Record<string, Sealed> = {};
  if (alwaysOn.length && escrowKey) {
    const byId = new Map(file.accounts.map((a) => [a.id, a]));
    for (const id of alwaysOn) {
      const acc = byId.get(id);
      if (acc?.password) escrow[id] = await seal(acc.password, escrowKey, `escrow:${id}`);
    }
  }
  return { v: 1, header, data, escrow, alwaysOn: alwaysOn.filter((id) => escrow[id] || !escrowKey), updatedAt: Date.now() };
}

/**
 * Turn on the cloud vault: set the passphrase, seal the current local vault, and
 * write the envelope. Returns the envelope to push to the Worker. Leaves the
 * keyset unlocked in memory.
 */
export function enable(passphrase: string): Promise<CloudVaultEnvelope> {
  return withLock(async () => {
    if (!passphrase || passphrase.length < 8) throw new Error("Choose a passphrase of at least 8 characters.");
    const created = await createVault(passphrase);
    keyset = created.keyset;
    const env = await buildEnvelope(created.header, created.keyset, []);
    await writeEnvelope(env);
    return env;
  });
}

/** Unlock the cloud vault with the passphrase; caches the keyset in memory. */
export function unlock(passphrase: string): Promise<void> {
  return withLock(async () => {
    const env = await readEnvelope();
    if (!env) throw new Error("The cloud vault is not set up on this computer.");
    keyset = await unlockVault(passphrase, env.header);
    // Prove the passphrase actually opens the data, not just the key wrap.
    await openSecret(env.data, keyset, AAD).catch(() => {
      keyset = null;
      throw new Error("Wrong passphrase.");
    });
  });
}

export function lock(): void {
  keyset = null;
  escrowKey = null;
}

/** Re-seal the local vault into the envelope (call after any local vault change while unlocked). Returns the envelope to sync, or null when locked/off. */
export function resync(): Promise<CloudVaultEnvelope | null> {
  return withLock(async () => {
    const env = await readEnvelope();
    if (!env || !keyset) return null;
    const next = await buildEnvelope(env.header, keyset, env.alwaysOn);
    await writeEnvelope(next);
    return next;
  });
}

/** Apply a newer envelope pulled from the Worker: replace the local envelope and, if unlocked, the local vault contents. */
export function applyPulled(env: CloudVaultEnvelope): Promise<void> {
  return withLock(async () => {
    const local = await readEnvelope();
    if (local && local.updatedAt >= env.updatedAt) return; // ours is newer/equal
    await writeEnvelope(env);
    if (keyset) {
      const file = JSON.parse(await openSecret(env.data, keyset, AAD)) as VaultFile;
      await _replaceVaultFile(file);
    }
  });
}

/** Change the passphrase (must be unlocked). Returns the new envelope to sync. */
export function changePassphrase(newPassphrase: string): Promise<CloudVaultEnvelope> {
  return withLock(async () => {
    const env = await readEnvelope();
    if (!env || !keyset) throw new Error("Unlock the cloud vault first.");
    if (!newPassphrase || newPassphrase.length < 8) throw new Error("Choose a passphrase of at least 8 characters.");
    const header = await rewrapVault(env.header, keyset, newPassphrase);
    const next = await buildEnvelope(header, keyset, env.alwaysOn);
    await writeEnvelope(next);
    return next;
  });
}

/** Turn off the cloud vault on this computer (the local Keychain vault is untouched). */
export function disable(): Promise<void> {
  return withLock(async () => {
    keyset = null;
    escrowKey = null;
    await fs.unlink(ENVELOPE_PATH).catch(() => {});
  });
}

/**
 * Provide the cloud escrow key (raw base64, fetched from the Worker) so always-on
 * items can be sealed under it. Held in memory only.
 */
export async function setEscrowKey(rawB64: string | null): Promise<void> {
  escrowKey = rawB64 ? await importWrappingKey(rawB64) : null;
}

/** Generate a fresh escrow key locally (used when the Worker has none yet). Returns its raw base64 to store server-side. */
export async function freshEscrowKey(): Promise<string> {
  const key = await newWrappingKey();
  escrowKey = key;
  return exportKeyRaw(key);
}

/** Mark/unmark a login as always-on (unattended cloud autofill). Must be unlocked, and escrow provisioned. Returns the new envelope to sync. */
export function setAlwaysOn(accountId: string, on: boolean): Promise<CloudVaultEnvelope> {
  return withLock(async () => {
    const env = await readEnvelope();
    if (!env || !keyset) throw new Error("Unlock the cloud vault first.");
    if (on && !escrowKey) throw new Error("Cloud escrow is not set up yet.");
    const set = new Set(env.alwaysOn);
    if (on) set.add(accountId);
    else set.delete(accountId);
    const next = await buildEnvelope(env.header, keyset, [...set]);
    await writeEnvelope(next);
    return next;
  });
}

/** For the present-to-approve relay: decrypt one account's password locally so the caller can hand it to a waiting cloud desk. Empty when locked or absent. */
export async function revealForRelay(accountId: string): Promise<string> {
  if (!keyset) return "";
  const env = await readEnvelope();
  if (!env) return "";
  const file = JSON.parse(await openSecret(env.data, keyset, AAD)) as VaultFile;
  return file.accounts.find((a) => a.id === accountId)?.password || "";
}

export const _ENVELOPE_PATH = ENVELOPE_PATH;
export const _AAD = AAD;
