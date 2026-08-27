#!/usr/bin/env node
/**
 * Sub8 testing suite — one repeatable, idempotent run that:
 *   1. runs every check lane (cloud-unit, cloud, local, docker, prompts, fleet)
 *   2. runs SAFE self-heal actions when a check finds a fixable issue
 *   3. flags risky issues for human approval (never executes them)
 *   4. writes results to data/test-battery.json (the dashboard reads this) and a
 *      heal log to data/test-heal-log.jsonl
 *   5. prints a summary and exits non-zero ONLY on real failures (FAIL), never on
 *      flagged-needs-approval (FLAG) or skipped-unavailable (SKIP) rows.
 *
 * Safe to run unattended every ~10 minutes.
 *
 *   node testing/suite.mjs
 *   node testing/suite.mjs --no-cloud-unit    # skip the slow npm-test lane
 *   node testing/suite.mjs --no-heal          # detect only, never mutate
 */
import { Reporter } from "./lib/report.mjs";
import * as cloudUnit from "./checks/cloud-unit.mjs";
import * as cloud from "./checks/cloud.mjs";
import * as local from "./checks/local.mjs";
import * as docker from "./checks/docker.mjs";
import * as orchestration from "./checks/orchestration.mjs";
import * as prompts from "./checks/prompts.mjs";
import * as fleet from "./checks/fleet.mjs";
import * as exercise from "./checks/exercise.mjs";
import * as latency from "./checks/latency.mjs";
import * as healers from "./heal/healers.mjs";
import { maybeAlert } from "./lib/alert.mjs";

const args = new Set(process.argv.slice(2));
const noHeal = args.has("--no-heal");
const skipCloudUnit = args.has("--no-cloud-unit");

async function safe(name, fn, report) {
  try {
    return await fn();
  } catch (e) {
    report.record(`${name} lane crashed`, name, "FAIL", null, String(e?.message || e).slice(0, 160));
    return null;
  }
}

async function main() {
  const report = new Reporter();
  console.log(`Sub8 testing suite @ ${new Date().toISOString()}${noHeal ? " (heal disabled)" : ""}`);

  if (!skipCloudUnit) await safe("cloud-unit", () => cloudUnit.run(report), report);
  await safe("cloud", () => cloud.run(report), report);
  await safe("docker", () => docker.run(report), report);
  await safe("prompts", () => prompts.run(report), report);
  const localOut = await safe("local", () => local.run(report), report);
  await safe("orchestration", () => orchestration.run(report), report);
  await safe("exercise", () => exercise.run(report), report);
  await safe("latency", () => latency.run(report), report);
  const fleetOut = await safe("fleet", () => fleet.run(report), report);

  // ---- heal / flag ----
  if (fleetOut) {
    if (!noHeal && fleetOut.staleWarm?.length) await healers.healStaleWarm(report, fleetOut.staleWarm);
    if (fleetOut.orphans?.length) healers.flagOrphans(report, fleetOut.orphans);
  }
  if (localOut?.runningDrift?.length) healers.flagLocalDrift(report, localOut.runningDrift);

  // ---- persist + summarize ----
  const out = report.write();
  const c = report.counts();
  console.log(
    `\nSuite done: ${c.passed} passed, ${c.failed} failed, ${c.flagged} flagged, ${c.skipped} skipped ` +
      `(${c.total} checks). Heal: ${c.healed} applied, ${c.healFlagged} flagged for approval.`,
  );
  console.log(`→ ${out}`);

  // ---- alert on REAL failures only (never on green / FLAG / SKIP) ----
  if (c.failed > 0) {
    const fails = report.results.filter((r) => r.status === "FAIL");
    await maybeAlert({ counts: c, fails, batteryPath: out });
  }

  process.exit(c.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("suite fatal:", e?.stack || e);
  process.exit(1);
});
