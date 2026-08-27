/**
 * Result recording for the Sub8 testing suite.
 *
 * Writes the same battery JSON the dashboard already reads:
 *   { results: [{status, tid, lane, at, secs, reply}], pending: {}, updatedAt }
 * with a rolling history capped at MAX_HISTORY. Also keeps a structured run log
 * and appends every heal action to data/test-heal-log.jsonl.
 *
 * Statuses:
 *   PASS  — check passed
 *   FAIL  — a real failure (drives non-zero exit)
 *   FLAG  — needs human approval (e.g. orphan droplet); NOT a failure
 *   SKIP  — could not run (missing token / app down); NOT a failure
 */
import fs from "node:fs";
import path from "node:path";
import { now, DATA_DIR } from "./util.mjs";

const MAX_HISTORY = 300;
const ICON = { PASS: "✓", FAIL: "✗", FLAG: "⚠", SKIP: "–" };

export class Reporter {
  constructor() {
    this.results = [];
    this.heals = [];
    this.runLog = [];
  }

  record(tid, lane, status, secs = null, reply = "") {
    const row = { tid, lane, status, at: now(), secs, reply: String(reply || "").slice(0, 200) };
    this.results.push(row);
    const icon = ICON[status] || "…";
    console.log(`${icon} [${lane}] ${tid}${reply ? " — " + String(reply).slice(0, 90) : ""}`);
    return row;
  }

  // Convenience: record PASS if cond else FAIL.
  check(cond, tid, lane, secs = null, reply = "") {
    return this.record(tid, lane, cond ? "PASS" : "FAIL", secs, reply);
  }

  /** Log a heal action. entry: {action, target, done|flagged, detail}. */
  heal(entry) {
    const row = { at: now(), ...entry };
    this.heals.push(row);
    const state = row.done ? "HEALED" : row.flagged ? "FLAGGED" : "noop";
    console.log(`⚙ [heal] ${state} ${row.action} ${row.target || ""} — ${row.detail || ""}`.trim());
    return row;
  }

  counts() {
    const by = (s) => this.results.filter((r) => r.status === s).length;
    return {
      total: this.results.length,
      passed: by("PASS"),
      failed: by("FAIL"),
      flagged: by("FLAG"),
      skipped: by("SKIP"),
      healed: this.heals.filter((h) => h.done).length,
      healFlagged: this.heals.filter((h) => h.flagged).length,
    };
  }

  /** Merge this run into the rolling battery history + append the heal log. */
  write(outPath = process.env.SUB8_DASH_BATTERY || path.join(DATA_DIR, "test-battery.json")) {
    let prior = { results: [] };
    try { prior = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch {}
    const merged = [...(prior.results || []), ...this.results].slice(-MAX_HISTORY);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ results: merged, pending: {}, updatedAt: Date.now() }, null, 2));

    if (this.heals.length) {
      const healPath = path.join(path.dirname(outPath), "test-heal-log.jsonl");
      const lines = this.heals.map((h) => JSON.stringify(h)).join("\n") + "\n";
      fs.appendFileSync(healPath, lines);
    }
    return outPath;
  }
}
