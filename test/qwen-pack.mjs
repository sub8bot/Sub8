import assert from "node:assert/strict";
import { extractToolCallsFromContent, localContinueQuery, localWantsTools, looksLikeDesktopTask, qwenSafeMessages } from "../server/agent.mjs";

const short = "Continue the desktop job.";
assert.equal(localContinueQuery(short), short);
assert.match(localContinueQuery("x".repeat(2000)), /Do not re-read MEMORY/);

const png = { type: "image_url", image_url: { url: "data:image/png;base64,xx" } };
const withShot = [
  { role: "system", content: "sys" },
  {
    role: "user",
    content: [
      { type: "text", text: "Screenshot 1024x768." },
      png,
    ],
  },
];
const packedShot = qwenSafeMessages(withShot, "click Post");
const lastShot = packedShot.at(-1);
assert.equal(lastShot.role, "user");
assert.ok(Array.isArray(lastShot.content));
assert.ok(lastShot.content.some((p) => p.type === "image_url"));

const afterShell = [
  ...withShot,
  { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "shell", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "1", content: "=== MEMORY ===\nlong notes" },
];
const packedShell = qwenSafeMessages(afterShell, localContinueQuery("x".repeat(2000)));
const lastShell = packedShell.at(-1);
assert.equal(typeof lastShell.content, "string");
assert.equal(packedShell.filter((m) => Array.isArray(m.content)).length, 0);
assert.match(lastShell.content, /Do not re-cat notes/);

assert.equal(looksLikeDesktopTask("resume"), false, "cloud path must not treat resume as a new desktop job");
assert.equal(looksLikeDesktopTask("open gmail"), true);
assert.equal(looksLikeDesktopTask("what is 2+2?"), false);
assert.equal(localWantsTools("resume", 0), true);
assert.equal(localWantsTools("keep going", 0), true);
assert.equal(localWantsTools("hi", 2), true);
assert.equal(localWantsTools("what is 2+2?", 0), false);

const xml = `<tool_call>
{"name": "computer", "arguments": {"action": "screenshot"}}
</tool_call>`;
const fromXml = extractToolCallsFromContent(xml);
assert.equal(fromXml.length, 1);
assert.equal(fromXml[0].function.name, "computer");
assert.match(fromXml[0].function.arguments, /screenshot/);

assert.equal(extractToolCallsFromContent("Let me look at the screen first.").length, 0);
console.log("ok qwen-pack");
