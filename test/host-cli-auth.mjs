import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harvestAuthFile, shareAuthFile, claudeModelArgs, MCP_DRIVE_TOOLS, hostCliTurnFailed, hermesHomeDir, writeHermesHome } from "../server/host-cli.mjs";
import { rewriteHarnessOutput, hasAuthFailure, looksLikeAuthFailure } from "@sub8/harness-auth";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-auth-"));
const src = path.join(dir, "host-auth.json");
const dest = path.join(dir, "cli-home", "auth.json");
await fs.writeFile(src, JSON.stringify({ tokens: { refresh_token: "v1" } }));

const linked = await shareAuthFile(src, dest);
assert.equal(linked, "symlink");
assert.equal(await fs.readlink(dest), src);
await fs.writeFile(dest, JSON.stringify({ tokens: { refresh_token: "v2" } }));
assert.equal(JSON.parse(await fs.readFile(src, "utf8")).tokens.refresh_token, "v2");
assert.equal(await harvestAuthFile(src, dest), "symlink");

const copyDir = path.join(dir, "copied");
const copyDest = path.join(copyDir, "auth.json");
await fs.mkdir(copyDir);
await fs.writeFile(copyDest, JSON.stringify({ tokens: { refresh_token: "v3" } }));
assert.equal(await harvestAuthFile(src, copyDest), "copied-back");
assert.equal(JSON.parse(await fs.readFile(src, "utf8")).tokens.refresh_token, "v3");

await fs.rm(dir, { recursive: true, force: true });

assert.deepEqual(claudeModelArgs(""), ["--fallback-model", "sonnet"]);
assert.deepEqual(claudeModelArgs("default"), ["--fallback-model", "sonnet"]);
assert.deepEqual(claudeModelArgs("auto"), ["--fallback-model", "sonnet"]);
assert.deepEqual(claudeModelArgs("sonnet"), ["--model", "sonnet", "--fallback-model", "sonnet"]);
assert.deepEqual(claudeModelArgs("fable"), ["--model", "fable", "--fallback-model", "sonnet"]);

assert.match(MCP_DRIVE_TOOLS, /\btask\b/);
assert.match(MCP_DRIVE_TOOLS, /\bread\b/);
assert.match(MCP_DRIVE_TOOLS, /\bweb_search\b/);
assert.match(MCP_DRIVE_TOOLS, /\bcreate_channel\b/);
assert.match(MCP_DRIVE_TOOLS, /\bcloud_agent\b/);
assert.doesNotMatch(MCP_DRIVE_TOOLS, /ExternalShell/);

// host-cli.mjs ran rewriteHarnessOutput over the output of EVERY finished turn,
// success included. That rewrite replaces the whole answer with "…is signed
// out" on auth-ish wording and calls noteAuthFailure, benching the harness for
// 30 minutes. agent.mjs and index.mjs already guard their calls; this one did
// not, so a real answer that merely discussed OAuth was destroyed.
const legitAnswer = [
  "To rotate credentials safely, exchange the refresh token for a new access",
  "token before the old one expires. If the server returns 401 Unauthorized,",
  "the user must log in again — surface that instead of retrying silently.",
].join("\n");

// First: prove the damage is real, so the guard below is load-bearing.
assert.equal(looksLikeAuthFailure(legitAnswer), true);
const destroyed = rewriteHarnessOutput("claude", legitAnswer);
assert.notEqual(destroyed, legitAnswer);
assert.match(destroyed, /signed out|sign in/i);
assert.equal(hasAuthFailure("claude"), true, "and it benches the harness for 30 minutes");

// Now the guard itself: a turn that answered and exited 0 is NOT a failure, so
// that output never reaches the rewrite.
assert.equal(hostCliTurnFailed(0, legitAnswer), false);
assert.equal(hostCliTurnFailed(0, "plain answer"), false);

// A genuinely signed-out CLI still is one: it exits non-zero, or says nothing.
assert.equal(hostCliTurnFailed(1, "Authentication required. Please log in."), true);
assert.equal(hostCliTurnFailed(2, "boom"), true);
assert.equal(hostCliTurnFailed(0, ""), true);
assert.equal(hostCliTurnFailed(0, "   \n  "), true);
assert.equal(hostCliTurnFailed(0, null), true);
assert.equal(hostCliTurnFailed(null, "answer"), true, "a null exit code is not a clean exit");

// The hermes home is PERSISTENT (under dataDir), unlike codex's, which lives in
// the per-turn temp dir. That asymmetry is why the two sites drifted: the spawn
// site wrote to dataDir/hermes-host while finish() harvested from
// work/hermes-home — a path nothing creates — so refresh tokens were never
// copied back and the harvest silently did nothing.
{
  const src = readFileSync(new URL("../server/host-cli.mjs", import.meta.url), "utf8");
  const write = src.match(/await writeHermesHome\(([^,]+),/);
  // Capture everything path.join() is given BEFORE the trailing "auth.json", so
  // a wrong path fails as "wrong path" rather than as "call not found". Anchored
  // on "auth.json" because a plain [^)]* stops inside hermesHomeDir()'s parens.
  const harvest = src.match(/hostHermesAuthPath\(\),\s*path\.join\((.*?)"auth\.json"\)/);
  assert.ok(write, "could not find the writeHermesHome call");
  assert.ok(harvest, "could not find the hermes harvestAuthFile call");
  assert.equal(write[1].trim(), "hermesHomeDir()", "the hermes home must come from hermesHomeDir()");
  assert.equal(
    harvest[1].replace(/\s+/g, " ").trim(),
    "hermesHomeDir(),",
    "the hermes harvest must read the same dir it wrote",
  );
  assert.doesNotMatch(src, /"hermes-home"/, 'the stale work/hermes-home path must be gone');
}

// writeHermesHome puts auth.json in the directory it is handed, which is what
// makes "both sites pass hermesHomeDir()" sufficient. Temp dir only: this reads
// ~/.hermes but never writes to it (shareAuthFile symlinks dest -> src).
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-hermes-"));
  const home = path.join(tmp, "hermes-host");
  const got = await writeHermesHome(home, {});
  assert.equal(got, home, "writeHermesHome returns the home it was given");
  const cfg = await fs.readFile(path.join(home, "config.yaml"), "utf8");
  assert.match(cfg, /mcp_servers:/, "it writes its config into that home");
  await fs.rm(tmp, { recursive: true, force: true });
}

assert.match(hermesHomeDir(), /hermes-host$/);

console.log("ok host-cli-auth");
