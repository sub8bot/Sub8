/**
 * Cloud-unit lane — the sub8-cloud unit suite (`npm test`).
 *
 * Runs the same suite the cloud repo runs in CI, and records one battery row per
 * PASS/FAIL line so the dashboard shows each unit test. If the runner emits no
 * recognizable lines, we record a single row for the whole suite by exit code.
 */
import fs from "node:fs";
import path from "node:path";
import { CLOUD, run as exec } from "../lib/util.mjs";

export async function run(report) {
  if (!fs.existsSync(path.join(CLOUD, "package.json"))) {
    report.record("cloud-unit-suite", "cloud-unit", "SKIP", null, "sub8-cloud not found");
    return;
  }
  const r = await exec("npm", ["test", "--silent"], { cwd: CLOUD, timeout: 240_000 });
  const lines = r.out.split("\n");
  // Deterministic anchor: the runner prints one "ok <group>" per test file at the
  // end (stable count), and "FAIL"/"not ok" on any failure. We record one row per
  // GROUP (stable) rather than per-test (whose captured count races with the
  // executor selftest's interleaved stdout and made the total flap 134↔137).
  const fails = lines.filter((l) => /^\s*(FAIL\b|not ok\b)/i.test(l)).map((l) => l.trim().slice(0, 80));
  for (const f of fails) report.record(f, "cloud-unit", "FAIL", null, "");
  const groups = lines.filter((l) => /^\s*ok\s+\S/.test(l)).map((l) => l.replace(/^\s*ok\s+/, "").trim().slice(0, 60));
  for (const g of groups) report.record(`unit: ${g}`, "cloud-unit", "PASS", null, "");
  // Definitive verdict from exit code — never flaps.
  report.record("cloud-unit suite (npm test)", "cloud-unit", r.ok ? "PASS" : "FAIL", r.secs,
    r.ok ? `${groups.length} groups green` : `exit ${r.code}: ${r.out.slice(-120)}`);
}
