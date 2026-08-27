/**
 * bots.json is the host index for every Bot the user has, and one bad read or
 * one clobbering write loses them. The cases here are the ones where being
 * wrong costs data: a wiped file read as "no bots", a stale turn overwriting a
 * newer edit, a delete that does not stick, and the defaults a caller gets when
 * the whole data directory is missing.
 *
 * Everything runs against a mkdtemp directory — the real data/bots.json holds
 * live bots, and a test that wrote there would delete them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-bots-file-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

// Every path in the module binds at import, so SUB8BOT_DATA has to be set first.
const store = await import("../dist/index.js");

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const exists = (p) => fs.access(p).then(() => true, () => false);

async function wipeData() {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
}

test("this suite is bound to a temp dir, not the user's data", () => {
  assert.equal(store.dataDir, tmp);
  assert.ok(store.botsPath.startsWith(tmp), `${store.botsPath} must be under ${tmp}`);
  assert.ok(store.conversationsDir.startsWith(tmp));
  assert.ok(store.screensDir.startsWith(tmp));
});

test("a missing data directory answers with empty lists and nulls, not a crash", async () => {
  await wipeData();
  assert.deepEqual(await store.loadBots(), []);
  assert.equal(await exists(store.botsPath), false, "reading must not invent a bots.json");
  assert.equal(await store.getBot(uid(1)), null);
  assert.equal(await store.deleteBot(uid(1)), null);
  assert.deepEqual(await store.loadConversation(uid(1)), []);
  assert.deepEqual(await store.listConversationIds(), []);
  assert.equal(await store.deleteMessages(uid(1), []), null, "nothing to delete is null, not a rewrite");
  assert.equal(await store.deleteMessages(uid(1), ["m1"]), null, "and neither is a bot that is not there");
  assert.equal(await store.patchBot(uid(1), () => {}), null);
  assert.equal(await exists(store.botsPath), false);
});

test("a wiped or truncated bots.json throws instead of reading as no bots at all", async () => {
  // Reading a broken file as [] is how every Bot disappears: the next save
  // writes that empty list back over the top.
  for (const junk of ["", "   ", "{not json", "[{\"id\":\"a\"}", "{}", "null", '"a string"']) {
    await wipeData();
    await fs.writeFile(store.botsPath, junk);
    await assert.rejects(() => store.loadBots(), `${JSON.stringify(junk)} must not read as an empty list`);
    assert.equal(await fs.readFile(store.botsPath, "utf8"), junk, "the broken file is left exactly as it was");

    const bot = store.newBot({ name: "Newcomer" });
    await assert.rejects(() => store.upsertBot(bot), "a save on top of a broken file must refuse");
    assert.equal(await fs.readFile(store.botsPath, "utf8"), junk, "and must not rewrite it as a one-bot list");
  }

  // A failed read must not wedge the lock for whoever comes next.
  await fs.writeFile(store.botsPath, "[]");
  assert.deepEqual(await store.loadBots(), []);
  const ok = store.newBot({ name: "Recovered" });
  await store.upsertBot(ok);
  assert.equal((await store.loadBots()).length, 1);
  assert.deepEqual(
    (await fs.readdir(tmp)).filter((n) => n.endsWith(".lock")),
    [],
    "no lock survives a throwing read",
  );
});

test("newBot sanitises what a caller can seed", async () => {
  const bot = store.newBot({
    name: "Scout",
    teamRole: "admin",
    pinned: "yes",
    unread: 1,
    hidden: "",
    harness: "grok-build",
    avatar: { body: "mantle" },
  });
  assert.match(bot.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(bot.grokSessionId, bot.id, "the harness session is keyed to the bot, not shared");
  assert.equal(bot.teamRole, "", "only chief or worker; anything else is no role at all");
  assert.equal(store.newBot({ teamRole: "chief" }).teamRole, "chief");
  assert.equal(store.newBot({ teamRole: "worker" }).teamRole, "worker");
  assert.equal(bot.pinned, true);
  assert.equal(bot.unread, true);
  assert.equal(bot.hidden, false);
  assert.deepEqual(bot.harness, { provider: "default" }, "a non-object harness is replaced, not stored");
  assert.equal(bot.vm.status, "idle");
  assert.equal(bot.vm.container, null, "a new bot owns no computer yet");
  assert.deepEqual(bot.messages, []);
  assert.deepEqual(bot.routines, []);
  assert.equal(bot.notificationsEnabled, false);
});

test("a stale turn cannot overwrite a newer edit", async () => {
  await wipeData();
  const bot = store.newBot({ name: "Original", title: "Ops" });
  bot.instructions = "be careful";
  await store.upsertBot(bot);
  const stored = await store.getBot(bot.id);

  // A long turn snapshots the bot when it starts; the human renames it while
  // the turn runs. The turn's copy is older, so it must not win.
  const stale = {
    ...stored,
    updatedAt: stored.updatedAt - 5_000,
    name: "Stale name",
    title: "Stale title",
    instructions: "stale instructions",
    harness: { provider: "ollama" },
    teamId: "stale-team",
    messages: [{ id: "m-turn", role: "assistant", content: "from the turn", ts: 3 }],
  };
  await store.upsertBot(stale);
  const after = await store.getBot(bot.id);
  assert.equal(after.name, "Original");
  assert.equal(after.title, "Ops");
  assert.equal(after.instructions, "be careful");
  assert.equal(after.teamId, "");
  assert.deepEqual(after.harness, stored.harness);
  // The turn's message still lands — only the edited fields are protected.
  assert.equal(after.messages.some((m) => m.id === "m-turn"), true, "the turn's own output is not discarded");

  // The other way round: a newer copy is allowed to change those fields.
  const fresh = { ...stored, updatedAt: Date.now() + 5_000, name: "Renamed" };
  await store.upsertBot(fresh);
  assert.equal((await store.getBot(bot.id)).name, "Renamed");
});

test("messages union across the row and the conversation file, and an answered card stays answered", async () => {
  await wipeData();
  const bot = store.newBot({ name: "Chatty" });
  bot.messages = [
    { id: "m1", role: "user", content: "hi", ts: 1 },
    { id: "card", kind: "choices", pending: false, selected: { id: "yes" }, ts: 2 },
  ];
  await store.upsertBot(bot);

  // A turn that started before the human answered the card writes its snapshot
  // back. The answered copy has to survive, or the widget reopens.
  const snapshot = await store.getBot(bot.id);
  snapshot.messages = [
    { id: "m1", role: "user", content: "hi", ts: 1 },
    { id: "card", kind: "choices", pending: true, ts: 2 },
    { id: "m2", role: "assistant", content: "done", ts: 3 },
  ];
  await store.upsertBot(snapshot);

  const after = await store.getBot(bot.id);
  assert.deepEqual(after.messages.map((m) => m.id), ["m1", "card", "m2"]);
  assert.equal(after.messages[1].pending, false, "the answered card must not reopen");
  assert.deepEqual(after.messages[1].selected, { id: "yes" });
  // The conversation file is the durable copy and must agree with the row.
  const onDisk = await store.loadConversation(bot.id);
  assert.deepEqual(onDisk.map((m) => m.id), ["m1", "card", "m2"]);
  assert.deepEqual(await store.listConversationIds(), [bot.id]);
});

test("the incoming routine list decides which routines exist, but a newer stored row wins", async () => {
  await wipeData();
  const bot = store.newBot({ name: "Scheduler" });
  bot.routines = [
    { id: "r1", prompt: "morning", updatedAt: 100 },
    { id: "r2", prompt: "evening", updatedAt: 100 },
  ];
  await store.upsertBot(bot);

  const edited = await store.getBot(bot.id);
  edited.routines = [{ id: "r1", prompt: "morning, edited", updatedAt: 500 }];
  await store.upsertBot(edited);
  assert.deepEqual((await store.getBot(bot.id)).routines.map((r) => r.id), ["r1"], "a delete has to stick");

  // A stale turn resurrecting r1 with an older copy must not undo the edit.
  const stale = await store.getBot(bot.id);
  stale.routines = [{ id: "r1", prompt: "morning", updatedAt: 100 }];
  await store.upsertBot(stale);
  const kept = (await store.getBot(bot.id)).routines;
  assert.equal(kept[0].prompt, "morning, edited");
  assert.equal(kept[0].updatedAt, 500);
});

test("deleteMessages drops only the named ids, in the file as well as the row", async () => {
  await wipeData();
  const bot = store.newBot({ name: "Trim" });
  bot.messages = [
    { id: "m1", role: "user", content: "keep", ts: 1 },
    { id: "m2", role: "assistant", content: "drop", ts: 2 },
    { id: "m3", role: "assistant", content: "keep", ts: 3 },
  ];
  await store.upsertBot(bot);

  const after = await store.deleteMessages(bot.id, ["m2", "", null, "not-a-message"]);
  assert.deepEqual(after.messages.map((m) => m.id), ["m1", "m3"]);
  assert.deepEqual((await store.loadConversation(bot.id)).map((m) => m.id), ["m1", "m3"]);
  assert.deepEqual((await store.getBot(bot.id)).messages.map((m) => m.id), ["m1", "m3"]);
  assert.equal(await store.deleteMessages(bot.id, []), null, "an empty id list is a no-op");
  assert.equal(await store.deleteMessages(bot.id, [null, ""]), null);
  assert.equal(await store.deleteMessages(uid(9), ["m1"]), null, "an unknown bot is null, not a throw");
});

test("deleting a bot takes its conversation and screenshot with it", async () => {
  await wipeData();
  const keep = store.newBot({ name: "Keep" });
  const go = store.newBot({ name: "Go" });
  go.messages = [{ id: "m1", role: "user", content: "hi", ts: 1 }];
  await store.upsertBot(keep);
  await store.upsertBot(go);
  await fs.writeFile(store.screenPath(go.id), "not really a png");

  const left = await store.deleteBot(go.id);
  assert.deepEqual(left.map((b) => b.name), ["Keep"]);
  assert.equal(await store.getBot(go.id), null);
  assert.equal(await exists(store.conversationPath(go.id)), false, "the transcript goes too");
  assert.equal(await exists(store.screenPath(go.id)), false, "and the screenshot");
  assert.equal(await exists(store.conversationPath(keep.id)), true, "the other bot is untouched");
  assert.equal(await store.deleteBot(uid(9)), null, "deleting a stranger changes nothing");
  assert.equal((await store.loadBots()).length, 1);
});

test("a row with no harness or a junk avatar is repaired on load, and the repair is written back", async () => {
  await wipeData();
  await fs.writeFile(
    store.botsPath,
    JSON.stringify([
      { id: uid(1), name: "Legacy", vm: {} },
      { id: uid(2), name: "Mantle", harness: { provider: "claude" }, avatar: { body: "mantle" }, vm: {} },
      { id: uid(3), name: "Junk", harness: "grok-build", avatar: "smiley", vm: {} },
      { id: uid(4), name: "Odd", harness: { model: "x" }, avatar: { body: "hexagonal", expression: "happy" }, vm: {} },
    ]),
  );
  const bots = await store.loadBots();
  assert.deepEqual(bots[0].harness, { provider: "grok-build", model: "grok-4.6" });
  assert.deepEqual(bots[3].harness, { provider: "grok-build", model: "grok-4.6" }, "a harness with no provider is not one");
  assert.deepEqual(bots[1].harness, { provider: "claude" }, "a real harness is left alone");
  assert.equal(bots[1].avatar.body, "rounder", "mantle is retired");
  assert.equal(bots[2].avatar.body, "rounder", "a non-object avatar is replaced");
  assert.equal(bots[3].avatar.body, "rounder", "an unknown body falls back");
  assert.equal(bots[3].avatar.expression, "happy", "…without losing the rest of the avatar");
  for (const b of bots) {
    assert.equal(b.grokSessionId, b.id);
    assert.deepEqual(b.routines, []);
    assert.deepEqual(b.messages, []);
  }
  // The harness repair is persisted, so it does not have to happen every load.
  const disk = JSON.parse(await fs.readFile(store.botsPath, "utf8"));
  assert.equal(disk[0].harness.provider, "grok-build");
  assert.equal(disk[3].harness.provider, "grok-build");
  assert.equal(disk.length, 4, "the repair must not drop a row");
});

test("recoverMissingBots only ever adds a row whose id is a real UUID", async () => {
  await wipeData();
  await fs.writeFile(store.botsPath, "[]");
  const added = await store.recoverMissingBots([
    { id: "not-a-uuid", name: "Injected" },
    { id: "", name: "Blank" },
    { id: "../../etc/passwd", name: "Traversal" },
    { id: uid(7), name: "Real" },
    null,
  ]);
  assert.deepEqual(added.map((b) => b.name), ["Real"]);
  const bots = await store.loadBots();
  assert.deepEqual(bots.map((b) => b.name), ["Real"]);
  assert.equal(bots[0].id, uid(7));
  assert.equal(bots[0].grokSessionId, uid(7));
});

test("patchBot mutates one row under the lock and never invents a bot", async () => {
  await wipeData();
  const bot = store.newBot({ name: "Patch" });
  await store.upsertBot(bot);
  const before = (await store.getBot(bot.id)).updatedAt;
  const patched = await store.patchBot(bot.id, (row) => {
    row.vm = { ...row.vm, status: "running", container: "localbot-abc" };
  });
  assert.equal(patched.vm.container, "localbot-abc");
  assert.ok(patched.updatedAt >= before, "a patch stamps updatedAt");
  assert.equal((await store.getBot(bot.id)).vm.status, "running");
  assert.equal(await store.patchBot(uid(9), () => {}), null);
  assert.equal((await store.loadBots()).length, 1, "the missing bot was not created");

  // A patch that throws surfaces, and leaves no lock behind.
  await assert.rejects(() =>
    store.patchBot(bot.id, () => {
      throw new Error("patch blew up");
    }),
  );
  assert.deepEqual((await fs.readdir(tmp)).filter((n) => n.endsWith(".lock")), []);
  assert.equal((await store.getBot(bot.id)).vm.container, "localbot-abc");
});

test("loadSettings writes a default settings.json when there is none", async () => {
  await wipeData();
  const settings = await store.loadSettings();
  assert.equal(settings.harness.provider, "grok-build");
  assert.equal(settings.harness.baseUrl, "https://api.x.ai/v1");
  assert.equal(settings.localExecPermission, "ask", "the host exec default is ask, never allow");
  const disk = JSON.parse(await fs.readFile(path.join(tmp, "settings.json"), "utf8"));
  assert.equal(disk.harness.provider, "grok-build");

  // A corrupt settings.json now THROWS rather than being silently replaced.
  // The rule here used to be "unlike bots.json, there is nothing here that
  // cannot be rebuilt" — but that premise was false: harness.apiKey lives ONLY
  // in this file, so writing defaults over a file that failed to parse
  // destroyed the user's provider key for good, and a non-atomic write was
  // what produced the unparseable file. ENOENT still means "not there yet" and
  // still yields defaults (above, and in settings-file.test.mjs).
  await fs.writeFile(path.join(tmp, "settings.json"), "{broken");
  await assert.rejects(() => store.loadSettings(), /JSON/i);
});

test("the harness normaliser pins the provider, the local base URLs and the local models", async () => {
  await wipeData();
  const unknown = await store.saveSettings({ harness: { provider: "evilcorp", baseUrl: "http://attacker.test/v1" } });
  assert.equal(unknown.harness.provider, "grok-build", "an unlisted provider falls back, it is not stored");
  // Pinned, and flagged: the foreign baseUrl is NOT dropped with the provider.
  // Only a leftover Ollama/LM Studio address is rewritten, so the fallback
  // grok-build harness ends up posting the x.ai key at whatever host was in
  // the settings body. Narrowing this would break a legitimate proxy baseUrl,
  // so it is a report rather than a change here.
  assert.equal(unknown.harness.baseUrl, "http://attacker.test/v1");

  // A baseUrl left over from an Ollama session must not stay behind on a cloud
  // provider, or the key gets posted at 127.0.0.1.
  const stale = await store.saveSettings({ harness: { provider: "grok-build", baseUrl: "http://127.0.0.1:11434/v1" } });
  assert.equal(stale.harness.baseUrl, "https://api.x.ai/v1");

  const ollama = await store.saveSettings({ harness: { provider: "ollama", baseUrl: "https://api.x.ai/v1" } });
  assert.equal(ollama.harness.baseUrl, "http://127.0.0.1:11434/v1", "a local provider is pinned to localhost");
  assert.equal((await store.saveSettings({ harness: { provider: "lmstudio" } })).harness.baseUrl, "http://127.0.0.1:1234/v1");

  // A local model name cannot ride onto the cloud harness…
  assert.equal((await store.saveSettings({ harness: { provider: "grok-build", model: "qwen3.5:7b" } })).harness.model, "grok-4.6");
  // …but a CLI harness keeps whatever it was given, including nothing at all.
  assert.equal((await store.saveSettings({ harness: { provider: "claude", model: "" } })).harness.model, "");
  assert.equal((await store.saveSettings({ harness: { provider: "codex", model: "gpt-5-codex" } })).harness.model, "gpt-5-codex");
  assert.equal((await store.saveSettings({ harness: { provider: "openrouter" } })).harness.model, "openai/gpt-4.1-mini");
});

test("settings.json holds the harness API key in plain text", async () => {
  await wipeData();
  // Pinned so nobody assumes this object is safe to hand to a client: the key
  // round-trips verbatim, on disk and in what loadSettings returns.
  const saved = await store.saveSettings({ harness: { provider: "spacexai", apiKey: "xai-PLAINTEXT-KEY" } });
  assert.equal(saved.harness.apiKey, "xai-PLAINTEXT-KEY");
  assert.equal((await store.loadSettings()).harness.apiKey, "xai-PLAINTEXT-KEY");
  const raw = await fs.readFile(path.join(tmp, "settings.json"), "utf8");
  assert.equal(raw.includes("xai-PLAINTEXT-KEY"), true);
});

test.after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
