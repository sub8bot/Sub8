/**
 * Latency lane — turn-duration + error-rate SLOs from the cloud turn telemetry.
 *
 * The brain (sub8-cloud/src/brain.mjs logTurn) emits one greppable JSON line per
 * turn: {"turnlog":{ ms, llmCalls, promptTokens, completionTokens, tools,
 * outcome, reply, botId, computerId, ... }}. This lane reads those lines from
 * whatever turnlog sources are available and computes, over the recent window:
 *
 *   - p50 turn duration (informational — always PASS, metric in the detail)
 *   - p95 turn duration (FAIL only if it blows past a sane cap)
 *   - error-rate         (FAIL only if it exceeds a threshold)
 *
 * Sources (first match wins for the "default"; env is always honoured):
 *   - env SUB8_DASH_TURNLOG — comma-separated list of files (same var the
 *     dashboard + analyze-turns use). Every existing file is read.
 *   - otherwise a sensible default: data/turnlog.jsonl under the bot repo, if it
 *     exists.
 * If no turnlog source exists (nothing to measure), every check records SKIP —
 * never FAIL — so an unattended run stays green when telemetry isn't wired up.
 * When a turnlog IS present, p95 over cap (or error-rate over threshold) is FAIL
 * and `testing/suite.mjs` exits non-zero. That is the regression gate.
 *
 * Tunables (env, all optional):
 *   SUB8_LAT_WINDOW      recent turns to consider          (default 200)
 *   SUB8_LAT_P95_CAP_MS  p95 duration cap in ms            (default 120000)
 *   SUB8_LAT_ERR_MAX     max error-rate before FAIL (0..1) (default 0.25)
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../lib/util.mjs";

// outcomes that mean the turn did not complete cleanly. The happy paths are
// "done" and "executor"; a wedged/aborted turn (see T5 per-turn timeout) marks
// "error". Anything error-ish here counts against the error-rate.
const ERROR_OUTCOMES = new Set(["error", "failed", "fail", "timeout", "aborted", "crash"]);

const WINDOW = Math.max(1, parseInt(process.env.SUB8_LAT_WINDOW || "200", 10) || 200);
const P95_CAP_MS = Math.max(1, parseInt(process.env.SUB8_LAT_P95_CAP_MS || "120000", 10) || 120000);
const ERR_MAX = (() => {
  const v = parseFloat(process.env.SUB8_LAT_ERR_MAX || "0.25");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.25;
})();

/** Turnlog files to read: env list (existing files), else the default if present. */
function turnlogSources() {
  const fromEnv = (process.env.SUB8_DASH_TURNLOG || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = fromEnv.length ? fromEnv : [path.join(DATA_DIR, "turnlog.jsonl")];
  return candidates.filter((f) => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
}

/** Parse the {"turnlog":...} lines out of a file (same marker the dashboard uses). */
function readTurns(file) {
  const turns = [];
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return turns; }
  // cap the tail we scan so a huge wrangler log doesn't blow memory
  for (const line of lines.slice(-5000)) {
    const i = line.indexOf('{"turnlog"');
    if (i < 0) continue;
    try {
      const t = JSON.parse(line.slice(i)).turnlog;
      if (t && typeof t === "object") turns.push(t);
    } catch { /* partial line */ }
  }
  return turns;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export async function run(report) {
  const sources = turnlogSources();
  if (!sources.length) {
    report.record("latency: turnlog source available", "latency", "SKIP", null, "no turnlog file (set SUB8_DASH_TURNLOG or add data/turnlog.jsonl)");
    return null;
  }

  let all = [];
  for (const f of sources) all = all.concat(readTurns(f));
  if (!all.length) {
    report.record("latency: turnlog has turns", "latency", "SKIP", null, `${sources.length} source(s), 0 turnlog lines`);
    return null;
  }

  const window = all.slice(-WINDOW);
  const n = window.length;
  const durations = window.map((t) => Number(t.ms) || 0).filter((ms) => ms > 0).sort((a, b) => a - b);
  const errors = window.filter((t) => ERROR_OUTCOMES.has(String(t.outcome || "").toLowerCase())).length;
  const errRate = n ? errors / n : 0;

  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);

  // p50 — informational, always PASS.
  report.record(
    "latency: p50 turn duration",
    "latency",
    "PASS",
    Math.round(p50 / 1000),
    `p50 ${fmtMs(p50)} over ${durations.length} turns (window ${n})`,
  );

  // p95 — FAIL only if it blows past the cap.
  report.record(
    "latency: p95 turn duration within cap",
    "latency",
    p95 <= P95_CAP_MS ? "PASS" : "FAIL",
    Math.round(p95 / 1000),
    `p95 ${fmtMs(p95)} (cap ${fmtMs(P95_CAP_MS)})`,
  );

  // error-rate — FAIL only if it exceeds the threshold.
  report.record(
    "latency: turn error-rate within threshold",
    "latency",
    errRate <= ERR_MAX ? "PASS" : "FAIL",
    null,
    `${(errRate * 100).toFixed(1)}% (${errors}/${n}, max ${(ERR_MAX * 100).toFixed(0)}%)`,
  );

  return { n, p50, p95, errRate, errors, sources: sources.length };
}
