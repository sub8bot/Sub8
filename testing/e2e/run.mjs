#!/usr/bin/env node
/**
 * E2E runner. Discovers testing/e2e/scenarios/*.mjs and calls each run().
 * HTTP scenarios start their own server against a temp SUB8BOT_DATA.
 * skip() / SkipError is not a failure.
 *
 * ./isolate-data.mjs MUST stay the first import: it pins SUB8BOT_DATA to a
 * throwaway dir before @sub8/store binds dataDir, so no scenario can reach the
 * real data/ (which holds live bots). Ten scenarios set no data dir of their
 * own and used to write straight into it.
 */
import { dataDir as e2eDataDir, liveData } from "./isolate-data.mjs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skip, SkipError } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(here, "scenarios");
const files = (await readdir(scenariosDir)).filter((f) => f.endsWith(".mjs")).sort();

if (!files.length) {
  console.error("no scenarios in", scenariosDir);
  process.exit(1);
}

console.log(liveData ? "data: LIVE (SUB8_E2E_LIVE_DATA=1)" : `data: ${e2eDataDir}`);

function isSkip(err) {
  return err instanceof SkipError || err?.name === "SkipError";
}

let failed = 0;
let passed = 0;
const skipped = [];
for (const file of files) {
  const name = file.replace(/\.mjs$/, "");
  try {
    const mod = await import(pathToFileURL(path.join(scenariosDir, file)).href);
    const fn = mod.run || mod.default;
    if (typeof fn !== "function") throw new Error("no run() export");
    await fn({ skip });
    passed += 1;
    console.log("ok", name);
  } catch (err) {
    if (isSkip(err)) {
      skipped.push({ name, why: err.message || "skipped" });
      console.log("SKIP", name, "-", err.message || "skipped");
      continue;
    }
    failed += 1;
    console.error("FAIL", name, "-", err.message || err);
  }
}

// A summary, because a SKIP scrolls past exactly like an ok and the exit code
// is 0 either way -- so a run with Docker down looked identical to a full one,
// and covered materially less (docker-desk is the only scenario that exercises
// a real container). Name what did NOT run, every time.
console.log(
  `\n${passed} ok, ${skipped.length} skipped, ${failed} failed  (of ${files.length} scenarios)`,
);
if (skipped.length) {
  console.log("NOT COVERED by this run:");
  for (const s of skipped) console.log(`  - ${s.name}: ${s.why}`);
  console.log("Set E2E_STRICT=1 to make a skipped scenario a failure (release gate).");
}

// Opt-in strictness: skips stay non-fatal by default, because docker-desk
// legitimately cannot run without Docker and that must not block a dev loop.
if (failed || (skipped.length && process.env.E2E_STRICT === "1")) process.exit(1);
process.exit(0);
