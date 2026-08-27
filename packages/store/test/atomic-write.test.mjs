/**
 * writeJsonAtomic built its temp path from pid + Date.now() alone, so two
 * writes to the same file within one millisecond from one process produced the
 * SAME temp path: the first rename consumed it and the rest threw ENOENT.
 * Measured before the fix: 23 of 25 concurrent writes rejected.
 *
 * Callers serialised through withBots never hit it. The ones that are not
 * serialised did:
 *
 *   - teams.appendMessage (server/teams.mts) takes no lock, so two bots on one
 *     team posting in the same tick lost writes. In message_teammate the append
 *     happens BEFORE the dispatch, so the throw unwound the tool call and the
 *     teammate was never woken at all — the message was dropped, not delayed.
 *   - saveConversation / replaceConversation, which this session moved ONTO
 *     writeJsonAtomic (conversations are now the only copy of a transcript), so
 *     the fix made the collision more load-bearing, not less.
 *
 * A per-call counter in the name is enough: the collision is within one
 * process, and cross-process collisions were already impossible via the pid.
 *
 * Only the FIRST test below actually discriminates for that bug (measured: 23-24
 * of 25 writes rejected against the old name). The rest guard adjacent
 * properties and are labelled as such, rather than implying coverage they do
 * not provide.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-atomic-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("../dist/index.js");

test("concurrent writes to one file all land", async () => {
  const file = path.join(tmp, "concurrent.json");
  const out = await Promise.allSettled(
    Array.from({ length: 25 }, (_, i) => store.writeJsonAtomic(file, { i })),
  );
  const rejected = out.filter((r) => r.status === "rejected");
  assert.equal(
    rejected.length,
    0,
    `${rejected.length}/25 rejected — temp paths collided: ${rejected[0]?.reason?.message || ""}`,
  );
  assert.ok(JSON.parse(await fs.readFile(file, "utf8")), "the survivor is complete JSON");
});

// NOTE: this one does NOT discriminate for the collision above — different
// basenames produced different temp paths even with the old pid+Date.now()
// name. It guards the general property, not the bug.
test("concurrent writes to DIFFERENT files all land", async () => {
  const out = await Promise.allSettled(
    Array.from({ length: 25 }, (_, i) => store.writeJsonAtomic(path.join(tmp, `f${i}.json`), { i })),
  );
  assert.equal(out.filter((r) => r.status === "rejected").length, 0);
});

// NOTE: cannot fail for the collision above either — the losing renames consume
// nothing, so there was never an orphan to find. Kept as a guard against a
// future change that leaks temps, not as evidence for this fix.
test("no temp files are left behind", async () => {
  const left = (await fs.readdir(tmp)).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(left, [], `orphaned temp files: ${left.join(", ")}`);
});

// The property that matters: a reader never sees a partial file, because the
// content arrives by rename rather than by truncate-and-write.
// NOTE: also does not discriminate — rename was already atomic before the fix,
// and these writes are sequential. It pins the property the temp+rename shape
// exists for.
test("a concurrent reader never sees partial JSON", async () => {
  const file = path.join(tmp, "reader.json");
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: "x".repeat(80) })) };
  await store.writeJsonAtomic(file, big);
  let reads = 0;
  const stop = { now: false };
  const reader = (async () => {
    while (!stop.now) {
      try {
        JSON.parse(await fs.readFile(file, "utf8"));
        reads++;
      } catch (err) {
        if (err.code !== "ENOENT") throw new Error(`reader saw a partial file: ${err.message}`);
      }
    }
  })();
  for (let i = 0; i < 40; i++) await store.writeJsonAtomic(file, big);
  stop.now = true;
  await reader;
  assert.ok(reads > 0, "the reader never got a look in");
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
