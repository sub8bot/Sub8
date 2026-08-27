import assert from "node:assert/strict";
import fs from "node:fs";
import { foldGrokVisibleText, grokShouldKeepText, parseClaudeStream, foldClaudeVisibleText } from "../server/host-cli.mjs";

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

// Why foldClaudeVisibleText keeps only the LAST substantive block, and why that
// is NOT a bug to "fix" by joining them (I tried; the case below is what stopped
// me). Claude narrates progress across several blocks, and grokShouldKeepText
// only filters the ones that open with "I'll"/"Let me"/etc. A mid-turn line like
// "Prices are showing in Thai Baht" passes that filter but is not the answer.
// Joining the kept blocks puts all of that running commentary in the reply.
assert.equal(
  foldClaudeVisibleText(["Both helpers are working.", "Prices are in Thai Baht.", "Frontier is $240."]),
  "Frontier is $240.",
  "intermediate progress is discarded; the closing block is the answer",
);

// The cost of that rule, recorded as KNOWN rather than fixed: when Claude ends
// with an answer AND a follow-up question as two blocks, only the question
// survives. Changing this trades a rare truncated answer for progress noise in
// every multi-block turn, so it needs a decision about Claude's real output
// shape — not a one-line edit.
assert.equal(
  foldClaudeVisibleText(["Frontier is $240 nonstop.", "Want me to book it?"]),
  "Want me to book it?",
  "KNOWN: an answer followed by a question loses the answer",
);

// Duplicate blocks are also collapsed by keep-last: parseClaudeStream pushes a
// block on content_block_stop and again when the final assistant message
// repeats it, so the same text can arrive twice.
assert.equal(foldClaudeVisibleText(["The reference is XR7-42Q.", "The reference is XR7-42Q."]), "The reference is XR7-42Q.");

// Narration-only turns still fall back to the last line rather than empty.
assert.equal(foldClaudeVisibleText(["I'll take a screenshot.", "Let me look."]), "Let me look.");
assert.equal(foldClaudeVisibleText([]), "");
assert.equal(foldClaudeVisibleText(["only one"]), "only one");

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

// Token deltas must concatenate, not stack one word per line.
import { parseGrokStream } from "../server/host-cli.mjs";
const tok = { parts: [], reply: "" };
for (const t of ["P", "ONG", " 2026", "-08", "-22", "."]) {
  parseGrokStream(JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: t } } } }), tok);
}
assert.equal(tok.reply, "PONG 2026-08-22.");
assert.doesNotMatch(tok.reply, /\n/);
const mix = { parts: [], reply: "" };
parseGrokStream(JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "I'll open" } } } }), mix);
parseGrokStream(JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: " Maps." } } } }), mix);
parseGrokStream(JSON.stringify({ type: "tool_call" }), mix);
parseGrokStream(JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Cheapest is $240 Frontier." } } } }), mix);
assert.match(mix.reply, /\$240 Frontier/);
assert.doesNotMatch(mix.reply, /I'll open Maps/);
console.log("ok grok token deltas");
