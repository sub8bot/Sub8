/**
 * Pure helpers for Move to Cloud: which tar entries copy, and the desk-action shell.
 * Run: node test/move-to-cloud.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pickMoveEntries, destInConfig, shellWriteFile, filesToCopyFromArchive } from "../server/move-to-cloud.mjs";

assert.deepEqual(pickMoveEntries(["Desktop/MOVE-MARKER.txt", "chrome/Default/Cookies", "../etc/passwd"]), [
  "Desktop/MOVE-MARKER.txt",
]);
assert.equal(destInConfig("./Desktop/MOVE-MARKER.txt"), "/config/Desktop/MOVE-MARKER.txt");

const cmd = shellWriteFile("/config/Desktop/MOVE-MARKER.txt", "hello-cloud");
assert.match(cmd, /mkdir -p "\/config\/Desktop"/);
assert.match(cmd, /base64 -d/);
assert.equal(cmd.includes("hello-cloud"), false, "payload is base64, not raw");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "move-tar-"));
const root = path.join(dir, "cfg");
fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
fs.writeFileSync(path.join(root, "Desktop", "MOVE-MARKER.txt"), "probe-xyz");
fs.mkdirSync(path.join(root, "chrome", "Default"), { recursive: true });
fs.writeFileSync(path.join(root, "chrome", "Default", "Cookies"), "secret");
const archive = path.join(dir, "desk.tgz");
execFileSync("tar", ["-C", root, "-czf", archive, "."]);
const files = filesToCopyFromArchive(archive);
assert.equal(files.length, 1);
assert.equal(files[0].dest, "/config/Desktop/MOVE-MARKER.txt");
assert.equal(files[0].body.toString("utf8"), "probe-xyz");

console.log("ok move-to-cloud");
