import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-channels-"));
process.env.SUB8BOT_DATA = tmp;

// channelsPath binds at import, so SUB8BOT_DATA has to be set first.
const channels = await import("../dist/channels.js");

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const a = uid(1);
const b = uid(2);
const c = uid(3);

test("createChannel seats UUID members and group.json version 1", async () => {
  const ch = await channels.createChannel({ name: "Ops", memberIds: [a, b], description: "Room for desk coordination." });
  assert.match(ch.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(ch.name, "Ops");
  assert.deepEqual(ch.memberIds, [a, b]);
  assert.equal(ch.group.version, 1);
  assert.deepEqual(ch.group.memberIds, [a, b]);
  assert.equal(channels.groupJson(ch).version, 1);

  const disk = JSON.parse(await fs.readFile(path.join(tmp, "channels.json"), "utf8"));
  assert.equal(disk.length, 1);
  assert.deepEqual(disk[0].memberIds, [a, b]);
  assert.equal(disk[0].memberIds.includes("Ops"), false);
});

test("isChannel is group.json present", () => {
  assert.equal(channels.isChannel({ groupJson: { version: 1, memberIds: [a] } }), true);
  assert.equal(channels.isChannel({}), false);
  assert.equal(channels.isChannel({ groupJson: undefined }), false);
  assert.equal(channels.isChannel(null), false);
  const ch = { group: { version: 1, memberIds: [a] } };
  assert.equal(channels.isChannel(ch), true);
  assert.equal(channels.isChannel({ memberIds: [a], chiefId: a }), false);
});

test("addMember and removeMember by UUID", async () => {
  const ch = await channels.createChannel({ name: "AddRemove", memberIds: [a, b] });
  const added = await channels.addMember(ch, c);
  assert.deepEqual(added.memberIds, [a, b, c]);
  assert.equal(added.group.version, 1);
  const removed = await channels.removeMember(added.id, b);
  assert.deepEqual(removed.memberIds, [a, c]);
  assert.equal(removed.memberIds.includes(b), false);
});

test("refuse emptying (cannot remove last member)", async () => {
  const ch = await channels.createChannel({ name: "Solo", memberIds: [a] });
  await assert.rejects(() => channels.removeMember(ch.id, a), /cannot remove last member|empty/i);
  const still = await channels.getChannel(ch.id);
  assert.deepEqual(still.memberIds, [a]);
});

test("max 6 members", async () => {
  const six = [uid(1), uid(2), uid(3), uid(4), uid(5), uid(6)];
  const ch = await channels.createChannel({ name: "Full", memberIds: six });
  assert.equal(ch.memberIds.length, 6);
  await assert.rejects(() => channels.addMember(ch.id, uid(7)), /max 6/i);
  const still = await channels.getChannel(ch.id);
  assert.equal(still.memberIds.length, 6);
  await assert.rejects(
    () => channels.createChannel({ name: "TooMany", memberIds: [...six, uid(7)] }),
    /max 6/i,
  );
});

test("membership is UUID not display name", async () => {
  await assert.rejects(() => channels.createChannel({ name: "Named", memberIds: ["Alice"] }), /UUID/i);
  const ch = await channels.createChannel({ name: "UUIDs", memberIds: [a] });
  await assert.rejects(() => channels.addMember(ch.id, "Bob"), /UUID/i);
  await assert.rejects(() => channels.removeMember(ch.id, "Alice"), /UUID/i);
  const still = await channels.getChannel(ch.id);
  assert.deepEqual(still.memberIds, [a]);
});

test("createChannel requires name and at least one member", async () => {
  await assert.rejects(() => channels.createChannel({ memberIds: [a] }), /name required/i);
  await assert.rejects(() => channels.createChannel({ name: "Empty", memberIds: [] }), /empty/i);
  await assert.rejects(() => channels.createChannel({ name: "None" }), /memberIds required|empty/i);
});

test("syncGroupJsonToDesk writes group.json + profile.json via writer", async () => {
  const ch = await channels.createChannel({ name: "Desk", memberIds: [a, b], description: "Room." });
  const files = new Map();
  const written = await channels.syncGroupJsonToDesk(ch, async (dest, text) => {
    files.set(dest, text);
  });
  const dir = `/config/agent-data/agents/${ch.id}`;
  assert.equal(written.dir, dir);
  const group = JSON.parse(files.get(`${dir}/group.json`));
  assert.equal(group.version, 1);
  assert.deepEqual(group.memberIds, [a, b]);
  const profile = JSON.parse(files.get(`${dir}/profile.json`));
  assert.equal(profile.name, "Desk");
  assert.equal(profile.description, "Room.");
  await assert.rejects(() => channels.syncGroupJsonToDesk(ch), /writer required/i);
});

test("agents have no deleteChannel; removeChannel is host-only", async () => {
  assert.equal("deleteChannel" in channels, false);
  assert.equal(typeof channels.deleteChannel, "undefined");
  assert.equal(typeof channels.removeChannel, "function");
  const ch = await channels.createChannel({ name: "Temp", memberIds: [a] });
  const left = await channels.removeChannel(ch.id);
  assert.equal(left.some((row) => row.id === ch.id), false);
  assert.equal(await channels.getChannel(ch.id), null);
});

test("dedupes memberIds and is idempotent add", async () => {
  const ch = await channels.createChannel({ name: "Dup", memberIds: [a, a, b] });
  assert.deepEqual(ch.memberIds, [a, b]);
  const again = await channels.addMember(ch.id, a);
  assert.deepEqual(again.memberIds, [a, b]);
});

test.after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
