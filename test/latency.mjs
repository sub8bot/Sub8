import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../testing/checks/latency.mjs";

const orig = process.env.SUB8_DASH_TURNLOG;
const origCap = process.env.SUB8_LAT_P95_CAP_MS;
const origErr = process.env.SUB8_LAT_ERR_MAX;
const origWindow = process.env.SUB8_LAT_WINDOW;

function reporter() {
  const rows = [];
  return {
    rows,
    record(tid, lane, status, secs, reply) {
      rows.push({ tid, lane, status, secs, reply });
    },
  };
}

function turnLine(ms, outcome = "done") {
  return JSON.stringify({ turnlog: { ms, outcome, llmCalls: 1 } });
}

try {
  const missing = path.join(os.tmpdir(), `sub8-lat-missing-${process.pid}.jsonl`);
  process.env.SUB8_DASH_TURNLOG = missing;
  const skipRep = reporter();
  const skipOut = await run(skipRep);
  assert.equal(skipOut, null);
  assert.ok(skipRep.rows.length >= 1);
  assert.ok(skipRep.rows.every((r) => r.status === "SKIP"));
  assert.equal(skipRep.rows.some((r) => r.status === "FAIL"), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-lat-"));
  const okLog = path.join(dir, "ok.jsonl");
  fs.writeFileSync(
    okLog,
    Array.from({ length: 20 }, (_, i) => turnLine(800 + i * 10)).join("\n") + "\n",
  );
  process.env.SUB8_DASH_TURNLOG = okLog;
  process.env.SUB8_LAT_P95_CAP_MS = "120000";
  process.env.SUB8_LAT_ERR_MAX = "0.25";
  const passRep = reporter();
  const passOut = await run(passRep);
  assert.ok(passOut);
  assert.ok(passOut.p95 < 120000);
  const p95Pass = passRep.rows.find((r) => r.tid.includes("p95"));
  assert.equal(p95Pass.status, "PASS");
  assert.equal(passRep.rows.some((r) => r.status === "FAIL"), false);

  const badLog = path.join(dir, "bad.jsonl");
  fs.writeFileSync(
    badLog,
    Array.from({ length: 20 }, () => turnLine(200_000)).join("\n") + "\n",
  );
  process.env.SUB8_DASH_TURNLOG = badLog;
  process.env.SUB8_LAT_P95_CAP_MS = "5000";
  const failRep = reporter();
  const failOut = await run(failRep);
  assert.ok(failOut.p95 > 5000);
  const p95Fail = failRep.rows.find((r) => r.tid.includes("p95"));
  assert.equal(p95Fail.status, "FAIL", JSON.stringify(failRep.rows));

  console.log("ok latency");
} finally {
  if (orig === undefined) delete process.env.SUB8_DASH_TURNLOG;
  else process.env.SUB8_DASH_TURNLOG = orig;
  if (origCap === undefined) delete process.env.SUB8_LAT_P95_CAP_MS;
  else process.env.SUB8_LAT_P95_CAP_MS = origCap;
  if (origErr === undefined) delete process.env.SUB8_LAT_ERR_MAX;
  else process.env.SUB8_LAT_ERR_MAX = origErr;
  if (origWindow === undefined) delete process.env.SUB8_LAT_WINDOW;
  else process.env.SUB8_LAT_WINDOW = origWindow;
}
