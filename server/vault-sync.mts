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
  seal,
  openText,
  newVaultKey,
  newWrappingKey,
  importWrappingKey,
  importVaultKey,
  exportKeyRaw,
  type Sealed,
} from "@sub8/vault-crypto";

/** The unlocked key, in memory only — the passcode gate holds its wrapped form. */
type Keyset = { vaultKey: Awaited<ReturnType<typeof importVaultKey>> };
import type { VaultFile } from "./vault.mjs";
import { _decryptedVaultFile, _replaceVaultFile } from "./vault.mjs";

/** The synced blob. Everything here is ciphertext except the public id lists and timestamp. */
export interface CloudVaultEnvelope {
  v: 1;
  /** The whole VaultFile JSON, sealed under the vault key (which the passcode gate holds, wrapped). */
  data: Sealed;
  /**
   * Account metadata (id, group, label, site, username — never a password) plus
   * grants, sealed under the cloud ESCROW key, so a cloud desk can list the
   * logins a Bot may use without the vault key. Absent until escrow exists.
   */
  index?: Sealed;
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
const INDEX_AAD = "sub8-vault-index";

let keyset: Keyset | null = null;
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
    if (raw && raw.data) {
      return { v: 1, data: raw.data, ...(raw.index ? { index: raw.index } : {}), escrow: raw.escrow || {}, alwaysOn: Array.isArray(raw.alwaysOn) ? raw.alwaysOn : [], updatedAt: Number(raw.updatedAt) || 0 };
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
async function buildEnvelope(ks: Keyset, alwaysOn: string[]): Promise<CloudVaultEnvelope> {
  const file = await _decryptedVaultFile();
  const data = await seal(JSON.stringify(file), ks.vaultKey, AAD);
  const escrow: Record<string, Sealed> = {};
  if (alwaysOn.length && escrowKey) {
    const byId = new Map(file.accounts.map((a) => [a.id, a]));
    for (const id of alwaysOn) {
      const acc = byId.get(id);
      if (acc?.password) escrow[id] = await seal(acc.password, escrowKey, `escrow:${id}`);
    }
  }
  let index: Sealed | undefined;
  if (escrowKey) {
    const meta = {
      accounts: file.accounts.map((a) => ({ id: a.id, groupId: a.groupId, label: a.label, site: a.site, username: a.username })),
      grants: file.grants || {},
    };
    index = await seal(JSON.stringify(meta), escrowKey, INDEX_AAD);
  }
  return { v: 1, data, ...(index ? { index } : {}), escrow, alwaysOn: alwaysOn.filter((id) => escrow[id] || !escrowKey), updatedAt: Date.now() };
}

/**
 * Turn on the cloud vault: set the passphrase, seal the current local vault, and
 * write the envelope. Returns the envelope to push to the Worker. Leaves the
 * keyset unlocked in memory.
 */
/** A fresh vault key as raw base64 — the caller hands it to the gate at setup. */
export function freshVaultKey(): Promise<string> {
  return newVaultKey().then(exportKeyRaw);
}

/** Turn on the cloud vault around a vault key the gate has just sealed under the passcode. Seals the current vault. */
export function enableWithKey(vaultKeyB64: string): Promise<CloudVaultEnvelope> {
  return withLock(async () => {
    keyset = { vaultKey: await importVaultKey(vaultKeyB64) };
    const env = await buildEnvelope(keyset, []);
    await writeEnvelope(env);
    return env;
  });
}

/** Cache the keyset from a vault key the gate returned on a correct passcode. */
export function unlockWithKey(vaultKeyB64: string): Promise<void> {
  return withLock(async () => {
    keyset = { vaultKey: await importVaultKey(vaultKeyB64) };
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
    const next = await buildEnvelope(keyset, env.alwaysOn);
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
      const file = JSON.parse(await openText(env.data, keyset.vaultKey, AAD)) as VaultFile;
      await _replaceVaultFile(file);
    }
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
    const next = await buildEnvelope(keyset, [...set]);
    await writeEnvelope(next);
    return next;
  });
}

/** For the present-to-approve relay: decrypt one account's password locally so the caller can hand it to a waiting cloud desk. Empty when locked or absent. */
export async function revealForRelay(accountId: string): Promise<string> {
  if (!keyset) return "";
  const env = await readEnvelope();
  if (!env) return "";
  const file = JSON.parse(await openText(env.data, keyset.vaultKey, AAD)) as VaultFile;
  return file.accounts.find((a) => a.id === accountId)?.password || "";
}

export const _ENVELOPE_PATH = ENVELOPE_PATH;
export const _AAD = AAD;
