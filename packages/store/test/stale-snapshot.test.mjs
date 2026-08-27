/**
 * upsertBot's stale-snapshot guard preserves a set of fields from the row on
 * disk when that row is NEWER than the object being written. That protects a
 * long turn from wiping an edit made while it ran — but it cuts both ways, and
 * `vm` was added to the list without the other side being thought through.
 *
 * A route that reads a bot, does a Docker call for a few seconds, then writes
 * the whole row back is on the losing side of it: any concurrent write (a
 * running turn upserts on every emitted message) makes the row newer, and the
 * freshly computed vm status — the entire point of the call — is the thing
 * silently dropped. A paused container keeps reading "running", and
 * ensureDesktops then sees "running" and never corrects it.
 *
 * The rule these pin: computed state goes back through patchBot, which re-reads
 * inside the lock. upsertBot is for a whole row you already own.
 * server/index.mts's pause/resume/reboot/stop branches use patchVm for exactly
 * this reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-stale-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("../dist/index.js");
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("patchBot lands computed vm state even when the row moved underneath", async () => {
  const id = uid(1);
  await store.upsertBot({ id, name: "Desk", messages: [], vm: { status: "running", container: "c1" } });

  // What a route holds: read at entry, before a Docker call.
  const snapshot = await store.getBot(id);
  // Something else lands while that call is in flight.
  await store.patchBot(id, (b) => {
    b.name = "Renamed mid-call";
  });

  // The route now writes what it computed, through patchBot.
  await store.patchBot(id, (b) => {
    b.vm = { ...(b.vm || {}), status: "paused" };
  });

  const after = await store.getBot(id);
  assert.equal(after.vm.status, "paused", "the computed status was dropped");
  assert.equal(after.vm.container, "c1", "the rest of vm was clobbered");
  assert.equal(after.name, "Renamed mid-call", "the concurrent edit was lost");
  assert.ok(snapshot, "sanity");
});

// The failure mode this exists to prevent, stated as a test rather than left
// as folklore: the same route written with upsertBot loses.
test("KNOWN: upsertBot with a stale snapshot silently drops the vm change", async () => {
  const id = uid(2);
  await store.upsertBot({ id, name: "Desk2", messages: [], vm: { status: "running", container: "c2" } });
  const snapshot = await store.getBot(id);
  await store.patchBot(id, (b) => {
    b.name = "Renamed mid-call";
  });

  snapshot.vm = { ...snapshot.vm, status: "paused" };
  await store.upsertBot(snapshot);

  const after = await store.getBot(id);
  assert.equal(
    after.vm.status,
    "running",
    "if this now reads 'paused' the guard changed — re-check every read-then-upsert route",
  );
});

// And the direction the guard was added for still works: a genuinely stale
// turn must not resurrect vm state that was changed while it ran.
test("a stale turn cannot revert vm state changed while it ran", async () => {
  const id = uid(3);
  await store.upsertBot({ id, name: "Desk3", messages: [], vm: { status: "running", container: "c3" } });
  const turnSnapshot = await store.getBot(id);

  await store.patchBot(id, (b) => {
    b.vm = { ...(b.vm || {}), status: "paused" };
  });

  // The long turn finishes and writes its whole (stale) row back.
  await store.upsertBot(turnSnapshot);

  assert.equal((await store.getBot(id)).vm.status, "paused", "a stale turn resurrected 'running'");
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
