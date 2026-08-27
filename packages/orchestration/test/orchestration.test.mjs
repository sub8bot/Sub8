import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AGENT_DATA_ROOT,
  agentDir,
  isChannel,
  TOOL_ALIASES,
  assertCodeAgentCwd,
} from "../dist/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(pkgRoot, "fixtures");

test("agentDir", () => {
  const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  assert.equal(AGENT_DATA_ROOT, "/config/agent-data");
  assert.equal(agentDir(id), `/config/agent-data/agents/${id}`);
});

test("isChannel (group.json present)", () => {
  assert.equal(isChannel({ groupJson: { version: 1, memberIds: ["a"] } }), true);
  assert.equal(isChannel({}), false);
  assert.equal(isChannel({ groupJson: undefined }), false);
});

test("TOOL_ALIASES CloudAgent and SendMessage", () => {
  assert.equal(TOOL_ALIASES.CloudAgent, "cloud_agent");
  assert.equal(TOOL_ALIASES.SendMessage, "send_message");
  assert.equal(TOOL_ALIASES.SendToAgent, "message_teammate");
  assert.equal(TOOL_ALIASES.CreateAgent, "create_teammate");
  assert.equal(TOOL_ALIASES.CreateChannel, "create_channel");
  assert.equal(TOOL_ALIASES.UpdateChannel, "update_channel");
  assert.equal(TOOL_ALIASES.Task, "task");
  assert.equal(TOOL_ALIASES.CheckSubagent, "check_subagent");
  assert.equal(TOOL_ALIASES.MessageSubagent, "message_subagent");
  assert.equal(TOOL_ALIASES.StopSubagent, "stop_subagent");
  assert.equal(TOOL_ALIASES.WebSearch, "web_search");
  assert.equal(TOOL_ALIASES.WebFetch, "web_fetch");
  assert.equal(TOOL_ALIASES.Screenshot, "computer");
  assert.equal(TOOL_ALIASES.RequestBoxHelp, "request_box_help");
  assert.equal(TOOL_ALIASES.Read, "read");
  assert.equal(TOOL_ALIASES.AwaitShell, "await_shell");
  assert.equal(TOOL_ALIASES.AskUser, "ask_user");
  assert.equal(TOOL_ALIASES.GetMcpTools, "get_mcp_tools");
  assert.equal(TOOL_ALIASES.CallMcpTool, "call_mcp_tool");
  assert.equal(TOOL_ALIASES.AuthenticateMcpServer, "authenticate_mcp_server");
});

test("assertCodeAgentCwd rejects /Users/... and accepts /config/workspace/foo", () => {
  assert.equal(assertCodeAgentCwd("/config/workspace/foo"), "/config/workspace/foo");
  assert.throws(() => assertCodeAgentCwd("/Users/someone/secret"), /under \/config/);
  assert.throws(() => assertCodeAgentCwd("/config/../Users/someone/secret"), /under \/config/);
});

test("fixtures exist and group.json version is 1", () => {
  const agentsDir = path.join(fixtures, "agents");
  const ids = readdirSync(agentsDir);
  const channelId = ids.find((id) => existsSync(path.join(agentsDir, id, "group.json")));
  assert.ok(channelId, "channel fixture with group.json");
  const group = JSON.parse(readFileSync(path.join(agentsDir, channelId, "group.json"), "utf8"));
  assert.equal(group.version, 1);
  assert.ok(Array.isArray(group.memberIds));
  assert.equal(isChannel({ groupJson: group }), true);

  const agentId = ids.find(
    (id) =>
      existsSync(path.join(agentsDir, id, "profile.json")) &&
      existsSync(path.join(agentsDir, id, "memory", "profile.md")),
  );
  assert.ok(agentId, "solo agent fixture");
  assert.ok(existsSync(path.join(agentsDir, agentId, "automations", "demo", "automation.json")));
  assert.ok(existsSync(path.join(fixtures, "user-memory", "by-agent", agentId, "profile.md")));

  const skills = readdirSync(path.join(fixtures, "workflows"));
  assert.ok(skills.some((id) => existsSync(path.join(fixtures, "workflows", id, "SKILL.md"))));
});
