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
