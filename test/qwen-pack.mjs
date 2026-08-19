import assert from "node:assert/strict";
import { localContinueQuery, qwenSafeMessages } from "../server/agent.mjs";

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
console.log("ok qwen-pack");
