import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempData } from "../testing/e2e/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = await fs.readFile(path.join(root, "server/index.mjs"), "utf8");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const a = uid(1);
const b = uid(2);
const c = uid(3);
const six = [uid(1), uid(2), uid(3), uid(4), uid(5), uid(6)];

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

await test("index.mjs registers channel HTTP routes", () => {
  assert.match(indexSrc, /from "@sub8\/store\/channels"/);
  assert.match(indexSrc, /app\.get\("\/api\/channels"/);
  assert.match(indexSrc, /app\.post\("\/api\/channels"/);
  assert.match(indexSrc, /app\.get\("\/api\/channels\/:id"/);
  assert.match(indexSrc, /app\.post\("\/api\/channels\/:id\/members"/);
});

await test("channel store still refuses empty and max 6", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-channel-routes-"));
  const prev = process.env.SUB8BOT_DATA;
  process.env.SUB8BOT_DATA = tmp;
  try {
    const channels = await import(`${import.meta.resolve("@sub8/store/channels")}?routes=${Date.now()}`);
    await assert.rejects(() => channels.createChannel({ name: "Empty", memberIds: [] }), /empty/i);
    await assert.rejects(
      () => channels.createChannel({ name: "TooMany", memberIds: [...six, uid(7)] }),
      /max 6/i,
    );
  } finally {
    if (prev == null) delete process.env.SUB8BOT_DATA;
    else process.env.SUB8BOT_DATA = prev;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test("channel HTTP routes list/create/get and 4xx empty/max 6", async () => {
  await withTempData(async ({ client }) => {
    const empty = await json(await client.get("/api/channels"));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);

    const created = await json(
      await client.post("/api/channels", { name: "Ops", memberIds: [a, b], description: "Room." }),
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.name, "Ops");
    assert.deepEqual(created.body.memberIds, [a, b]);
    assert.equal(created.body.group.version, 1);
    assert.ok(created.body.id);

    const listed = await json(await client.get("/api/channels"));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].id, created.body.id);

    const got = await json(await client.get(`/api/channels/${created.body.id}`));
    assert.equal(got.status, 200);
    assert.equal(got.body.id, created.body.id);
    assert.deepEqual(got.body.memberIds, [a, b]);

    const missing = await json(await client.get(`/api/channels/${uid(99)}`));
    assert.equal(missing.status, 404);

    const noName = await json(await client.post("/api/channels", { memberIds: [a] }));
    assert.equal(noName.status, 400);
    assert.match(String(noName.body.error), /name required/i);

    const noMembers = await json(await client.post("/api/channels", { name: "Empty", memberIds: [] }));
    assert.equal(noMembers.status, 400);
    assert.match(String(noMembers.body.error), /empty/i);

    const tooMany = await json(await client.post("/api/channels", { name: "TooMany", memberIds: [...six, uid(7)] }));
    assert.equal(tooMany.status, 400);
    assert.match(String(tooMany.body.error), /max 6/i);

    const added = await json(await client.post(`/api/channels/${created.body.id}/members`, { add: [c] }));
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.memberIds, [a, b, c]);

    const removed = await json(await client.post(`/api/channels/${created.body.id}/members`, { remove: [b] }));
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.memberIds, [a, c]);

    const solo = await json(await client.post("/api/channels", { name: "Solo", memberIds: [a] }));
    assert.equal(solo.status, 200);
    const last = await json(await client.post(`/api/channels/${solo.body.id}/members`, { remove: [a] }));
    assert.equal(last.status, 400);
    assert.match(String(last.body.error), /cannot remove last member|empty/i);

    const full = await json(await client.post("/api/channels", { name: "Full", memberIds: six }));
    assert.equal(full.status, 200);
    const seventh = await json(await client.post(`/api/channels/${full.body.id}/members`, { add: [uid(7)] }));
    assert.equal(seventh.status, 400);
    assert.match(String(seventh.body.error), /max 6/i);

    const membersMissing = await json(await client.post(`/api/channels/${uid(99)}/members`, { add: [a] }));
    assert.equal(membersMissing.status, 404);
  });
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  for (const f of failed) console.error(f.err);
  process.exit(1);
}
console.log("ok channel-routes");
