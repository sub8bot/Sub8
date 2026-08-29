import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyMissingFiles, legacyDataDirs, migrateUserData, shouldMigrateInto, VAULT_FILENAMES } from "../dist/index.js";

test("legacyDataDirs include previous product names", () => {
  const home = "/Users/dan";
  const dirs = legacyDataDirs(home, ["/opt/sub8/data"]);
  assert.ok(dirs[0].endsWith(`${path.sep}opt${path.sep}sub8${path.sep}data`) || dirs.some((d) => d.includes("sub8")));
  assert.ok(dirs.some((d) => d.includes("Sub8Bot")));
  assert.ok(dirs.some((d) => d.includes("OctoBot")));
});

test("shouldMigrateInto is false for an empty tmp dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-mig-"));
  assert.equal(shouldMigrateInto(tmp), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("copyMissingFiles fills vault.enc without overwriting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-mig-"));
  const dest = path.join(root, "Sub8", "data");
  const old = path.join(root, "Sub8Bot", "data");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "vault.enc"), "SECRET-VAULT");
  fs.writeFileSync(path.join(old, ".vault.key"), "SECRET-KEY");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "bots.json"), "[]");
  const copied = copyMissingFiles(dest, [old], VAULT_FILENAMES);
  assert.deepEqual(copied.sort(), [".vault.key", "vault.enc"].sort());
  assert.equal(fs.readFileSync(path.join(dest, "vault.enc"), "utf8"), "SECRET-VAULT");
  fs.writeFileSync(path.join(old, "vault.enc"), "NEWER");
  const second = copyMissingFiles(dest, [old], VAULT_FILENAMES);
  assert.deepEqual(second, []);
  assert.equal(fs.readFileSync(path.join(dest, "vault.enc"), "utf8"), "SECRET-VAULT");
  fs.rmSync(root, { recursive: true, force: true });
});

test("migrateUserData does not clone sample bots into an empty tmp dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-mig-"));
  const dest = path.join(root, "tmp-data");
  const sample = path.join(root, "repo-data");
  fs.mkdirSync(sample, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(sample, "bots.json"), JSON.stringify([{ id: "sample" }]));
  const result = migrateUserData(dest, { extraSources: [sample], home: path.join(root, "home") });
  assert.equal(result.clonedFrom, null);
  assert.equal(fs.existsSync(path.join(dest, "bots.json")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("migrateUserData clones a previous product into an empty Sub8 profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-mig-"));
  const dest = path.join(root, "home", "Library", "Application Support", "Sub8", "data");
  const old = path.join(root, "home", "Library", "Application Support", "Sub8Bot", "data");
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(old, "bots.json"), JSON.stringify([{ id: "legacy" }]));
  fs.writeFileSync(path.join(old, "vault.enc"), "VAULT");
  const result = migrateUserData(dest, { home: path.join(root, "home") });
  assert.equal(result.clonedFrom, old);
  assert.equal(fs.readFileSync(path.join(dest, "bots.json"), "utf8"), JSON.stringify([{ id: "legacy" }]));
  assert.equal(fs.readFileSync(path.join(dest, "vault.enc"), "utf8"), "VAULT");
  fs.rmSync(root, { recursive: true, force: true });
});

test("migrateUserData copies vault after bots.json already exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-mig-"));
  const dest = path.join(root, "Sub8", "data");
  const old = path.join(root, "Sub8Bot", "data");
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "bots.json"), "[]");
  fs.writeFileSync(path.join(old, "bots.json"), "[old]");
  fs.writeFileSync(path.join(old, "vault.enc"), "KEEP-ME");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "Library", "Application Support", "Sub8Bot", "data"), { recursive: true });
  const result = migrateUserData(dest, { extraSources: [old], home });
  assert.equal(result.clonedFrom, null, "must not clobber an existing profile");
  assert.ok(result.copied.includes("vault.enc"));
  assert.equal(fs.readFileSync(path.join(dest, "vault.enc"), "utf8"), "KEEP-ME");
  assert.equal(fs.readFileSync(path.join(dest, "bots.json"), "utf8"), "[]");
  fs.rmSync(root, { recursive: true, force: true });
});
