import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOOLS, canonicalToolName, FALLBACK_ALIASES } from "../server/tools-catalog.mjs";
import { TOOLS as agentTools } from "../server/agent.mjs";
import { MCP_ALIASES } from "../server/mcp-sub8.mjs";
import { TOOL_ALIASES } from "../packages/orchestration/dist/tools.js";

const names = new Set(TOOLS.map((t) => t.function?.name));
for (const name of [
  "send_message",
  "computer",
  "shell",
  "read",
  "web_fetch",
  "web_search",
  "create_teammate",
  "message_teammate",
  "create_channel",
  "update_channel",
  "task",
  "check_subagent",
  "message_subagent",
  "stop_subagent",
  "cloud_agent",
  "update_state",
  "request_box_help",
  "add_mcp_server",
  "get_mcp_tools",
  "call_mcp_tool",
  "authenticate_mcp_server",
]) {
  assert.ok(names.has(name), `TOOLS missing ${name}`);
}

assert.equal(canonicalToolName("SendMessage"), "send_message");
assert.equal(canonicalToolName("CloudAgent"), "cloud_agent");
assert.equal(canonicalToolName("RequestBoxHelp"), "request_box_help");
assert.equal(canonicalToolName("CreateChannel"), "create_channel");
assert.equal(canonicalToolName("Task"), "task");
assert.equal(canonicalToolName("WebFetch"), "web_fetch");
assert.equal(canonicalToolName("Screenshot"), "computer");
assert.equal(canonicalToolName("WebSearch"), "web_search");
assert.equal(canonicalToolName("Read"), "read");
assert.equal(canonicalToolName("AwaitShell"), "await_shell");
assert.equal(canonicalToolName("AskUser"), "ask_user");
assert.equal(canonicalToolName("GetMcpTools"), "get_mcp_tools");
assert.equal(canonicalToolName("CallMcpTool"), "call_mcp_tool");
assert.equal(canonicalToolName("AuthenticateMcpServer"), "authenticate_mcp_server");
assert.deepEqual(FALLBACK_ALIASES, TOOL_ALIASES);
assert.deepEqual(MCP_ALIASES, TOOL_ALIASES);
assert.equal(names.has("External"), false);
assert.equal(names.has("SearchPlugins"), false);

assert.equal(agentTools.length, TOOLS.length);
assert.equal(agentTools, TOOLS);

const created = TOOLS.find((t) => t.function?.name === "create_teammate")?.function;
assert.ok(created, "create_teammate is in TOOLS");
assert.match(created.description, /cursor/);

const del = TOOLS.find((t) => t.function?.name === "delete_teammate")?.function;
assert.ok(del, "delete_teammate is in TOOLS");
assert.match(del.description, /all_workers/);
assert.match(del.description, /not a job/i);
assert.equal(del.parameters?.properties?.all_workers?.type, "boolean");
assert.ok(!del.parameters?.required?.includes("bot_id"));

const agentSrc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/agent.mjs"), "utf8");
assert.match(agentSrc, /from ["']\.\/tools-catalog\.mjs["']/);
assert.doesNotMatch(agentSrc, /const TOOLS =/);

console.log("ok tools-catalog");
