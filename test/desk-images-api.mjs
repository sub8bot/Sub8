/**
 * Local desk volume snapshot catalog + performSnapshot/Restore (injected docker).
 * Run: node test/desk-images-api.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCatalog, addImageRow, readCatalog, removeImageRow, performSnapshot, performRestore } from "../server/desk-images.mjs";

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

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
