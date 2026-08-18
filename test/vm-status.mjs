import assert from "node:assert/strict";
import { parseLocalbotPs } from "../server/vm.mjs";

const states = parseLocalbotPs(
  [
    "localbot-6d6cfe52\trunning\tUp 33 hours",
    "localbot-438716ea\tpaused\tUp 53 minutes (Paused)",
    "localbot-deadbeef\texited\tExited (0) 2 minutes ago",
    "clicklab-fresh\trunning\tUp 39 hours",
    "",
  ].join("\n"),
);

assert.equal(states.get("localbot-6d6cfe52")?.status, "running");
assert.equal(states.get("localbot-438716ea")?.status, "paused");
assert.equal(states.get("localbot-deadbeef")?.status, "exited");
assert.equal(states.has("clicklab-fresh"), false);
assert.equal(parseLocalbotPs("").size, 0);
console.log("ok vm-status");
