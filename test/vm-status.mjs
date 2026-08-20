import assert from "node:assert/strict";
import { parseLocalbotPs, parseDisplayPorts, resolveStreamPort, streamPortForDisplay, urlLooksOpen, screenshotCmd } from "../server/vm.mjs";
import { applyHealthPort, CONNECTING_AFTER_MS, frameKey, healthIframeIsCurrent, shouldShowConnecting } from "../web/stream-bind.mjs";

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

const ranged = parseLocalbotPs(
  "localbot-88c5ceac\trunning\tUp 1 minute\t0.0.0.0:13102->3000/tcp, 0.0.0.0:13103->3001/tcp, 0.0.0.0:13104->3002/tcp",
);
assert.equal(ranged.get("localbot-88c5ceac")?.novncPort, 13102);
assert.equal(ranged.get("localbot-88c5ceac")?.portMap[3001], 13103);
assert.deepEqual(parseDisplayPorts("0.0.0.0:13102->3000/tcp, [::]:13102->3000/tcp, 0.0.0.0:13103->3001/tcp"), {
  3000: 13102,
  3001: 13103,
});
assert.equal(streamPortForDisplay(1, { 3000: 13102, 3001: 13103 }, 13102), 13102);
assert.equal(streamPortForDisplay(2, { 3000: 13102, 3001: 13103 }, 13102), 13103);
assert.equal(streamPortForDisplay(2, { 3000: 13102 }, 13102), null, "do not steal :1's port for a worker");
assert.equal(streamPortForDisplay(2, { 3000: 13102 }, 13103), 13103);

// A stored port that still answers HTTP can belong to a *different* desk
// after Docker remaps. Mapped always wins; stored is only a fallback.
assert.equal(resolveStreamPort(13100, 13101), 13101);
assert.equal(resolveStreamPort(13100, null), 13100);
assert.equal(resolveStreamPort(null, 13102), 13102);
assert.equal(resolveStreamPort(null, null), null);

const aika = { id: "6d6cfe52", vm: { novncPort: 13100 } };
const healed = applyHealthPort(aika, { novncPort: 13101 });
assert.equal(healed.changed, true);
assert.equal(healed.bot.vm.novncPort, 13101);
assert.equal(aika.vm.novncPort, 13100, "do not mutate the input bot");
assert.equal(frameKey(healed.bot), "6d6cfe52:13101");
assert.equal(healthIframeIsCurrent({ dataset: { key: "6d6cfe52:13100" } }, healed.bot), false);
assert.equal(healthIframeIsCurrent({ dataset: { key: "6d6cfe52:13101" } }, healed.bot), true);
assert.equal(applyHealthPort(healed.bot, { novncPort: 13101 }).changed, false);

assert.equal(CONNECTING_AFTER_MS, 5000);
assert.equal(shouldShowConnecting({ downSince: 0, now: 9000 }), false);
assert.equal(shouldShowConnecting({ downSince: 1000, now: 4000 }), false);
assert.equal(shouldShowConnecting({ downSince: 1000, now: 6000 }), true);

assert.equal(urlLooksOpen("Example Domain - Google Chrome", "https://mail.google.com"), false);
assert.equal(urlLooksOpen("Inbox - aikabotto@gmail.com - Google Chrome", "https://mail.google.com"), true);
assert.equal(urlLooksOpen("Octopus - Wikipedia - Google Chrome", "https://en.wikipedia.org/wiki/Octopus"), true);

const shot = screenshotCmd("/tmp/shot.png");
assert.match(shot, /ffmpeg/);
assert.match(shot, /x11grab/);
assert.match(shot, /scrot/);
assert.ok(shot.indexOf("ffmpeg") < shot.indexOf("scrot"), "ffmpeg is tried before scrot");
console.log("ok vm-status");
