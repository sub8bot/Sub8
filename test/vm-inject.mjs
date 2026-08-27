/**
 * writeFileToContainer used to chown through a login shell:
 *
 *   docker exec -u root <box> bash -lc `chown abc:abc ${JSON.stringify(dest)} ...`
 *
 * JSON.stringify escapes `"` and `\` but NOT `$` or a backtick, and both expand
 * inside double quotes. `dest` is model-chosen: resolveMemoryPath (memory,
 * update_state) rejects `..`, `/` and `/config`, and enforces a
 * /config/workspace prefix, but places no limit on the character set — so a
 * basename carrying a command substitution reached that string and ran as
 * ROOT in the box. That escapes the privilege boundary the shell tool sets for
 * itself: vm.shell always execs -u abc.
 *
 * The chown now execs the binary directly, with dest as a literal argv entry.
 *
 * Real behaviour test, no source matching: DOCKER_BIN points at a recorder, so
 * the exact argv is asserted. The recorder does not execute what it records, so
 * the argv assertions are what discriminate here; the canary check guards the
 * neighbouring regression -- a docker() that ever spawned with shell:true would
 * expand the substitution on the HOST, and then the file would appear.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-vm-inject-"));
const argvLog = path.join(tmp, "argv.log");
const canary = path.join(tmp, "PWNED");
const fake = path.join(tmp, "fakedocker");

// Records one argument per line, succeeds, prints nothing.
await fs.writeFile(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nexit 0\n`);
await fs.chmod(fake, 0o755);
process.env.DOCKER_BIN = fake;
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const vm = await import("../server/vm.mjs");

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

// A basename a model can actually produce through `memory`.
const EVIL = `/config/workspace/note_$(touch ${canary})_end.md`;

await test("a command substitution in the path never reaches a shell", async () => {
  await fs.writeFile(argvLog, "");
  await vm.writeFileToContainer("sub8-testbox", EVIL, "hello");
  const argv = (await fs.readFile(argvLog, "utf8")).split("\n").filter(Boolean);

  assert.equal(fsSync.existsSync(canary), false, "the substitution EXECUTED — this is command injection as root");
  assert.equal(argv.includes("bash"), false, "no login shell may be involved");
  assert.equal(argv.includes("-lc"), false, "no -lc may be involved");
  assert.ok(argv.includes("chown"), "the chown still happens");
  assert.ok(
    argv.includes(EVIL),
    "the path must arrive as ONE literal argv entry, unquoted and unexpanded",
  );
});

await test("an ordinary path still chowns to abc:abc as root", async () => {
  await fs.writeFile(argvLog, "");
  await vm.writeFileToContainer("sub8-testbox", "/config/workspace/notes.md", "hi");
  const argv = (await fs.readFile(argvLog, "utf8")).split("\n").filter(Boolean);
  assert.ok(argv.includes("cp"), "the file is still copied in");
  assert.ok(argv.includes("exec") && argv.includes("-u") && argv.includes("root"));
  assert.ok(argv.includes("abc:abc"));
  assert.ok(argv.includes("/config/workspace/notes.md"));
});

// Backticks are the other half of the same hole.
await test("backticks in the path are inert too", async () => {
  await fs.writeFile(argvLog, "");
  const tick = "/config/workspace/note_`touch " + canary + "`_end.md";
  await vm.writeFileToContainer("sub8-testbox", tick, "hi");
  assert.equal(fsSync.existsSync(canary), false, "a backtick substitution executed");
  const argv = (await fs.readFile(argvLog, "utf8")).split("\n").filter(Boolean);
  assert.ok(argv.includes(tick), "the backtick path must arrive literally");
});

await fs.rm(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok vm-inject");
process.exit(failed.length ? 1 : 0);
