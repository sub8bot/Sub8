/**
 * `awaitingUserSelection` is the latch that stops a bot talking twice before
 * the user picks a card. mcp-sub8 SETS it; the only two clears in the tree live
 * in server/index.mts.
 *
 * The droplet gets only half of that pair. The golden-snapshot bundle
 * (cloud/scripts/rebuild-desk-snapshot.mjs, ENTRYPOINTS) ships
 * server/mcp-sub8.mjs but NOT server/index.mjs, so on a desk nothing could ever
 * clear the latch: one send_message carrying a card wedged the desk and every
 * later send_message answered AWAITING_BLOCKED. Worse, resolveMcpBotId falls
 * back to the SHARED `desk-local` row, so the wedge was desk-wide, not
 * per-bot.
 *
 * runTurn now clears it at the top of a turn — a turn arriving is the user
 * answering, the same trigger index.mts clears on. These pin that.
 *
 * Isolated data dir: SUB8BOT_DATA is set before @sub8/store loads, since the
 * store binds dataDir once at import. Never touches real bots.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-latch-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const store = await import("@sub8/store");
const { runTurn, resolveMcpBotId } = await import("../server/desk-harness/harness.mjs");

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

/** A canned claude stream — no grok, no droplet, no network. */
const cannedGrok = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setTimeout(() => {
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok." }] } }) + "\n"),
    );
    child.emit("close", 0);
  }, 5);
  return child;
};

const seed = async (id, latched) =>
  store.upsertBot({ id, name: id, awaitingUserSelection: latched, messages: [] });

const drive = (botId) =>
  runTurn(
    { botId, content: "the user answers", provider: "claude", model: { id: "claude-sonnet-4-5", apiKey: "sk-ant-test" } },
    () => {},
    { spawnGrok: cannedGrok },
  );

await test("a turn clears a latched desk-local row", async () => {
  await seed("desk-local", true);
  assert.equal((await store.getBot("desk-local")).awaitingUserSelection, true, "seeded latched");
  await drive("desk-local");
  assert.equal(
    (await store.getBot("desk-local")).awaitingUserSelection,
    false,
    "a turn arrived and the latch is still set — the desk is wedged",
  );
});

// The wedge was desk-wide because of this fallback: a cloud bot id that has no
// row on the droplet resolves to the shared desk-local row, so the clear has to
// land on the RESOLVED id, not the requested one.
await test("a cloud bot id clears the shared desk-local row it resolves to", async () => {
  await seed("desk-local", true);
  assert.equal(await resolveMcpBotId("bot_cloud_only"), "desk-local", "unknown ids fall back");
  await drive("bot_cloud_only");
  assert.equal((await store.getBot("desk-local")).awaitingUserSelection, false, "the shared row is still latched");
});

await test("an unlatched row stays unlatched, and the turn still runs", async () => {
  await seed("desk-local", false);
  const text = await drive("desk-local");
  assert.equal((await store.getBot("desk-local")).awaitingUserSelection, false);
  assert.match(String(text || ""), /ok\./, "the turn still produced its reply");
});

// Best-effort by design: a turn for an id with no row anywhere must not throw.
await test("a missing row does not fail the turn", async () => {
  await store.saveBots([]);
  const text = await drive("nobody-here");
  assert.match(String(text || ""), /ok\./);
});

await fs.rm(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok desk-harness-latch");
process.exit(failed.length ? 1 : 0);
