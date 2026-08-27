/**
 * Orchestration lane — cheap local unit files for desktop orchestration.
 *
 * Spawns each script with node (60s timeout). Missing files SKIP; FAIL only on
 * non-zero exit. Docker is not required — testing/e2e/run.mjs already SKIPs
 * docker internally.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BOT } from "../lib/util.mjs";

const TIMEOUT_MS = 60_000;
const MAX_OUT = 256 * 1024;

const UNITS = [
  "test/channel-routes.mjs",
  "test/code-agent.mjs",
  "test/subagents.mjs",
  "test/delivery.mjs",
  "test/control-route.mjs",
  "test/latency.mjs",
  "testing/e2e/run.mjs",
];

function spawnNode(rel) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (row) => {
      if (settled) return;
      settled = true;
      resolve(row);
    };
    const child = spawn(process.execPath, [rel], {
      cwd: BOT,
      env: { ...process.env, _ZO_DOCTOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });
    const take = (buf) => {
      if (size >= MAX_OUT) return;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      const n = Math.min(b.length, MAX_OUT - size);
      chunks.push(n === b.length ? b : b.subarray(0, n));
      size += n;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      finish({
        ok: false,
        code: null,
        signal: null,
        out: String(err?.message || err),
        secs: Math.round((Date.now() - t0) / 1000),
      });
    });
    child.on("close", (code, signal) => {
      finish({
        ok: code === 0,
        code,
        signal,
        out: Buffer.concat(chunks).toString("utf8"),
        secs: Math.round((Date.now() - t0) / 1000),
      });
    });
  });
}

function tail(text) {
  const lines = String(text || "")
    .trim()
    .split(/\n/)
    .filter(Boolean);
  return (lines.slice(-2).join(" | ") || "(no output)").slice(0, 160);
}

export async function run(report) {
  for (const rel of UNITS) {
    if (!fs.existsSync(path.join(BOT, rel))) {
      report.record(rel, "orchestration", "SKIP", null, "missing");
      continue;
    }
    const r = await spawnNode(rel);
    if (r.ok) {
      report.record(rel, "orchestration", "PASS", r.secs, "exit 0");
      continue;
    }
    const detail =
      r.code == null
        ? `${r.signal ? `signal ${r.signal}` : "spawn error"}: ${tail(r.out)}`
        : `exit ${r.code}: ${tail(r.out)}`;
    report.record(rel, "orchestration", "FAIL", r.secs, detail);
  }
}
