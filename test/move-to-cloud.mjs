/**
 * Pure helpers for Move to Cloud: which tar entries copy, and the desk-action shell.
 * Run: node test/move-to-cloud.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pickMoveEntries, destInConfig, shellWriteFile, filesToCopyFromArchive, remapMovePath, personalNameFromNotes, identityStamp } from "../server/move-to-cloud.mjs";

assert.deepEqual(pickMoveEntries(["Desktop/MOVE-MARKER.txt", "chrome/Default/Cookies", "../etc/passwd"]), [
  "Desktop/MOVE-MARKER.txt",
]);
assert.deepEqual(
  pickMoveEntries([
    "agent-data/agents/aaa/memory/profile.md",
    "agent-data/user-memory/by-agent/aaa/profile.md",
    ".grok/sessions/x/summary.json",
    "chrome-desk/Cookies",
    "workspace/notes.md",
  ]).sort(),
  [
    "agent-data/agents/aaa/memory/profile.md",
    "agent-data/user-memory/by-agent/aaa/profile.md",
    "workspace/notes.md",
  ].sort(),
);
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

const fromId = "11111111-1111-4111-8111-111111111111";
const toId = "cloud-cmp_abc";
assert.equal(
  remapMovePath(`agent-data/agents/${fromId}/memory/profile.md`, fromId, toId),
  `agent-data/agents/${toId}/memory/profile.md`,
);

const memDir = path.join(root, "agent-data", "agents", fromId, "memory");
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(path.join(memDir, "profile.md"), `- Personal name: mika2854\n- bot: ${fromId}\n`);
const archive2 = path.join(dir, "desk-mem.tgz");
execFileSync("tar", ["-C", root, "-czf", archive2, "."]);
const moved = filesToCopyFromArchive(archive2, { fromBotId: fromId, toBotId: toId });
const profile = moved.find((f) => /memory\/profile\.md$/.test(f.dest));
assert.ok(profile, "agent memory must copy");
assert.equal(profile.dest, `/config/agent-data/agents/${toId}/memory/profile.md`);
assert.match(profile.body.toString("utf8"), /mika2854/);
assert.equal(profile.body.toString("utf8").includes(fromId), false, "rewrite local bot id in notes");
assert.match(profile.body.toString("utf8"), new RegExp(toId));

assert.equal(personalNameFromNotes("- Personal name: mika2854\n"), "mika2854");
assert.match(identityStamp({ handle: "local1", personalName: "mika2854" }), /mika2854/);
assert.match(identityStamp({ handle: "local1", personalName: "mika2854" }), /Bot handle: local1/);

console.log("ok move-to-cloud");
