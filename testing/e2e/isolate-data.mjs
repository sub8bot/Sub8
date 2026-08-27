/**
 * Point the whole e2e run at a throwaway data dir, BEFORE anything else loads.
 *
 * Why this file exists at all: ESM hoists `import` statements, so top-level code
 * in run.mjs cannot set an env var before its own imports evaluate. A module
 * imported first can. `@sub8/store` binds `dataDir` once at load, so the var has
 * to be set before any scenario — or the harness — pulls the store in.
 *
 * Why it matters: ten of the scenarios under scenarios/ set neither
 * SUB8BOT_DATA nor use withTempData. Run directly, they wrote into the real
 * data/ — subagent.mjs left `parent-e2e` rows in the live tasks.json and a
 * matching queue in wakes.json. data/bots.json holds real bots (AikaBotto, Job
 * Hunter); a test suite must never be able to reach it.
 *
 * Escape hatch: SUB8_E2E_LIVE_DATA=1 keeps whatever SUB8BOT_DATA is already set
 * (or the real default) for the rare case where you genuinely mean to run
 * against live state. Nothing in the repo sets it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const liveData = process.env.SUB8_E2E_LIVE_DATA === "1";

/** The dir this run is pinned to, or "" when explicitly running against live data. */
export let dataDir = "";

if (!liveData) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-e2e-run-"));
  // Both spellings: paths.mjs and @sub8/store accept either, and a scenario that
  // spawns a child inherits them.
  process.env.SUB8BOT_DATA = dataDir;
  process.env.OCTOBOT_DATA = dataDir;
} else {
  console.warn("!! SUB8_E2E_LIVE_DATA=1 — scenarios will write to the REAL data dir");
}
