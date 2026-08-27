import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cursorBin,
  cursorModelArgs,
  isCliHostProvider,
  parseCursorModels,
  parseCursorStream,
} from "../server/host-cli.mjs";

const src = fs.readFileSync(new URL("../server/host-cli.mjs", import.meta.url), "utf8");
assert.match(src, /whichCmd\("cursor-agent"/);
assert.doesNotMatch(src, /whichCmd\("agent"/);
assert.match(cursorBin(), /cursor-agent/);
assert.doesNotMatch(cursorBin(), /\/\.grok\/bin\/agent$/);

assert.equal(isCliHostProvider("cursor"), true);
assert.equal(isCliHostProvider("claude"), true);
assert.equal(isCliHostProvider("ollama"), false);

assert.deepEqual(cursorModelArgs(""), ["--model", "cursor-grok-4.6-low"]);
assert.deepEqual(cursorModelArgs("default"), ["--model", "cursor-grok-4.6-low"]);
assert.deepEqual(cursorModelArgs("auto"), []);
assert.deepEqual(cursorModelArgs("cursor-grok-4.6-low"), ["--model", "cursor-grok-4.6-low"]);

const listed = parseCursorModels(`
Available models

cursor-grok-4.6-low - Cursor Grok 4.6 Low
cursor-grok-4.6-low-fast - Cursor Grok 4.6 Low Fast
auto - Auto
composer-2.5 - Composer 2.5
`);
assert.ok(listed.includes("cursor-grok-4.6-low"));
assert.ok(listed.includes("composer-2.5"));
assert.equal(listed.includes("Available"), false);

const acc = { reply: "", parts: [] };
parseCursorStream(
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "PONG" }] },
  }),
  acc,
);
assert.match(acc.reply, /PONG/);

console.log("ok cursor-cli");
