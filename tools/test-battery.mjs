#!/usr/bin/env node
/**
 * Compatibility shim — the ad-hoc battery has moved to testing/suite.mjs.
 *
 * The suite writes the same data/test-battery.json (rolling history) that
 * tools/test-dashboard.mjs reads, plus a heal log and safe self-heal actions.
 * This shim keeps `node tools/test-battery.mjs` (and anything that calls it,
 * e.g. the dashboard's cron) working by delegating to the new runner.
 *
 * Run the suite directly for the full CLI:  node testing/suite.mjs --help-ish
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suite = path.resolve(HERE, "..", "testing", "suite.mjs");

const child = spawn(process.execPath, [suite, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
