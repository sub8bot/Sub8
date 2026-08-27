import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-mcp-cloud-agent-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;
process.env.SUB8BOT_BOT_ID = "bot-desk-1";

const computers = await import(path.join(root, "server/computers.mjs"));
const store = await import("@sub8/store");
const codeAgent = await import(path.join(root, "server/code-agent.mjs"));
codeAgent.configureCodeAgents({ dataDir: tmp });
const { callTool, TOOLS, canonicalMcpName, MCP_ALIASES } = await import(path.join(root, "server/mcp-sub8.mjs"));

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log("ok  " + name);
    })
    .catch((err) => {
      console.error("not ok " + name);
      throw err;
    });
}

async function seedComputer() {
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(
    path.join(tmp, "computers.json"),
    JSON.stringify(
      [
        {
          id: "cmp-1",
          name: "Lead's desk",
          container: "localbot-botdesk",
          volume: "localbot-config-botdesk",
          status: "running",
        },
      ],
      null,
      2,
    ),
  );
}

async function seedBot() {
  const bot = store.newBot({ name: "Lead" });
  bot.id = "bot-desk-1";
  bot.vm = { computerId: "cmp-1" };
  await store.upsertBot(bot);
  return bot;
}

await seedComputer();
await seedBot();
await codeAgent.resetForTest();

await test("TOOLS lists cloud_agent and keeps teammates + send_message", () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes("cloud_agent"));
  assert.ok(names.includes("update_state"));
  assert.ok(names.includes("send_message"));
  assert.ok(names.includes("create_teammate"));
  assert.ok(names.includes("message_teammate"));
  assert.ok(names.includes("request_box_help"));
  assert.equal(names.includes("CloudAgent"), false);
  assert.equal(names.includes("External"), false);
  assert.equal(names.includes("SearchPlugins"), false);
  const cloud = TOOLS.find((t) => t.name === "cloud_agent");
  assert.deepEqual(cloud.inputSchema.properties.action.enum, ["launch", "list", "get", "reply", "cancel", "delete"]);
});

await test("aliases map CloudAgent and SendMessage", () => {
  assert.equal(canonicalMcpName("CloudAgent"), "cloud_agent");
  assert.equal(canonicalMcpName("SendMessage"), "send_message");
  assert.equal(canonicalMcpName("SendToAgent"), "message_teammate");
  assert.equal(canonicalMcpName("CreateAgent"), "create_teammate");
  assert.equal(canonicalMcpName("RequestBoxHelp"), "request_box_help");
  assert.equal(MCP_ALIASES.CloudAgent, "cloud_agent");
  assert.equal(canonicalMcpName("cloud_agent"), "cloud_agent");
  assert.equal(canonicalMcpName("send_message"), "send_message");
});

await test("cloud_agent launch does not create computers", async () => {
  await codeAgent.resetForTest();
  await seedComputer();
  const before = await computers.listComputers();
  assert.equal(before.length, 1);
  const out = await callTool("cloud_agent", {
    action: "launch",
    prompt: "open a PR that adds a test",
    cwd: "/config/workspace/foo",
    repoUrl: "https://github.com/example/app.git",
  });
  assert.equal(out.isError, undefined);
  const launched = JSON.parse(out.content[0].text);
  assert.equal(launched.status, "running");
  assert.ok(launched.id);
  const after = await computers.listComputers();
  assert.equal(after.length, before.length);
  assert.equal(after[0].id, "cmp-1");
  const disk = JSON.parse(await fs.readFile(path.join(tmp, "computers.json"), "utf8"));
  assert.equal(disk.length, 1);
  const sessions = JSON.parse(await fs.readFile(codeAgent.codeAgentsPath(), "utf8"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].computerId, "cmp-1");
  assert.equal(sessions[0].cwd, "/config/workspace/foo");
});

await test("CloudAgent alias launch still does not add a computer", async () => {
  await codeAgent.resetForTest();
  await seedComputer();
  const before = await computers.listComputers();
  const out = await callTool("CloudAgent", {
    action: "launch",
    prompt: "fix the failing test",
    cwd: "/config/workspace/app",
  });
  const launched = JSON.parse(out.content[0].text);
  assert.equal(launched.status, "running");
  assert.equal((await computers.listComputers()).length, before.length);
  const listed = await callTool("cloud_agent", { action: "list" });
  assert.ok(listed.content[0].text.includes(launched.id));
});

await test("SendMessage alias hits send_message", async () => {
  const empty = await callTool("SendMessage", { content: "   " });
  assert.equal(empty.isError, true);
  const sent = await callTool("SendMessage", { content: "ack" });
  assert.equal(sent.content[0].text, "sent");
});

await test("RequestBoxHelp maps to Take control and refuses External*", async () => {
  const out = await callTool("RequestBoxHelp", { reason: "2FA on GitHub" });
  assert.equal(out.isError, undefined);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.action, "take_control");
  assert.equal(body.hostFs, false);
  assert.match(body.reason, /2FA/);
});

await test("mcp-sub8 does not import computers or billing", () => {
  const src = readFileSync(path.join(root, "server/mcp-sub8.mjs"), "utf8");
  assert.match(src, /launchCodeAgent/);
  assert.match(src, /tryCloudStateTool/);
  assert.doesNotMatch(src, /from ["'][^"']*computers\.mjs["']/);
  assert.doesNotMatch(src, /\battachComputer\b|\bentitledQty\b|\bNEED_BILLING\b/);
  assert.doesNotMatch(src, /from ["'][^"']*stripe[^"']*["']/i);
});

// cloud_agent's inputSchema marks only `action` required, so a model can legally
// call get/reply/cancel/delete with no id. Before the guard, `get` answered
// "session not found" — which reads as "that session is gone" and invites a
// re-launch instead of a retry with the id — and reply/cancel/delete passed
// undefined straight into code-agent.
await test("cloud_agent get/reply/cancel/delete name the missing id", async () => {
  for (const action of ["get", "reply", "cancel", "delete"]) {
    for (const args of [{ action }, { action, id: "" }, { action, id: "   " }]) {
      const r = await callTool("cloud_agent", args);
      const text = r.content?.[0]?.text || "";
      assert.equal(r.isError, true, `${action} with ${JSON.stringify(args)} must be an error`);
      assert.match(text, /needs the session id/, `${action}: ${text}`);
      assert.match(text, /action "list"/, "and must say how to find one");
      assert.doesNotMatch(text, /session not found/, "must not read as a missing session");
    }
  }
});

// The guard must not swallow a real id: a well-formed lookup still reports a
// genuinely absent session the old way.
await test("a real id that does not exist still says session not found", async () => {
  const r = await callTool("cloud_agent", { action: "get", id: "ca-does-not-exist" });
  assert.match(r.content?.[0]?.text || "", /session not found/);
});

// list and launch take no id and must be unaffected.
await test("list is unaffected by the id guard", async () => {
  const r = await callTool("cloud_agent", { action: "list" });
  assert.notEqual(r.isError, true);
  assert.doesNotMatch(r.content?.[0]?.text || "", /needs the session id/);
});

console.log("ok mcp-cloud-agent");
