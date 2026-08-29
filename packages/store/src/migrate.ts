import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Encrypted vault plus the on-disk key fallback (Keychain is preferred on macOS). */
export const VAULT_FILENAMES = ["vault.enc", ".vault.key"] as const;

export interface MigrateUserDataResult {
  clonedFrom: string | null;
  copied: string[];
}

/**
 * Previous product data dirs. After a rename (OctoBot → Sub8Bot → Sub8) the
 * packaged app writes to a new userData folder; bots.json can already exist
 * there from a first launch while vault.enc stayed in the old folder.
 */
export function legacyDataDirs(home = os.homedir(), extraSources: readonly string[] = []): string[] {
  const darwin = [
    path.join(home, "Library", "Application Support", "Sub8Bot", "data"),
    path.join(home, "Library", "Application Support", "OctoBot", "data"),
    path.join(home, "Library", "Application Support", "octobot", "data"),
  ];
  const win = [
    path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Sub8Bot", "data"),
    path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "OctoBot", "data"),
  ];
  const linux = [path.join(home, ".config", "Sub8Bot", "data"), path.join(home, ".config", "OctoBot", "data")];
  const named = process.platform === "win32" ? win : process.platform === "darwin" ? darwin : linux;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...extraSources, ...named]) {
    const abs = path.resolve(dir);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** True for a real user profile, not an empty test tmp. */
export function shouldMigrateInto(dest: string): boolean {
  const abs = path.resolve(dest);
  try {
    if (fs.existsSync(path.join(abs, "bots.json"))) return true;
    if (fs.existsSync(path.join(abs, "identities.json"))) return true;
  } catch {
    /* ignore */
  }
  const n = abs.replace(/\\/g, "/");
  return /\/Sub8(?: Dev)?\/data\/?$/i.test(n);
}

export function copyMissingFiles(dest: string, sources: readonly string[], names: readonly string[]): string[] {
  const copied: string[] = [];
  fs.mkdirSync(dest, { recursive: true });
  const destAbs = path.resolve(dest);
  for (const name of names) {
    const to = path.join(destAbs, name);
    if (fs.existsSync(to)) continue;
    for (const srcDir of sources) {
      if (!srcDir) continue;
      const fromDir = path.resolve(srcDir);
      if (fromDir === destAbs) continue;
      const from = path.join(fromDir, name);
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
      try {
        fs.copyFileSync(from, to);
        fs.chmodSync(to, 0o600);
        copied.push(name);
        break;
      } catch {
        /* try the next source */
      }
    }
  }
  return copied;
}

/**
 * On update: clone a previous product folder if this profile has no bots yet,
 * then always fill in a missing vault even when bots.json already exists.
 *
 * Clone only from named legacy product dirs (OctoBot / Sub8Bot), never from
 * `extraSources`. Those are the unpack/repo `data/` folders, which exist so a
 * leftover `vault.enc` can be copied in — using them as a clone source would
 * seed every empty test tmp (and a first launch) with the sample bots.json.
 */
export function migrateUserData(
  dest: string,
  opts: { home?: string; extraSources?: readonly string[] } = {},
): MigrateUserDataResult {
  const destAbs = path.resolve(dest);
  const named = legacyDataDirs(opts.home);
  const vaultSources = legacyDataDirs(opts.home, opts.extraSources);
  let clonedFrom: string | null = null;
  if (shouldMigrateInto(destAbs) && !fs.existsSync(path.join(destAbs, "bots.json"))) {
    for (const src of named) {
      if (path.resolve(src) === destAbs) continue;
      if (!fs.existsSync(path.join(src, "bots.json"))) continue;
      fs.mkdirSync(destAbs, { recursive: true });
      fs.cpSync(src, destAbs, { recursive: true });
      clonedFrom = src;
      break;
    }
  }
  const copied = shouldMigrateInto(destAbs) ? copyMissingFiles(destAbs, vaultSources, VAULT_FILENAMES) : [];
  return { clonedFrom, copied };
}
