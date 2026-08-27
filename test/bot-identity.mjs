/**
 * Pins the defect where "send Scout a ping" destroyed a teammate.
 *
 * The chief reached rename_bot and the ONE handler behind rename_bot/update_bot
 * wrote the message text into name AND description AND instructions, so Scout
 * came back as "ping LOCALSUITE-1787676564" with its job gone — while the
 * suite's marker assertion still went green.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-bot-identity-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const chiefId = "00000000-0000-4000-8000-000000000001";
const mateId = "00000000-0000-4000-8000-000000000002";
const teamId = "00000000-0000-4000-8000-000000000010";
process.env.SUB8BOT_BOT_ID = chiefId;

const teams = await import("../server/teams.mjs");
const store = await import("@sub8/store");
const { callTool } = await import("../server/mcp-sub8.mjs");

const SCOUT = { name: "Scout", description: "watch example.com", instructions: "watch example.com" };
const PING = "ping LOCALSUITE-1787676564";

async function seed() {
  await fs.mkdir(tmp, { recursive: true });
  await store.writeJsonAtomic(store.botsPath, [
    { id: chiefId, name: "CycleProbe", description: "chief", instructions: "", teamId, teamRole: "chief", messages: [] },
    { id: mateId, ...SCOUT, teamId, teamRole: "worker", messages: [] },
  ]);
  await store.writeJsonAtomic(teams.teamsPath, [
    { id: teamId, name: "Team", chiefId, memberIds: [chiefId, mateId], computerId: null },
  ]);
}

function mate(bots) {
  const b = bots.find((x) => x.id === mateId);
  return { name: b.name, description: b.description, instructions: b.instructions };
}

/* --- the refusal rule, on its own --- */
const refusal = teams.botPatchRefusal({ name: PING, description: PING, instructions: PING });
assert.match(refusal || "", /Refused/);
assert.match(refusal || "", /message_teammate/);
assert.notEqual(teams.botPatchRefusal({ name: PING, instructions: PING }), null, "name + instructions is the same wipe");
assert.notEqual(teams.botPatchRefusal({ name: PING, description: PING }), null, "name + description is the same wipe");
// Real edits still go through.
assert.equal(teams.botPatchRefusal({ name: "Scout" }), null);
assert.equal(teams.botPatchRefusal({ name: "Scout", description: "watches example.com" }), null);
assert.equal(teams.botPatchRefusal({ instructions: "watch example.com", description: "watch example.com" }), null);
assert.equal(teams.botPatchRefusal({}), null);

/* --- the destructive call, through the real MCP tool, on both aliases --- */
for (const tool of ["rename_bot", "update_bot"]) {
  await seed();
  const out = await callTool(tool, { bot_id: mateId, name: PING, description: PING, instructions: PING });
  assert.equal(out.isError, true, `${tool} must refuse the wipe`);
  assert.match(out.content[0].text, /Refused/);
  assert.deepEqual(mate(await store.loadBots()), SCOUT, `${tool} must not touch the teammate`);
}

/* --- rename_bot sets ONLY the name; update_bot owns the rest --- */
await seed();
const renamed = await callTool("rename_bot", { bot_id: mateId, name: "Ranger", instructions: "forget your job" });
assert.equal(renamed.isError, undefined);
assert.match(renamed.content[0].text, /ignored instructions/);
assert.deepEqual(mate(await store.loadBots()), { ...SCOUT, name: "Ranger" });

/* --- a legitimate update still works, and the old values stay recoverable --- */
const updated = await callTool("update_bot", { bot_id: mateId, description: "watch example.org", color: "#123456" });
assert.equal(updated.isError, undefined);
const after = (await store.loadBots()).find((b) => b.id === mateId);
assert.equal(after.description, "watch example.org");
assert.equal(after.instructions, SCOUT.instructions, "an unset field is left alone");
assert.equal(after.color, "#123456");
assert.equal(after.priorIdentity.description, SCOUT.description, "the previous value is recoverable");
assert.equal(after.priorIdentity.name, "Ranger");
assert.ok(after.priorIdentity.at > 0);
// Undo is a plain update_bot with the values off priorIdentity.
await callTool("update_bot", { bot_id: mateId, name: after.priorIdentity.name, description: after.priorIdentity.description });
assert.equal((await store.loadBots()).find((b) => b.id === mateId).description, SCOUT.description);

/* --- a bot off the team is still out of reach --- */
await seed();
const stranger = await callTool("update_bot", { bot_id: "00000000-0000-4000-8000-000000000009", name: "nope" });
assert.equal(stranger.isError, true);

/* --- the guard is in the shared helper, not copy-pasted per call site --- */
const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(path.join(here, "..", "server", "agent.mjs"), "utf8");
assert.ok(
  !/target\.instructions = args\.instructions/.test(agentSrc),
  "agent.mjs must not re-implement the patch — it has to go through teams.applyBotPatch",
);
assert.ok(/applyBotPatch\(target, args, \{ tool: name \}\)/.test(agentSrc));

/* --- the model is told what these tools are NOT for --- */
const { TOOLS } = await import("../server/tools-catalog.mjs");
const { TOOLS: MCP_TOOLS } = await import("../server/mcp-sub8.mjs");
const rename = TOOLS.find((t) => t.function?.name === "rename_bot").function;
const update = TOOLS.find((t) => t.function?.name === "update_bot").function;
assert.match(rename.description, /does NOT deliver messages/i);
assert.match(update.description, /message_teammate/);
assert.deepEqual(Object.keys(rename.parameters.properties).sort(), ["bot_id", "name"]);
for (const name of ["rename_bot", "update_bot"]) {
  const row = MCP_TOOLS.find((t) => t.name === name);
  assert.match(row.description, /message_teammate/, `${name} MCP description must point messages elsewhere`);
}
assert.deepEqual(Object.keys(MCP_TOOLS.find((t) => t.name === "rename_bot").inputSchema.properties).sort(), ["bot_id", "name"]);

await fs.rm(tmp, { recursive: true, force: true });
console.log("ok bot-identity");
