import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const py = path.join(root, "vm", "box-input.py");
const click = path.join(root, "vm", "octo-click.sh");

assert.ok(fs.existsSync(py), "box-input.py exists");
const help = execFileSync("python3", [py, "--help"], { encoding: "utf8" });
assert.match(help, /box-input click/);
assert.match(help, /type TEXT/);

const src = fs.readFileSync(click, "utf8");
assert.match(src, /box-input click/, "octo-click prefers XTEST");
assert.match(src, /xdotool/, "xdotool remains a fallback");

execFileSync("python3", ["-m", "py_compile", py], { stdio: "pipe" });

const oneTab = path.join(root, "vm", "chrome-one-tab.py");
execFileSync("python3", ["-m", "py_compile", oneTab], { stdio: "pipe" });
const oneSrc = fs.readFileSync(oneTab, "utf8");
assert.match(oneSrc, /Page\.navigate/);
assert.doesNotMatch(oneSrc, /--new-tab/);
const desk = fs.readFileSync(path.join(root, "vm", "chrome-desktop.sh"), "utf8");
assert.doesNotMatch(desk, /--new-tab/);
assert.match(desk, /chrome-one-tab/);
assert.match(desk, /remote-debugging-port=9222/);
assert.match(desk, /user-data-dir=\/config\/chrome-desk/);
const start = fs.readFileSync(path.join(root, "start.sh"), "utf8");
assert.match(start, /ram=8/);
assert.doesNotMatch(start, /memory 24/);
console.log("ok box-input");
