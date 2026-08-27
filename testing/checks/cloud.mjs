/**
 * Cloud lane — live prod checks against the deployed Worker + Stripe.
 *
 *  - prod health
 *  - auth gating: admin / billing / compute routes reject unauthenticated calls (401/403)
 *  - stripe webhook rejects an unsigned / bad-signature body (400)
 *  - mobile desk-action proxy route requires auth (401)
 *  - payment catalog: every SKU has an active Price in Stripe (test mode)
 *
 * Live prod calls: PASS/FAIL. Stripe catalog: SKIP if no key configured.
 */
import { http, PROD, getSecret, stripe } from "../lib/util.mjs";
import { SKUS } from "../../../sub8-cloud/src/billing/catalog.mjs";

export async function run(report) {
  // health
  const health = await http(PROD, "/api/health");
  report.check(health.status === 200, "prod worker health", "cloud", health.secs, `HTTP ${health.status}`);

  // auth gating — billing admin routes
  for (const ep of ["/api/billing/admin-free", "/api/billing/grant-credit", "/api/billing/promo"]) {
    const r = await http(PROD, ep, { method: "POST", body: '{"amountCents":1}' });
    report.check([401, 403].includes(r.status), `unauth ${ep} rejected`, "cloud", r.secs, `HTTP ${r.status}`);
  }

  // auth gating — admin overview
  const admin = await http(PROD, "/api/admin/overview");
  report.check([401, 403].includes(admin.status), "unauth admin overview rejected", "cloud", admin.secs, `HTTP ${admin.status}`);

  // auth gating — compute create
  const create = await http(PROD, "/api/computers", { method: "POST", body: '{"sku":"vm.4g"}' });
  report.check(create.status === 401, "unauth desk create rejected", "cloud", create.secs, `HTTP ${create.status}`);

  // auth gating — mobile desk-action proxy
  const deskAction = await http(PROD, "/api/brain/desk-action", { method: "POST", body: '{"action":"screenshot"}' });
  report.check([401, 403].includes(deskAction.status), "unauth desk-action proxy rejected", "cloud", deskAction.secs, `HTTP ${deskAction.status}`);

  // stripe webhook signature verification
  const hookUnsigned = await http(PROD, "/api/stripe/webhook", { method: "POST", body: '{"type":"ping"}' });
  report.check(hookUnsigned.status === 400, "stripe webhook rejects unsigned", "cloud", hookUnsigned.secs, `HTTP ${hookUnsigned.status}`);
  const hookBad = await http(PROD, "/api/stripe/webhook", {
    method: "POST",
    body: '{"type":"ping"}',
    headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
  });
  report.check(hookBad.status === 400, "stripe webhook rejects bad signature", "cloud", hookBad.secs, `HTTP ${hookBad.status}`);

  // payment catalog — every SKU has an active Price in Stripe (test mode)
  const key = getSecret("STRIPE_SECRET_KEY");
  if (!key) {
    report.record("stripe catalog check", "cloud", "SKIP", null, "STRIPE_SECRET_KEY not configured");
    return;
  }
  const mode = key.startsWith("sk_live") ? "live" : "test";
  for (const sku of SKUS) {
    const r = await stripe(key, "GET", "/v1/prices", { "lookup_keys[0]": sku.id, active: "true", limit: 1 });
    if (r.status !== 200) {
      report.record(`stripe price ${sku.id}`, "cloud", "FAIL", null, r.error || `HTTP ${r.status}`);
      continue;
    }
    const price = (r.json?.data || [])[0];
    const ok = Boolean(price?.id && price.active && Number(price.unit_amount) === sku.unitAmountCents);
    report.check(
      ok,
      `stripe price ${sku.id} (${mode})`,
      "cloud",
      null,
      price ? `${price.id} ${price.unit_amount}¢` : "no active price",
    );
  }
}
