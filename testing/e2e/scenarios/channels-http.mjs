import assert from "node:assert/strict";
import { withTempData } from "../harness.mjs";

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** POST /api/channels then GET list. No Docker. */
export async function run({ client } = {}) {
  const exercise = async (c) => {
    const empty = await json(await c.get("/api/channels"));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);

    const a = uid(1);
    const b = uid(2);
    const created = await json(
      await c.post("/api/channels", { name: "E2E", memberIds: [a, b], description: "e2e room" }),
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.name, "E2E");
    assert.deepEqual(created.body.memberIds, [a, b]);
    assert.ok(created.body.id);

    const listed = await json(await c.get("/api/channels"));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].id, created.body.id);
    assert.equal(listed.body[0].name, "E2E");
  };

  if (client) return exercise(client);
  await withTempData(async ({ client: c }) => exercise(c));
}
