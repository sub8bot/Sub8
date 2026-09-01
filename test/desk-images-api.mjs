/**
 * Local desk volume snapshot catalog + performSnapshot/Restore (injected docker).
 * Run: node test/desk-images-api.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archivePath, createCatalog, addImageRow, readCatalog, removeImageRow, performSnapshot, performRestore, beginDiskJob, getDiskJob, endDiskJob, patchDiskJob, watchFileSize } from "../server/desk-images.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-img-"));
process.env.SUB8BOT_DATA = dir;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

await test("catalog create/add/read roundtrip", () => {
  const cat = createCatalog(dir);
  const row = addImageRow(cat, {
    computerId: "c1",
    volume: "vol-c1",
    fileName: "img.tgz",
    bytes: 12,
    note: "before cloud",
  });
  assert.equal(row.computerId, "c1");
  assert.equal(row.volume, "vol-c1");
  assert.equal(row.fileName, "img.tgz");
  assert.equal(row.bytes, 12);
  assert.equal(row.note, "before cloud");
  assert.ok(row.id);
  assert.ok(row.createdAt > 0);
  assert.equal(readCatalog(dir).length, 1);
});

await test("removeImageRow drops the catalog entry", () => {
  const before = readCatalog(dir);
  assert.equal(before.length, 1);
  const removed = removeImageRow(dir, before[0].id);
  assert.equal(removed.id, before[0].id);
  assert.equal(readCatalog(dir).length, 0);
});

await test("performSnapshot with injected run records argv and writes bytes", async () => {
  const calls = [];
  const controlCalls = [];
  const row = await performSnapshot({
    computerId: "comp-1",
    note: "preflight",
    dataDir: dir,
    computer: { id: "comp-1", container: "localbot-comp1", volume: "vol-c1" },
    control: {
      pause: async (name) => {
        controlCalls.push(["pause", name]);
      },
      unpause: async (name) => {
        controlCalls.push(["unpause", name]);
      },
    },
    run: async (argv) => {
      calls.push(argv.slice());
      // snapshotArgs mounts hostDir at /to and writes /to/<base> — create the archive the runner "would".
      const toBind = argv.find((a) => typeof a === "string" && a.endsWith(":/to"));
      assert.ok(toBind, "expected host:/to bind");
      const hostDir = toBind.slice(0, -":/to".length);
      const outIdx = argv.indexOf("-czf");
      assert.ok(outIdx >= 0);
      const archiveInContainer = argv[outIdx + 1]; // /to/<file>
      const base = path.basename(archiveInContainer);
      fs.writeFileSync(path.join(hostDir, base), "fake-tarball-bytes");
      return { ok: true, out: "", err: "" };
    },
  });
  assert.equal(row.computerId, "comp-1");
  assert.equal(row.volume, "vol-c1");
  assert.equal(row.note, "preflight");
  assert.ok(row.bytes > 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "run");
  assert.ok(!calls[0].includes("commit"));
  assert.deepEqual(controlCalls, [
    ["pause", "localbot-comp1"],
    ["unpause", "localbot-comp1"],
  ]);
  assert.equal(readCatalog(dir).some((r) => r.id === row.id), true);
  const archiveAbs = path.join(dir, "desk-images", row.fileName);
  assert.equal(fs.existsSync(archiveAbs), true);
});

await test("performSnapshot 404s when computer is missing", async () => {
  await assert.rejects(
    () =>
      performSnapshot({
        computerId: "missing",
        dataDir: dir,
        resolveComputer: async () => null,
        control: { pause: async () => {}, unpause: async () => {} },
        run: async () => ({ ok: true, out: "", err: "" }),
      }),
    (err) => err instanceof Error && err.message === "not found" && err.status === 404,
  );
});

await test("performRestore stops, restores, starts (injected)", async () => {
  const images = readCatalog(dir);
  const snap = images.find((r) => r.computerId === "comp-1");
  assert.ok(snap, "need a snapshot from the prior test");
  const calls = [];
  const controlCalls = [];
  await performRestore({
    computerId: "comp-1",
    imageId: snap.id,
    dataDir: dir,
    computer: { id: "comp-1", container: "localbot-comp1", volume: "vol-c1" },
    control: {
      stop: async (name) => {
        controlCalls.push(["stop", name]);
      },
      start: async (name) => {
        controlCalls.push(["start", name]);
      },
    },
    run: async (argv) => {
      calls.push(argv.slice());
      return { ok: true, out: "", err: "" };
    },
  });
  assert.deepEqual(controlCalls, [
    ["stop", "localbot-comp1"],
    ["start", "localbot-comp1"],
  ]);
  // restoreVolume: volume create, then untar
  assert.ok(calls.length >= 2);
  assert.deepEqual(calls[0], ["volume", "create", "vol-c1"]);
  assert.equal(calls[1][0], "run");
  assert.ok(!calls.flat().includes("commit"));
  assert.ok(!controlCalls.some(([op]) => op === "pause"));
});

await test("removeImageRow deletes the archive file", () => {
  const images = readCatalog(dir).filter((r) => r.computerId === "comp-1");
  assert.ok(images.length >= 1);
  const target = images[0];
  const archiveAbs = path.join(dir, "desk-images", target.fileName);
  assert.equal(fs.existsSync(archiveAbs), true);
  removeImageRow(dir, target.id);
  assert.equal(fs.existsSync(archiveAbs), false);
  assert.equal(readCatalog(dir).some((r) => r.id === target.id), false);
});

await test("disk job map roundtrip and clear", () => {
  assert.equal(getDiskJob("c-job"), null);
  beginDiskJob({ computerId: "c-job", action: "snapshot", phase: "pausing", bytes: 0, totalBytes: 100 });
  assert.equal(getDiskJob("c-job").phase, "pausing");
  patchDiskJob("c-job", { phase: "copying", bytes: 40 });
  assert.equal(getDiskJob("c-job").bytes, 40);
  endDiskJob("c-job");
  assert.equal(getDiskJob("c-job"), null);
});

await test("watchFileSize reports a growing archive", async () => {
  const file = path.join(dir, "grow.bin");
  const seen = [];
  const stop = watchFileSize(file, (n) => seen.push(n), 40);
  fs.writeFileSync(file, "aaa");
  await new Promise((r) => setTimeout(r, 90));
  fs.writeFileSync(file, "aaabbbbb");
  await new Promise((r) => setTimeout(r, 90));
  stop();
  assert.ok(seen.some((n) => n >= 3));
  assert.ok(seen.some((n) => n >= 8));
});

await test("performSnapshot publishes copying job then clears it", async () => {
  let during = null;
  await performSnapshot({
    computerId: "comp-job",
    dataDir: dir,
    computer: { id: "comp-job", container: "localbot-job", volume: "vol-job" },
    control: { pause: async () => {}, unpause: async () => {} },
    run: async (argv) => {
      during = getDiskJob("comp-job");
      const toBind = argv.find((a) => typeof a === "string" && a.endsWith(":/to"));
      const hostDir = toBind.slice(0, -":/to".length);
      const outIdx = argv.indexOf("-czf");
      fs.writeFileSync(path.join(hostDir, path.basename(argv[outIdx + 1])), "job-bytes");
      return { ok: true, out: "", err: "" };
    },
  });
  assert.equal(during.action, "snapshot");
  assert.equal(during.phase, "copying");
  assert.equal(getDiskJob("comp-job"), null);
});

await test("archivePath is the catalog row's tarball inside desk-images/", () => {
  assert.equal(archivePath(dir, { fileName: "cmp-1.tar.gz" }), path.join(dir, "desk-images", "cmp-1.tar.gz"));
});

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
