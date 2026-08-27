/**
 * Self-heal actions for the Sub8 testing suite.
 *
 * SAFE + idempotent only. The single action we actually EXECUTE is marking a
 * stale IP-less warm desk 'destroying' in D1 — the worker's cron (retryDestroys)
 * then does the actual DigitalOcean destroy on its own schedule. We never call
 * DigitalOcean, never deploy, never touch live user desks.
 *
 * Everything risky (destroying droplets directly, deleting orphans, deploying,
 * rebuilding local containers) is FLAGGED for human approval, not executed.
 *
 * Each healer returns {action, target, done|flagged, detail}. `done:true` means
 * we made a change; `flagged:true` means a human needs to approve/act.
 */
import { wrangler } from "../lib/util.mjs";

/**
 * SAFE HEAL: mark stale IP-less warm/warming desks 'destroying' so the worker
 * cron reaps them (mirrors computers.reapStaleWarm). Idempotent: the WHERE clause
 * only matches rows still stuck, so re-running is a no-op.
 */
export async function healStaleWarm(report, staleWarm = []) {
  for (const s of staleWarm) {
    try {
      const rows = await wrangler(
        `UPDATE computers SET status='destroying' WHERE id='${sqlId(s.id)}' AND status IN ('warm','warming') AND (ipv4 IS NULL OR ipv4='') RETURNING id`,
        { mutate: true },
      );
      const changed = rows.length > 0;
      report.heal({
        action: "mark-stale-warm-destroying",
        target: s.id,
        done: changed,
        detail: changed ? "marked destroying (cron will reap)" : "already handled",
      });
    } catch (e) {
      report.heal({ action: "mark-stale-warm-destroying", target: s.id, done: false, detail: `error: ${String(e?.message || e).slice(0, 120)}` });
    }
  }
}

/** FLAG ONLY: orphan droplets (live on DO, no D1 row). Destroys are gated. */
export function flagOrphans(report, orphans = []) {
  for (const o of orphans) {
    report.heal({
      action: "orphan-droplet",
      target: String(o.id),
      flagged: true,
      detail: `${o.name} status=${o.status} ~$${Number(o.monthly || 0).toFixed(0)}/mo — verify then destroy on DigitalOcean`,
    });
  }
}

/** FLAG ONLY: local running-bot ↔ container drift. Rebuilding a desk is gated. */
export function flagLocalDrift(report, drift = []) {
  for (const d of drift) {
    report.heal({
      action: "local-container-drift",
      target: d.container,
      flagged: true,
      detail: `bot ${d.name} (${d.botId}) reports running but no live container — Recover/Reload the desk in the app`,
    });
  }
}

function sqlId(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, "");
}
