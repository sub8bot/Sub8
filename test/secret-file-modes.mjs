/**
 * data/ holds the Cloud session token (account.json), the provider API key
 * (settings.json) and every conversation (bots.json). writeJsonAtomic created
 * them with an unmasked 0644 under a 0755 dev dataDir (`cwd()/data`), so every
 * other local account on the Mac could read them — verified on disk before the
 * fix: account.json was -rw-r--r-- with a 48-char session.token in it.
 *
 * The 0600 goes on the TEMP file, because rename keeps the source's mode.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-modes-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const { writeJsonAtomic } = await import("../packages/store/dist/store.js");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("ok  " + name))
    .catch((err) => {
      console.error("FAIL " + name);
      console.error(err);
      process.exitCode = 1;
    });
}

await test("a newly written json file is owner-only", async () => {
  const file = path.join(tmp, "account.json");
  await writeJsonAtomic(file, { session: { token: "not-a-real-token" } });
  const st = await fs.stat(file);
  assert.equal(st.mode & 0o777, 0o600, `expected 0600, got 0${(st.mode & 0o777).toString(8)}`);
});

await test("rewriting an already-loose file tightens it", async () => {
  const file = path.join(tmp, "settings.json");
  await fs.writeFile(file, "{}", { mode: 0o644 });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644, "seeded loose");
  // rename replaces the inode, so the new mode comes from the temp file.
  await writeJsonAtomic(file, { harness: { apiKey: "not-a-real-key" } });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

await test("the content still round-trips", async () => {
  const file = path.join(tmp, "bots.json");
  const value = { bots: [{ id: "a", name: "A" }] };
  await writeJsonAtomic(file, value);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), value);
});

await test("nested dirs are created and their files are owner-only too", async () => {
  const file = path.join(tmp, "conversations", "deep", "c.json");
  await writeJsonAtomic(file, [{ role: "user", content: "hi" }]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

console.log("ok secret-file-modes");
