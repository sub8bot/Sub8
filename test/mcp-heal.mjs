import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A bundle that unpacks mcp-sub8.mjs but not its imports used to leave Claude
// with a dead MCP server. The app must heal itself instead of asking the user
// to install or edit anything.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-mcp-heal-"));
const asar = path.join(tmp, "app.asar");
const unpacked = path.join(tmp, "app.asar.unpacked");
const data = path.join(tmp, "data");

fs.mkdirSync(path.join(asar, "server"), { recursive: true });
fs.mkdirSync(path.join(unpacked, "server"), { recursive: true });
for (const f of ["mcp-sub8", "channel-desk", "vm", "vault", "paths", "isolation", "context", "teams", "memory", "code-agent", "update-state", "read-file", "subagents", "teammate"]) {
  fs.copyFileSync(path.join(root, "server", `${f}.mjs`), path.join(asar, "server", `${f}.mjs`));
}
// The bundle ships packages/<name>/{dist,package.json}, never node_modules — so
// a bare `@sub8/<name>` import only resolves if the heal rebuilds node_modules.
for (const p of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
  if (!p.isDirectory() || !fs.existsSync(path.join(root, "packages", p.name, "dist"))) continue;
  fs.cpSync(path.join(root, "packages", p.name, "dist"), path.join(asar, "packages", p.name, "dist"), { recursive: true });
  fs.copyFileSync(path.join(root, "packages", p.name, "package.json"), path.join(asar, "packages", p.name, "package.json"));
}
fs.mkdirSync(path.join(asar, "server", "desk-harness"), { recursive: true });
fs.copyFileSync(path.join(root, "server", "desk-harness", "mcp-cloud.mjs"), path.join(asar, "server", "desk-harness", "mcp-cloud.mjs"));
// The broken layout: entry point only.
fs.copyFileSync(path.join(asar, "server", "mcp-sub8.mjs"), path.join(unpacked, "server", "mcp-sub8.mjs"));

const spec = JSON.parse(
  execFileSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(path.join(root, "server", "host-cli.mjs"))}).then((m) => console.log(JSON.stringify(m.mcpServerSpec({}))))`],
    { env: { ...process.env, SUB8BOT_ROOT: asar, SUB8BOT_FILES: unpacked, SUB8BOT_DATA: data }, encoding: "utf8" },
  ),
);

const entry = spec.args[0];
assert.ok(entry.startsWith(data), `healed copy should live in the data dir, got ${entry}`);
assert.ok(fs.existsSync(entry), "healed entry exists");
for (const f of ["vm.mjs", "vault.mjs", "paths.mjs", "isolation.mjs", "context.mjs", "teams.mjs", "memory.mjs", "code-agent.mjs", "update-state.mjs", "read-file.mjs", "subagents.mjs", "teammate.mjs"]) {
  assert.ok(fs.existsSync(path.join(path.dirname(entry), f)), `healed copy is missing ${f}`);
}
const healedModules = path.join(path.dirname(path.dirname(entry)), "node_modules");
for (const name of ["automations", "choice", "constants", "control", "desk-ports", "harness-protocol", "shell-exec", "skills", "store", "wakes", "web-fetch"]) {
  assert.ok(
    fs.existsSync(path.join(healedModules, "@sub8", name, "dist", "index.js")),
    `healed copy is missing node_modules/@sub8/${name}`,
  );
}
assert.ok(
  fs.existsSync(path.join(path.dirname(entry), "desk-harness", "mcp-cloud.mjs")),
  "healed copy is missing desk-harness/mcp-cloud.mjs",
);

// It has to actually boot under real node, not merely exist.
const out = execFileSync(spec.command, [entry], {
  input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
  encoding: "utf8",
  timeout: 20000,
});
const tools = out
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .find((m) => m.result?.tools)?.result.tools.map((t) => t.name);
for (const name of ["computer", "browser", "shell", "memory", "update_state", "vault_list", "vault_fill", "list_routines", "upsert_routine", "disable_routine", "send_message", "list_teammates", "message_teammate", "list_tasks", "set_job", "update_task", "ask_user", "create_teammate", "rename_bot", "update_bot", "delete_teammate", "cloud_agent", "request_box_help", "web_search", "web_fetch", "read", "create_channel", "update_channel", "task", "check_subagent", "message_subagent", "stop_subagent", "await_shell", "get_mcp_tools", "call_mcp_tool", "authenticate_mcp_server", "add_mcp_server"]) {
  assert.ok(tools?.includes(name), `healed server should expose ${name}, got ${tools}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok mcp-heal");
