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
assert.match(desk, /remote-debugging-port=/);
assert.match(desk, /chrome-desk/);
assert.match(desk, /DEBUG_PORT/);
execFileSync("python3", ["-m", "py_compile", path.join(root, "vm", "page-agent.py")], { stdio: "pipe" });
assert.ok(fs.existsSync(path.join(root, "vm", "desk-display.sh")));
const start = fs.readFileSync(path.join(root, "start.sh"), "utf8");
assert.match(start, /ram=8/);
assert.doesNotMatch(start, /memory 24/);

const doctor = fs.readFileSync(path.join(root, "vm", "desk-doctor.sh"), "utf8");
assert.match(doctor, /desk-doctor/);
assert.match(doctor, /9222/);
const adapter = fs.readFileSync(path.join(root, "prompts", "local-adapter.txt"), "utf8");
assert.match(adapter, /desk-doctor/);
assert.match(adapter, /\/config/);
assert.doesNotMatch(adapter, /\/home\/box/);
assert.doesNotMatch(adapter, /16 GiB|1280×800/);
assert.match(adapter, /no ExternalShell/);
assert.match(adapter, /one tab/);
const caps = fs.readFileSync(path.join(root, "prompts", "capabilities.txt"), "utf8");
assert.doesNotMatch(caps, /full XFCE session/i);
assert.match(caps, /one tab/);
const ui = fs.readFileSync(path.join(root, "vm", "reference", "app-ui.md"), "utf8");
assert.match(ui, /Settings \(gear\)/);
assert.match(ui, /Harness/);
assert.match(ui, /Reload computer/);
assert.match(ui, /no Plugins tab/);
assert.doesNotMatch(ui, /Cmd\+,/);

const boxSrc = fs.readFileSync(py, "utf8");
assert.match(boxSrc, /Clipboard paste keeps punctuation/);
assert.match(boxSrc, /xclip/);
assert.match(boxSrc, /ctrl\+v/);
assert.doesNotMatch(boxSrc, /if all\(ord\(c\) < 127/);

const vmSrc = fs.readFileSync(path.join(root, "server", "vm.mjs"), "utf8");
assert.match(vmSrc, /looksLikeTypedText/);
assert.match(vmSrc, /never send a URL via key|looksLikeTypedText\(seq\)/);
console.log("ok box-input");
