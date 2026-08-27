/**
 * deleteBot unlinked the conversation and the screenshot and stopped there, so
 * everything else keyed by that bot id outlived the bot forever.
 *
 *  - Wakes. Every drain path iterates LIVE bots (store.loadBots), so no take*
 *    is ever called for an id that no longer exists — a closed teammate's queue
 *    just sat in wakes.json, unreachable.
 *  - Channel membership. A room the bot still belonged to kept enqueueing a
 *    wake for that ghost on every send, so the file grew monotonically; and
 *    sendToAgent counts members to report `queued: N`, so the sender was told
 *    it reached one more than it did.
 *
 * Both purges live in deleteBot rather than at its four call sites (the
 * delete_teammate tool in both harnesses, the team-delete loop, and
 * DELETE /api/bots/:id) — missing one is how this happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-purge-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("../dist/index.js");
const channels = await import("../dist/channels.js");
const wakes = await import("@sub8/wakes");

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("deleting a bot drops its queued wakes", async () => {
  const id = uid(1);
  await store.upsertBot({ id, name: "Doomed", messages: [] });
  wakes.enqueueWake({ type: "peer", botId: id, payload: { from: "someone" } });
  wakes.enqueueWake({ type: "peer", botId: id, payload: { from: "someone else" } });
  assert.equal(wakes.listWakes(id).length, 2, "sanity: wakes queued");

  await store.deleteBot(id);
  assert.equal(wakes.listWakes(id).length, 0, "the closed bot's wakes are unreachable but still queued");
  assert.equal(
    wakes.listQueuedBotIds().includes(id),
    false,
    "the ghost id is still listed as having a queue",
  );
});

test("deleting a bot removes it from every channel", async () => {
  const gone = uid(2);
  const stays = uid(3);
  await store.upsertBot({ id: gone, name: "Gone", messages: [] });
  await store.upsertBot({ id: stays, name: "Stays", messages: [] });
  const room = await channels.createChannel({ name: "standup", memberIds: [gone, stays] });
  assert.ok(room.memberIds.includes(gone), "sanity: seeded as a member");

  await store.deleteBot(gone);

  const after = await channels.getChannel(room.id);
  assert.equal(after.memberIds.includes(gone), false, "the ghost is still a member; every send re-queues for it");
  assert.equal(after.memberIds.includes(stays), true, "the surviving member was removed too");
});

test("a bot in several channels is removed from all of them", async () => {
  const id = uid(4);
  const peer = uid(40);
  await store.upsertBot({ id, name: "Busy", messages: [] });
  await store.upsertBot({ id: peer, name: "Peer", messages: [] });
  const rooms = [];
  for (const name of ["one", "two", "three"]) {
    rooms.push(await channels.createChannel({ name, memberIds: [id, peer] }));
  }
  await store.deleteBot(id);
  for (const r of rooms) {
    const after = await channels.getChannel(r.id);
    assert.equal(after.memberIds.includes(id), false, `still a member of ${r.name}`);
    assert.equal(after.memberIds.includes(peer), true, `${r.name} lost its surviving member`);
  }
});

// removeMember refuses to remove the last member. That must not abort the loop
// and skip the channels after it — which is what a single try around the whole
// sweep did.
test("a room where the bot is the last member does not block the others", async () => {
  const id = uid(6);
  const peer = uid(60);
  await store.upsertBot({ id, name: "Solo", messages: [] });
  await store.upsertBot({ id: peer, name: "Peer6", messages: [] });
  const alone = await channels.createChannel({ name: "alone", memberIds: [id] });
  const shared = await channels.createChannel({ name: "shared", memberIds: [id, peer] });

  await store.deleteBot(id);

  assert.equal(
    (await channels.getChannel(shared.id)).memberIds.includes(id),
    false,
    "the shared room was skipped because the solo room threw first",
  );
  // Documented, not endorsed: the solo room survives with a ghost member.
  // Deleting a conversation is the user's call, not a side effect of closing a
  // teammate.
  assert.ok(await channels.getChannel(alone.id), "the solo room is left intact");
});

// Deleting an id that does not exist must not disturb anything.
test("deleting an unknown id is a no-op", async () => {
  const keep = uid(5);
  await store.upsertBot({ id: keep, name: "Keep", messages: [] });
  wakes.enqueueWake({ type: "peer", botId: keep, payload: {} });
  const room = await channels.createChannel({ name: "untouched", memberIds: [keep] });

  assert.equal(await store.deleteBot(uid(99)), null);

  assert.equal(wakes.listWakes(keep).length, 1, "an unrelated bot's wakes were dropped");
  assert.equal((await channels.getChannel(room.id)).memberIds.includes(keep), true);
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
