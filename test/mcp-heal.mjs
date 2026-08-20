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
fs.mkdirSync(path.join(asar, "web"), { recursive: true });
fs.mkdirSync(path.join(unpacked, "server"), { recursive: true });
for (const f of ["mcp-sub8", "store", "vm", "vault", "paths", "trace", "isolation", "routines", "context", "teams", "memory"]) {
  fs.copyFileSync(path.join(root, "server", `${f}.mjs`), path.join(asar, "server", `${f}.mjs`));
}
fs.copyFileSync(path.join(root, "web", "palette.js"), path.join(asar, "web", "palette.js"));
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
for (const f of ["store.mjs", "vm.mjs", "vault.mjs", "paths.mjs", "trace.mjs", "isolation.mjs", "routines.mjs", "context.mjs", "teams.mjs", "memory.mjs"]) {
  assert.ok(fs.existsSync(path.join(path.dirname(entry), f)), `healed copy is missing ${f}`);
}
assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(entry)), "web", "palette.js")), "healed copy is missing web/palette.js");

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
for (const name of ["computer", "shell", "memory", "vault_list", "vault_fill", "list_routines", "upsert_routine", "disable_routine", "list_teammates", "message_teammate", "ask_user", "create_teammate", "rename_bot", "update_bot", "delete_teammate"]) {
  assert.ok(tools?.includes(name), `healed server should expose ${name}, got ${tools}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok mcp-heal");
