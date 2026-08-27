import assert from "node:assert/strict";
import { withTempData } from "../harness.mjs";

/** Smoke: empty temp data dir, GET /api/health → 200. */
export async function run() {
  await withTempData(async ({ client }) => {
    const res = await client.get("/api/health");
    assert.equal(res.status, 200);
  });
}
