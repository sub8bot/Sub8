import assert from "node:assert/strict";
import { parseLocalbotPs, urlLooksOpen } from "../server/vm.mjs";

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

// The host port docker reports now beats any port we remembered.
const mapped = parseLocalbotPs(
  [
    "localbot-6d6cfe52\trunning\tUp 11 hours\t0.0.0.0:13101->3000/tcp, [::]:13101->3000/tcp",
    "localbot-438716ea\tpaused\tUp 53 minutes (Paused)\t",
  ].join("\n"),
);
assert.equal(mapped.get("localbot-6d6cfe52")?.novncPort, 13101);
assert.equal(mapped.get("localbot-438716ea")?.novncPort, null);
assert.equal(urlLooksOpen("Example Domain - Google Chrome", "https://mail.google.com"), false);
assert.equal(urlLooksOpen("Inbox - aikabotto@gmail.com - Google Chrome", "https://mail.google.com"), true);
assert.equal(urlLooksOpen("Octopus - Wikipedia - Google Chrome", "https://en.wikipedia.org/wiki/Octopus"), true);
console.log("ok vm-status");
