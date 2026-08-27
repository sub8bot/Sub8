/**
 * Fleet lane — reconcile DigitalOcean droplets against the D1 `computers` table.
 *
 * Detects (reports counts + ids + estimated monthly cost; NEVER destroys):
 *   (a) stale warm/warming desks with no ipv4 older than 15 min
 *       — they count toward the warm-pool target but are unclaimable, starving it.
 *       These are SAFE to heal (mark 'destroying'; the worker cron reaps them).
 *   (b) orphan droplets — live on DigitalOcean with NO matching D1 row.
 *       These cost money with nothing tracking them. FLAGGED for human approval.
 *   (c) "warm" desks that are unclaimable (warm but no ipv4, any age). FLAGGED.
 *
 * Needs DIGITALOCEAN_TOKEN (from sub8-cloud/.env) + wrangler access to D1.
 * If either is unavailable the checks record SKIP, not FAIL.
 *
 * Returns { staleWarm, orphans, unclaimable, dbRows } for the suite to heal/flag.
 */
import { wrangler, digitalOcean, getSecret } from "../lib/util.mjs";

const STALE_WARM_MS = 15 * 60 * 1000;

export async function run(report) {
  const out = { staleWarm: [], orphans: [], unclaimable: [], dbRows: null };

  // ---- D1 side ----
  let rows;
  try {
    rows = await wrangler(
      "SELECT id, external_id, ipv4, status, sku, created_at FROM computers WHERE status != 'dead'",
    );
    out.dbRows = rows;
  } catch (e) {
    report.record("fleet: read D1 computers", "fleet", "SKIP", null, String(e?.message || e).slice(0, 120));
    return out;
  }
  report.record("fleet: read D1 computers", "fleet", "PASS", null, `${rows.length} non-dead rows`);

  const cutoff = Date.now() - STALE_WARM_MS;
  for (const r of rows) {
    const ipless = !r.ipv4;
    const warming = r.status === "warm" || r.status === "warming";
    if (warming && ipless) {
      out.unclaimable.push(r.id);
      if (Number(r.created_at) < cutoff) out.staleWarm.push({ id: r.id, status: r.status, createdAt: Number(r.created_at) });
    }
  }
  // Stale IP-less warm desks are a real, auto-healable defect.
  report.check(
    out.staleWarm.length === 0,
    "fleet: no stale IP-less warm desks (>15m)",
    "fleet",
    null,
    out.staleWarm.length ? `${out.staleWarm.length}: ${out.staleWarm.map((s) => s.id).join(", ")}` : "clean",
  );
  // Unclaimable warm desks (any age) — informational flag if fresh ones exist.
  const freshUnclaimable = out.unclaimable.length - out.staleWarm.length;
  if (freshUnclaimable > 0) {
    report.record("fleet: warm desks still waiting for an IP", "fleet", "FLAG", null, `${freshUnclaimable} warming (<15m), watching`);
  } else {
    report.record("fleet: warm desks still waiting for an IP", "fleet", "PASS", null, "none");
  }

  // ---- DigitalOcean side ----
  const token = getSecret("DIGITALOCEAN_TOKEN");
  if (!token) {
    report.record("fleet: orphan droplet scan", "fleet", "SKIP", null, "DIGITALOCEAN_TOKEN not configured");
    return out;
  }
  const doRes = await digitalOcean(token, "/v2/droplets?tag_name=sub8&per_page=200");
  if (doRes.status !== 200) {
    report.record("fleet: orphan droplet scan", "fleet", "SKIP", null, doRes.error || `HTTP ${doRes.status}`);
    return out;
  }
  const droplets = doRes.json?.droplets || [];
  const knownExt = new Set(rows.map((r) => String(r.external_id || "")).filter(Boolean));
  for (const d of droplets) {
    if (!knownExt.has(String(d.id))) {
      out.orphans.push({
        id: d.id,
        name: d.name,
        status: d.status,
        monthly: Number(d.size?.price_monthly) || 0,
        created_at: d.created_at,
      });
    }
  }
  const orphanCost = out.orphans.reduce((s, o) => s + o.monthly, 0);
  // Orphans are FLAGGED (destroying a droplet is gated), never auto-destroyed.
  if (out.orphans.length) {
    report.record(
      "fleet: no orphan droplets",
      "fleet",
      "FLAG",
      null,
      `${out.orphans.length} orphan(s) ~$${orphanCost.toFixed(0)}/mo: ${out.orphans.map((o) => `${o.id}(${o.name})`).join(", ")}`,
    );
  } else {
    report.record("fleet: no orphan droplets", "fleet", "PASS", null, `${droplets.length} droplets all tracked`);
  }

  return out;
}
