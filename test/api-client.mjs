import assert from "node:assert/strict";
import { ApiError, apiErrorFrom, createApi } from "../web/api-client.mjs";

function fakeRes({ ok = true, status = 200, statusText = "", json } = {}) {
  return {
    ok,
    status,
    statusText,
    async json() {
      if (typeof json === "function") return json();
      if (json === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return json;
    },
  };
}

// --- happy paths -----------------------------------------------------------
const calls = [];
const api = createApi(async (path, init) => {
  calls.push({ path, init });
  if (path === "/api/none") return fakeRes({ status: 204 });
  return fakeRes({ json: { ok: true, path } });
});

assert.deepEqual(await api("/api/bots"), { ok: true, path: "/api/bots" });
assert.equal(await api("/api/none"), null, "204 resolves to null, not a JSON parse");

// JSON content type by default; a body object is stringified, absent body stays undefined.
assert.equal(calls[0].init.headers["Content-Type"], "application/json");
assert.equal(calls[0].init.body, undefined);

await api("/api/bots", { method: "POST", body: { name: "Ada" } });
const post = calls.at(-1).init;
assert.equal(post.method, "POST");
assert.equal(post.body, JSON.stringify({ name: "Ada" }));

// Caller opts win over the defaults (that is what the spread order buys).
await api("/api/raw", { headers: { "Content-Type": "text/plain" } });
assert.equal(calls.at(-1).init.headers["Content-Type"], "text/plain");

// --- error shape -----------------------------------------------------------
const full = await apiErrorFrom(
  fakeRes({
    ok: false,
    status: 402,
    statusText: "Payment Required",
    json: {
      error: "Add a desk to your plan",
      code: "NEED_BILLING",
      billingUrl: "https://billing.example/x",
      sku: "vm.4g",
      used: 4,
      entitled: 4,
      unitAmountCents: 3900,
    },
  }),
);
assert.ok(full instanceof ApiError);
assert.ok(full instanceof Error, "callers catch it as an Error");
assert.equal(full.message, "Add a desk to your plan");
assert.equal(full.code, "NEED_BILLING");
assert.equal(full.status, 402);
assert.equal(full.billingUrl, "https://billing.example/x");
assert.equal(full.sku, "vm.4g");
assert.equal(full.used, 4);
assert.equal(full.entitled, 4);
assert.equal(full.unitAmountCents, 3900);

// A zero count is a real answer ("0 of 4 in use"), not an absent field.
const zeros = await apiErrorFrom(
  fakeRes({ ok: false, status: 402, json: { used: 0, entitled: 0, unitAmountCents: 0, sku: "" } }),
);
assert.equal(zeros.used, 0);
assert.equal(zeros.entitled, 0);
assert.equal(zeros.unitAmountCents, 0);
assert.ok(!("sku" in zeros), "an empty sku is not attached");

// Absent optional fields must not appear at all, so `in` stays meaningful.
const bare = await apiErrorFrom(fakeRes({ ok: false, status: 500, statusText: "Server Error", json: {} }));
assert.equal(bare.message, "Server Error");
assert.equal(bare.code, "", "code is always present, empty when unsent");
assert.equal(bare.status, 500);
for (const k of ["billingUrl", "sku", "used", "entitled", "unitAmountCents"]) {
  assert.ok(!(k in bare), `${k} must be absent, not undefined`);
}

// An HTML error page or an empty body leaves the status line as the message.
const nonJson = await apiErrorFrom(fakeRes({ ok: false, status: 502, statusText: "Bad Gateway" }));
assert.equal(nonJson.message, "Bad Gateway");
assert.equal(nonJson.code, "");
assert.equal(nonJson.status, 502);

// --- the transport throws it ----------------------------------------------
const failing = createApi(async () =>
  fakeRes({ ok: false, status: 409, statusText: "Conflict", json: { error: "no desk", code: "NEED_DESK" } }),
);
await assert.rejects(
  () => failing("/api/cloud/chat"),
  (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "NEED_DESK");
    assert.equal(err.status, 409);
    assert.equal(err.message, "no desk");
    return true;
  },
);

console.log("ok api-client");
