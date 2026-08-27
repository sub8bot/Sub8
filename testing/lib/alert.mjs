/**
 * Alerting for the Sub8 testing suite.
 *
 * The suite is a plain Node script — there's no PushNotification tool in this
 * context — so we implement a PushNotification-style alert two ways, and fire it
 * ONLY when a run has at least one REAL failure (status FAIL). Green runs and
 * runs with only FLAG (needs-approval) / SKIP (unavailable) rows stay silent, so
 * an unattended 10-minute cron never pages on non-failures.
 *
 *   1. Always: append one JSON line to data/test-alerts.jsonl (durable trail the
 *      dashboard / an operator can tail).
 *   2. If env SUB8_ALERT_CMD is set: exec it with a one-line human summary as the
 *      final argv arg (and the full alert JSON on stdin + as SUB8_ALERT_JSON).
 *      This is the wire-to-anything hook — Pushover, ntfy, Slack webhook curl,
 *      `terminal-notifier`, an SMS gateway, etc. Failure to fire is logged, never
 *      fatal (alerting must not break the run's exit code).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, now } from "./util.mjs";

/** One-line human summary of the failing run. */
function summarize(counts, fails) {
  const head = `Sub8 suite: ${fails.length} FAIL (${counts.passed} pass, ${counts.flagged} flag, ${counts.skipped} skip)`;
  const items = fails
    .slice(0, 6)
    .map((f) => `[${f.lane}] ${f.tid}${f.reply ? " — " + f.reply : ""}`)
    .join("; ");
  const more = fails.length > 6 ? ` (+${fails.length - 6} more)` : "";
  return `${head}: ${items}${more}`;
}

/** Exec SUB8_ALERT_CMD with the summary. Never throws; resolves when done. */
function execAlertCmd(cmd, summary, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      // sh -c so operators can wire a pipeline; the summary is $1.
      child = spawn("sh", ["-c", `${cmd} "$1"`, "sh", summary], {
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...process.env, SUB8_ALERT_JSON: JSON.stringify(payload) },
        timeout: 20_000,
      });
    } catch (e) {
      console.error(`alert cmd failed to start: ${String(e?.message || e).slice(0, 160)}`);
      return resolve(false);
    }
    try { child.stdin.end(JSON.stringify(payload) + "\n"); } catch {}
    child.on("error", (e) => {
      console.error(`alert cmd error: ${String(e?.message || e).slice(0, 160)}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0) console.error(`alert cmd exited ${code}`);
      resolve(code === 0);
    });
  });
}

/**
 * Fire an alert for a failing run. Call ONLY when there is >=1 real FAIL.
 * @param {{counts:object, fails:Array, batteryPath?:string}} arg
 */
export async function maybeAlert({ counts, fails, batteryPath } = {}) {
  if (!fails || !fails.length) return null; // guard: never alert without a real FAIL
  const summary = summarize(counts, fails);
  const payload = {
    at: now(),
    kind: "test-suite-fail",
    failed: fails.length,
    counts,
    battery: batteryPath || "",
    summary,
    fails: fails.map((f) => ({ tid: f.tid, lane: f.lane, reply: f.reply })),
  };

  // 1) durable trail
  const alertPath = path.join(DATA_DIR, "test-alerts.jsonl");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(alertPath, JSON.stringify(payload) + "\n");
    console.log(`🔔 ALERT ${summary}`);
    console.log(`→ ${alertPath}`);
  } catch (e) {
    console.error(`alert log failed: ${String(e?.message || e).slice(0, 160)}`);
  }

  // 2) operator hook
  const cmd = process.env.SUB8_ALERT_CMD;
  if (cmd) await execAlertCmd(cmd, summary, payload);

  return payload;
}
