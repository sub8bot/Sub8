import test from "node:test";
import assert from "node:assert/strict";
import { snapshotArgs, restoreArgs, listVolumeArgs } from "../dist/index.js";

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
