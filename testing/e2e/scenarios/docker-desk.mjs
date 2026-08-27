import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { skip as harnessSkip } from "../harness.mjs";

const DOCKER_CANDIDATES = [
  "docker",
  "/opt/homebrew/bin/docker",
  "/usr/local/bin/docker",
  path.join(os.homedir() || "", ".sub8", "bin", "docker"),
  "/usr/bin/docker",
];

function dockerBins() {
  const out = [];
  const seen = new Set();
  for (const bin of DOCKER_CANDIDATES) {
    if (!bin || seen.has(bin)) continue;
    if (bin !== "docker" && !fs.existsSync(bin)) continue;
    seen.add(bin);
    out.push(bin);
  }
  return out.length ? out : ["docker"];
}

function execDocker(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && (err.code === "ENOENT" || err.code === "ENOTFOUND")) {
        resolve({ missing: true, ok: false, out: "" });
        return;
      }
      resolve({
        missing: false,
        ok: !err,
        out: String(stdout || "").trim(),
        err: String(stderr || err?.message || ""),
      });
    });
  });
}

async function docker(args) {
  let last = { missing: true, ok: false, out: "" };
  for (const bin of dockerBins()) {
    last = await execDocker(bin, args);
    if (!last.missing) return last;
  }
  return last;
}

function runningLocalbots(psOut) {
  return String(psOut || "")
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n.startsWith("localbot-") && !n.startsWith("localbot-config-"));
}

/** Live desk check. SKIP (not fail) if Docker is down or no localbot is running. */
export async function run({ skip: skipFn } = {}) {
  const bail = skipFn || harnessSkip;

  const info = await docker(["info"]);
  if (info.missing || !info.ok) bail("docker not available");

  const ps = await docker(["ps", "--filter", "name=localbot-", "--format", "{{.Names}}"]);
  if (ps.missing || !ps.ok) bail("docker not available");

  const names = runningLocalbots(ps.out);
  if (!names.length) bail("no running localbot");

  assert.ok(names.some((n) => /^localbot-/.test(n)));

  const ports = await docker(["ps", "--filter", "name=localbot-", "--format", "{{.Names}}\t{{.Ports}}"]);
  if (ports.ok && /->3011\/tcp/.test(ports.out || "")) {
    assert.match(ports.out, /->3011\/tcp/);
  }
}
