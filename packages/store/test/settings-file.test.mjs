/**
 * settings.json holds the provider API key. It was the ONE file in the package
 * that skipped writeJsonAtomic, and its loader's catch was bare:
 *
 *   - fs.writeFile opens with O_TRUNC, so the file is zero bytes before the
 *     first byte of new content lands. A crash in that window leaves a
 *     truncated or empty settings.json.
 *   - loadSettings then hit JSON.parse -> SyntaxError -> catch -> "write the
 *     defaults back", silently destroying the stored key. Nothing else in the
 *     tree can re-derive it.
 *
 * readBotsFile has always had the right guard (ENOENT means "not there yet",
 * anything else rethrows). These pin the same rule for settings, and pin that
 * the writes are atomic so the window cannot open in the first place.
 *
 * Runs against a mkdtemp dir — data/settings.json holds the real key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-settings-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("../dist/index.js");
const settingsPath = path.join(tmp, "settings.json");
const SECRET = "xai-test-not-a-real-key-0123456789";

test("a truncated settings.json does NOT get overwritten with defaults", async () => {
  await store.saveSettings({ harness: { provider: "spacexai", apiKey: SECRET } });
  assert.equal((await store.loadSettings()).harness.apiKey, SECRET, "sanity: the key round-trips");

  // Exactly what a crash inside a non-atomic write leaves behind.
  const whole = await fs.readFile(settingsPath, "utf8");
  // Cut AFTER the key so the assertion below can show the bytes survived.
  const cut = whole.slice(0, whole.indexOf(SECRET) + SECRET.length + 2);
  await fs.writeFile(settingsPath, cut);

  await assert.rejects(
    () => store.loadSettings(),
    (err) => err instanceof SyntaxError || /JSON/i.test(String(err?.message)),
    "a corrupt file must surface, not be silently replaced",
  );

  // The bytes are still there to repair by hand. Before, they were gone.
  const after = await fs.readFile(settingsPath, "utf8");
  assert.equal(after, cut, "the corrupt file was rewritten, destroying the evidence");
  assert.equal(after.includes("apiKey"), true);

  await fs.writeFile(settingsPath, whole);
  assert.equal((await store.loadSettings()).harness.apiKey, SECRET, "and the key survives the repair");
});

test("a missing settings.json still yields defaults, as before", async () => {
  await fs.rm(settingsPath, { force: true });
  const s = await store.loadSettings();
  assert.equal(s.harness.apiKey, "");
  assert.ok(await fs.access(settingsPath).then(() => true, () => false), "defaults are written back");
});

// NOTE: does not discriminate for the bug above — the old plain fs.writeFile
// also left no .tmp and also round-tripped. It guards the temp+rename shape
// against a future change.
test("settings writes are atomic — no truncated window, no stray temp file", async () => {
  await store.saveSettings({ harness: { provider: "spacexai", apiKey: SECRET } });
  // writeJsonAtomic writes .settings.json.<pid>.<ts>.tmp then renames.
  const left = (await fs.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(left, [], `temp files left behind: ${left.join(", ")}`);
  const raw = await fs.readFile(settingsPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(raw), "the file on disk is always complete JSON");
  assert.equal(JSON.parse(raw).harness.apiKey, SECRET);
});

// NOTE: same — passes with or without the fix. The discriminating test in this
// file is the assert.rejects on a truncated file.
test("a save preserves the key across an unrelated read", async () => {
  await store.saveSettings({ harness: { provider: "spacexai", apiKey: SECRET } });
  await store.loadSettings();
  await store.loadSettings();
  assert.equal((await store.loadSettings()).harness.apiKey, SECRET);
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
