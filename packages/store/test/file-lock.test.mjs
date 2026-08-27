/**
 * withFileLock and writeJsonAtomic are the two primitives under bots.json,
 * channels.json and projects.json, and every other module reaches the user's
 * data through them. Three failures are the ones that would actually hurt:
 * two writers interleaving and losing a bot, a lock that outlives a throwing
 * callback and wedges the process, and a reader catching a half-written file.
 *
 * Everything here runs against a mkdtemp directory. bots.json holds live bots.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-file-lock-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

// dataDir binds at import, so SUB8BOT_DATA has to be set first.
const store = await import("../dist/index.js");

test("this suite is bound to a temp dir, not the user's data", () => {
  assert.equal(store.dataDir, tmp);
  assert.ok(store.botsPath.startsWith(tmp), `${store.botsPath} must be under ${tmp}`);
  assert.equal(store.botsPath.includes(`${path.sep}bot${path.sep}data${path.sep}`), false);
});

test("concurrent writers serialise: no overlap, and no update is lost", async () => {
  const file = path.join(tmp, "counter.json");
  const lock = `${file}.lock`;
  await fs.writeFile(file, JSON.stringify({ n: 0, who: [] }));
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.withFileLock(lock, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        // A read-modify-write with a real await in the middle: the window a
        // broken lock would let another writer through.
        const row = JSON.parse(await fs.readFile(file, "utf8"));
        await new Promise((r) => setTimeout(r, 5));
        row.n += 1;
        row.who.push(i);
        await store.writeJsonAtomic(file, row);
        inside -= 1;
      }),
    ),
  );
  const final = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(maxInside, 1, "two callbacks were inside the lock at once");
  assert.equal(final.n, 8, "an increment was lost");
  assert.deepEqual([...final.who].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await fs.access(lock).then(() => true, () => false), false, "the lock is gone afterwards");
});

test("the lock is released when the callback throws, and when it rejects", async () => {
  const lock = path.join(tmp, "throwing.lock");
  const boom = new Error("write failed halfway");
  await assert.rejects(
    () =>
      store.withFileLock(lock, () => {
        throw boom;
      }),
    (err) => err === boom, // the caller's own error, not a lock error
  );
  assert.equal(await fs.access(lock).then(() => true, () => false), false, "a throw must not leave the lock behind");

  await assert.rejects(
    () =>
      store.withFileLock(lock, async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("rejected later");
      }),
    /rejected later/,
  );
  assert.equal(await fs.access(lock).then(() => true, () => false), false);

  // And the next writer gets in straight away rather than waiting out a
  // 20-second timeout on a lock nobody holds.
  const t0 = Date.now();
  assert.equal(await store.withFileLock(lock, () => "next writer"), "next writer");
  assert.ok(Date.now() - t0 < 1_000, "the next acquire should be immediate");
});

test("a lock held by someone else blocks until it is dropped", async () => {
  const lock = path.join(tmp, "foreign.lock");
  await fs.writeFile(lock, "99999");
  let ran = false;
  const waiting = store.withFileLock(lock, () => {
    ran = true;
    return "got it";
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ran, false, "a fresh foreign lock must not be walked through");
  await fs.unlink(lock);
  assert.equal(await waiting, "got it");
});

test("a stale lock is broken instead of deadlocking forever", async () => {
  const lock = path.join(tmp, "stale.lock");
  await fs.writeFile(lock, "31337");
  // A process that died holding the lock leaves the file behind. Backdate it
  // past the 30s staleness window rather than sleeping through it.
  const old = (Date.now() - 90_000) / 1000;
  await fs.utimes(lock, old, old);
  const t0 = Date.now();
  assert.equal(await store.withFileLock(lock, () => "broke in"), "broke in");
  assert.ok(Date.now() - t0 < 5_000, `should not wait out the 20s timeout, took ${Date.now() - t0}ms`);
  assert.equal(await fs.access(lock).then(() => true, () => false), false);
});

test("withFileLock creates the directory its lock lives in", async () => {
  const lock = path.join(tmp, "nested", "deeper", "still", "new.lock");
  assert.equal(await store.withFileLock(lock, () => 42), 42);
  assert.ok((await fs.stat(path.dirname(lock))).isDirectory());
});

test("writeJsonAtomic never lets a reader see a half-written file", async () => {
  const file = path.join(tmp, "atomic.json");
  const sizes = [];
  let stop = false;
  const writer = (async () => {
    for (let i = 1; i <= 40; i += 1) {
      // Big enough that a plain writeFile would be split across several
      // physical writes, which is what a torn read looks like in practice.
      const rows = Array.from({ length: i * 200 }, (_, n) => ({ n, pad: "x".repeat(120) }));
      sizes.push(rows.length);
      await store.writeJsonAtomic(file, rows);
    }
    stop = true;
  })();
  const reads = [];
  const reader = (async () => {
    while (!stop) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const rows = JSON.parse(raw);
        assert.ok(Array.isArray(rows), "a read must never see a fragment of the array");
        reads.push(rows.length);
      } catch (err) {
        // Not yet created is fine. A parse error is the failure this pins.
        assert.equal(err.code, "ENOENT", `torn read: ${err.message}`);
      }
    }
  })();
  await Promise.all([writer, reader]);
  assert.ok(reads.length > 5, `the reader should have caught the writer mid-flight, got ${reads.length} reads`);
  for (const n of reads) assert.ok(sizes.includes(n), `read a row count nobody ever wrote: ${n}`);

  const leftovers = (await fs.readdir(tmp)).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, [], "the rename must not leave temp files behind");
});

test("writeJsonAtomic creates parent directories and replaces the old file whole", async () => {
  const file = path.join(tmp, "made", "up", "path", "rows.json");
  await store.writeJsonAtomic(file, [{ a: 1 }]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), [{ a: 1 }]);
  await store.writeJsonAtomic(file, { b: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { b: 2 }, "no remnant of the previous contents");
});

test("four processes upserting at once all land in bots.json", async () => {
  // The in-process write chain cannot help here: this is the file lock or
  // nothing. The old suite ran its writers one after another, which is exactly
  // the case a broken lock still passes.
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-lock-procs-"));
  const storeUrl = JSON.stringify(path.join(pkg, "dist", "index.js"));
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  const runs = ids.map(
    (id, i) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import * as store from ${storeUrl};
const bot = store.newBot({ name: "bot-${i}" });
bot.id = ${JSON.stringify(id)};
await store.upsertBot(bot);`,
          ],
          { env: { ...process.env, SUB8BOT_DATA: data, OCTOBOT_DATA: data }, cwd: pkg, stdio: ["ignore", "pipe", "pipe"] },
        );
        let err = "";
        child.stderr.on("data", (b) => {
          err += b;
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${i} exited ${code}: ${err}`))));
      }),
  );
  await Promise.all(runs);
  const rows = JSON.parse(await fs.readFile(path.join(data, "bots.json"), "utf8"));
  assert.equal(rows.length, 4, `a concurrent write was lost: ${rows.map((b) => b.name).join(",")}`);
  assert.deepEqual(rows.map((b) => b.id).sort(), [...ids].sort());
  assert.deepEqual((await fs.readdir(data)).filter((n) => n.endsWith(".lock")), [], "no lock file survives");
  await fs.rm(data, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
