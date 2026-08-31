import test from "node:test";
import assert from "node:assert/strict";
import {
  snapshotArgs,
  restoreArgs,
  listVolumeArgs,
  ensureVolumeArgs,
  snapshotVolume,
  restoreVolume,
} from "../dist/index.js";

function recorder() {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.slice());
    return { ok: true, out: "", err: "" };
  };
  return { calls, run };
}

test("snapshot tars a named volume into a host path; it does not docker commit", () => {
  const argv = snapshotArgs("localbot-config-deadbeef", "/tmp/desk.tgz");
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("--rm"));
  assert.ok(argv.includes("localbot-config-deadbeef:/from:ro"));
  assert.ok(argv.some((a) => String(a).includes("/to/desk.tgz") || String(a).includes(":/to")));
  assert.ok(!argv.includes("commit"));
  assert.equal(argv.at(-2) === "tar" || argv.includes("tar") || argv.some((a) => String(a).startsWith("tar ")), true);
  assert.deepEqual(argv, [
    "run",
    "--rm",
    "-v",
    "localbot-config-deadbeef:/from:ro",
    "-v",
    "/tmp:/to",
    "alpine:3.20",
    "tar",
    "-C",
    "/from",
    "-czf",
    "/to/desk.tgz",
    ".",
  ]);
});

test("restore untars into the named volume", () => {
  const argv = restoreArgs("localbot-config-deadbeef", "/tmp/desk.tgz");
  assert.ok(argv.includes("localbot-config-deadbeef:/to"));
  assert.ok(!argv.includes("commit"));
  assert.deepEqual(argv, [
    "run",
    "--rm",
    "-v",
    "localbot-config-deadbeef:/to",
    "-v",
    "/tmp:/from",
    "alpine:3.20",
    "tar",
    "-C",
    "/to",
    "-xzf",
    "/from/desk.tgz",
    ".",
  ]);
});

test("listVolumeArgs lists docker volumes", () => {
  assert.deepEqual(listVolumeArgs(), ["volume", "ls"]);
});

test("refuses archive basenames that are empty or contain ..", () => {
  assert.throws(
    () => snapshotArgs("vol", "/tmp/.."),
    (err) => err instanceof Error && err.message === "desk-images: bad archive path",
  );
  assert.throws(
    () => restoreArgs("vol", "/tmp/foo/.."),
    (err) => err instanceof Error && err.message === "desk-images: bad archive path",
  );
  assert.throws(
    () => snapshotArgs("vol", "/"),
    (err) => err instanceof Error && err.message === "desk-images: bad archive path",
  );
});

test("snapshotVolume shells the tar argv and throws when docker fails", async () => {
  const { calls, run } = recorder();
  await snapshotVolume({ run, volume: "vol-a", archiveAbs: "/tmp/a.tgz" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], snapshotArgs("vol-a", "/tmp/a.tgz"));
  const bad = async () => ({ ok: false, out: "", err: "boom" });
  await assert.rejects(
    () => snapshotVolume({ run: bad, volume: "vol-a", archiveAbs: "/tmp/a.tgz" }),
    /boom/,
  );
});

test("ensureVolumeArgs creates a named volume", () => {
  assert.deepEqual(ensureVolumeArgs("vol-a"), ["volume", "create", "vol-a"]);
});

test("restoreVolume creates the volume first, then untars", async () => {
  const { calls, run } = recorder();
  await restoreVolume({ run, volume: "vol-a", archiveAbs: "/tmp/a.tgz" });
  assert.deepEqual(calls[0], ensureVolumeArgs("vol-a"));
  assert.deepEqual(calls[1], restoreArgs("vol-a", "/tmp/a.tgz"));
});

test("restoreVolume treats volume already exists as success then untars", async () => {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.slice());
    if (argv[0] === "volume" && argv[1] === "create") {
      return { ok: false, out: "", err: "Error: volume already exists" };
    }
    return { ok: true, out: "", err: "" };
  };
  await restoreVolume({ run, volume: "vol-a", archiveAbs: "/tmp/a.tgz" });
  assert.deepEqual(calls[0], ensureVolumeArgs("vol-a"));
  assert.deepEqual(calls[1], restoreArgs("vol-a", "/tmp/a.tgz"));
});

test("restoreVolume throws when volume create fails for another reason", async () => {
  const run = async () => ({ ok: false, out: "", err: "permission denied" });
  await assert.rejects(
    () => restoreVolume({ run, volume: "vol-a", archiveAbs: "/tmp/a.tgz" }),
    /permission denied/,
  );
});

test("restoreVolume throws when restore tar fails after create", async () => {
  const run = async (argv) => {
    if (argv[0] === "volume" && argv[1] === "create") {
      return { ok: true, out: "", err: "" };
    }
    return { ok: false, out: "", err: "tar boom" };
  };
  await assert.rejects(
    () => restoreVolume({ run, volume: "vol-a", archiveAbs: "/tmp/a.tgz" }),
    /tar boom/,
  );
});
