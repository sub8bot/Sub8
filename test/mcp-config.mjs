import assert from "node:assert/strict";
import { mcpServerSpec, nodeBin } from "../server/host-cli.mjs";

const spec = mcpServerSpec({ SUB8BOT_BOT_ID: "test" });
assert.equal(spec.type, "stdio");
assert.ok(spec.command, "node command");
assert.equal(spec.env.SUB8BOT_BOT_ID, "test");
assert.doesNotMatch(String(spec.command).toLowerCase(), /electron|^sub8$/);
assert.ok(Array.isArray(spec.args) && spec.args[0].includes("mcp-sub8"));
assert.ok(nodeBin());
console.log("ok mcp-config");

// The MCP server runs under real node, which cannot read inside app.asar.
// Every file it imports must be listed in build.asarUnpack, or the server
// dies with ERR_MODULE_NOT_FOUND and Claude reports "sub8 MCP not connected".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpack = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build.asarUnpack;
const covers = (rel) =>
  unpack.some((g) => new RegExp(`^${g.replace(/\*\*\/\*/g, ".*").replace(/\*/g, "[^/]*")}$`).test(rel));

const seen = new Set();
const walk = (file) => {
  if (seen.has(file) || !fs.existsSync(file)) return;
  seen.add(file);
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:import|from)\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']/g)) {
    walk(path.resolve(path.dirname(file), m[1] || m[2]));
  }
};
walk(path.join(root, "server", "mcp-sub8.mjs"));

for (const file of seen) {
  const rel = path.relative(root, file);
  assert.ok(covers(rel), `${rel} is imported by mcp-sub8.mjs but is not in build.asarUnpack`);
}
console.log(`ok mcp-unpack (${seen.size} files)`);
