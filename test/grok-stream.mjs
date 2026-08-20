import assert from "node:assert/strict";
import fs from "node:fs";
import { foldGrokVisibleText, grokShouldKeepText, parseClaudeStream } from "../server/host-cli.mjs";

assert.equal(grokShouldKeepText("I'll look up the sub8 desktop tools by name."), false);
assert.equal(grokShouldKeepText("Let me take a screenshot."), false);
assert.equal(grokShouldKeepText("SFO is set. Next I’ll enter Washington."), false);
assert.equal(grokShouldKeepText("Error: max turns reached"), false);
assert.equal(
  grokShouldKeepText(
    "**Cheapest — $240 · Frontier**\n8:56 PM → 8:04 AM · SFO–IAD · 1 stop",
  ),
  true,
);

const wall = [
  "I'll search Google Flights on this computer.",
  "The MCP bridge isn’t exposing the desktop tools, so I’ll call the computer tool.",
  "SFO is set. Next I’ll enter Washington.",
  "Cheapest is $240 Frontier SFO–IAD 1-stop. United nonstop is $579.",
];
assert.match(foldGrokVisibleText(wall), /\$240 Frontier/);
assert.doesNotMatch(foldGrokVisibleText(wall), /I'll search Google Flights/);

assert.equal(foldGrokVisibleText(["I'll click next."]), "I'll click next.");

const claudeAcc = { parts: [], reply: "" };
for (const text of [
  "I'll spin up two helper bots and take one leg myself.",
  "Both helpers are working. Taking leg 1 myself.",
  "Prices are showing in Thai Baht — switching to USD.",
  "**Leg 1 — San Francisco → Washington DC**\n| $240 | Frontier | SFO–DCA |",
]) {
  parseClaudeStream(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }), claudeAcc);
}
assert.match(claudeAcc.reply, /\$240/);
assert.match(claudeAcc.reply, /Frontier/);
assert.doesNotMatch(claudeAcc.reply, /I'll spin up two helper bots/);
assert.doesNotMatch(claudeAcc.reply, /Thai Baht/);

const hostCli = fs.readFileSync(new URL("../server/host-cli.mjs", import.meta.url), "utf8");
assert.match(hostCli, /"--effort",\s*"low"/);
assert.match(hostCli, /default_reasoning_effort = "low"/);
console.log("ok grok-stream");
