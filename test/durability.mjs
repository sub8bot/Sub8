/**
 * Two ways state was lost that had nothing to do with application logic.
 *
 * 1. withFileLock unlinked the lock file in `finally` without checking it
 *    still owned it. Once any hold outran LOCK_STALE_MS a waiter broke in and
 *    created its OWN lock — which the original holder then deleted, leaving
 *    the critical section open for every later arrival, not just one.
 * 2. wakes.json was the one shared file written with a bare fs.writeFile.
 *    O_TRUNC means it is zero bytes until the write lands, and load() mapped
 *    any parse failure to an empty ledger — so a SIGTERM in that window (the
 *    Electron shell kills the server on quit and there is no signal handler)
 *    silently dropped every queued wake.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-dur-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const { withFileLock } = await import("../packages/store/dist/index.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("ok  " + name);
  } catch (err) {
    results.push({ name, ok: false });
    console.error("FAIL " + name);
    console.error(err);
  }
}

const exists = async (f) => !!(await fs.stat(f).catch(() => null));

await test("a lock broken mid-hold is not deleted by the original holder", async () => {
  const lock = path.join(tmp, "a.lock");
  await withFileLock(lock, async () => {
    // What a waiter does after LOCK_STALE_MS: break the stale lock and take it.
    await fs.unlink(lock);
    await fs.writeFile(lock, "the-next-holder", "utf8");
  });
  assert.ok(await exists(lock), "the second holder's lock must survive");
  assert.equal(await fs.readFile(lock, "utf8"), "the-next-holder");
  await fs.unlink(lock);
});

await test("a lock still held at the end is released normally", async () => {
  const lock = path.join(tmp, "b.lock");
  let sawLock = false;
  await withFileLock(lock, async () => {
    sawLock = await exists(lock);
  });
  assert.equal(sawLock, true, "the lock existed during the hold");
  assert.equal(await exists(lock), false, "and is gone afterwards");
});

await test("the wake ledger is written atomically (never a short file)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wk-"));
  const script = `
    process.env.SUB8BOT_DATA = ${JSON.stringify(dir)};
    const w = await import(${JSON.stringify(new URL("../packages/wakes/dist/index.js", import.meta.url).href)});
    for (let i = 0; i < 40; i += 1) w.enqueueWake({ botId: "b", type: "peer", payload: { i } });
    await w.flushWakes();
  `;
  await run(process.execPath, ["--input-type=module", "-e", script]);
  const body = await fs.readFile(path.join(dir, "wakes.json"), "utf8");
  JSON.parse(body); // must be complete, not truncated
  // No temp files left lying around.
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "temp files must be renamed away");

  // The atomicity itself only shows under an interrupted write, which this
  // test cannot race: a bare fs.writeFile also produces a complete file when
  // nothing kills it. So pin the mechanism. Without temp+rename there is a
  // window where the ledger is zero bytes, and load() maps that to an empty
  // Map -- which is how every queued wake disappeared on quit.
  const src = await fs.readFile(new URL("../packages/wakes/src/wakes.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /await fs\.writeFile\(tmp, body[\s\S]{0,80}await fs\.rename\(tmp, wakesPath\(\)\)/,
    "the wake ledger must be written to a temp file and renamed into place",
  );
  assert.equal(
    /await fs\.writeFile\(wakesPath\(\)/.test(src),
    false,
    "a direct write to wakes.json is back — O_TRUNC leaves it short mid-write",
  );
});

await test("an unreadable wake ledger is preserved, not silently discarded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wk2-"));
  await fs.writeFile(path.join(dir, "wakes.json"), '{"queues": {"b": [', "utf8"); // truncated
  const script = `
    process.env.SUB8BOT_DATA = ${JSON.stringify(dir)};
    await import(${JSON.stringify(new URL("../packages/wakes/dist/index.js", import.meta.url).href)});
  `;
  await run(process.execPath, ["--input-type=module", "-e", script]);
  const files = await fs.readdir(dir);
  assert.ok(
    files.some((f) => f.startsWith("wakes.json.corrupt-")),
    `the damaged ledger must be kept for recovery, saw: ${files.join(",")}`,
  );
});

await test("a second process cannot erase or resurrect wakes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-wk3-"));
  const wakesUrl = new URL("../packages/wakes/dist/index.js", import.meta.url).href;
  const ready = path.join(dir, "ready");
  const go = path.join(dir, "go");
  const readLedger = async () => JSON.parse(await fs.readFile(path.join(dir, "wakes.json"), "utf8")).queues;

  // The parent queues a wake for BOT-B.
  process.env.SUB8BOT_DATA = dir;
  // A fresh module instance bound to this dir (the module loads its ledger once).
  const parent = await import(wakesUrl + `?p=${encodeURIComponent(dir)}`);
  parent.enqueueWake({ botId: "BOT-B", type: "peer", payload: { from: "parent" } });
  await parent.flushWakes();

  // A child that loads the ledger EARLY, waits, then writes — the ordering
  // that used to resurrect a wake the parent had already delivered.
  const child = run(process.execPath, ["--input-type=module", "-e", `
    process.env.SUB8BOT_DATA = ${JSON.stringify(dir)};
    const fs = await import("node:fs/promises");
    const w = await import(${JSON.stringify(wakesUrl)});
    await fs.writeFile(${JSON.stringify(ready)}, "1");
    for (let i = 0; i < 200; i += 1) {
      if (await fs.stat(${JSON.stringify(go)}).catch(() => null)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    w.enqueueWake({ botId: "BOT-C", type: "peer", payload: { from: "child" } });
    await w.flushWakes();
  `]);

  for (let i = 0; i < 200 && !(await fs.stat(ready).catch(() => null)); i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // Parent delivers BOT-B's wake while the child is still holding its old view.
  const taken = parent.takeWakeOfType("BOT-B", "peer");
  assert.ok(taken, "the parent delivered its own wake");
  await parent.flushWakes();

  await fs.writeFile(go, "1");
  await child;

  const q = await readLedger();
  assert.ok(!(q["BOT-B"] || []).length, "a delivered wake must not come back from the other process");
  assert.equal((q["BOT-C"] || []).length, 1, "the other process's wake must survive the parent's write");
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok durability");
process.exit(failed.length ? 1 : 0);
