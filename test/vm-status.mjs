import assert from "node:assert/strict";
import { parseLocalbotPs, urlLooksOpen, screenshotCmd, isContainerNameConflict, cachedHarnessPort, looksLikeElf, looksLikeMachO, shouldCopyHostGrok, linuxGrokArtifactUrl } from "../server/vm.mjs";
import { applyHealthPort, CONNECTING_AFTER_MS, cloudFrameKey, frameKey, healthIframeIsCurrent, novncAutoconnectUrl, shouldKickCloudFrame, shouldMountCloudFrame, shouldShowConnecting } from "../web/stream-bind.mjs";

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
assert.equal(cachedHarnessPort(""), null);
assert.equal(cachedHarnessPort("missing-desk"), null);
assert.equal(mapped.get("localbot-6d6cfe52")?.harnessPort, null, "do not invent novnc+8 when 3011 is unpublished");
const withHarness = parseLocalbotPs(
  "localbot-88c5ceac\trunning\tUp 1 minute\t0.0.0.0:13102->3000/tcp, 0.0.0.0:13117->3011/tcp",
);
assert.equal(withHarness.get("localbot-88c5ceac")?.harnessPort, 13117);
assert.equal(ranged.get("localbot-88c5ceac")?.harnessPort, null);
assert.equal(
  isContainerNameConflict(
    'docker: Error response from daemon: Conflict. The container name "/localbot-3c6becdd" is already in use by container "abc".',
  ),
  true,
);
assert.equal(isContainerNameConflict("docker run failed: no such image"), false);

const aika = { id: "6d6cfe52", vm: { novncPort: 13100 } };
const healed = applyHealthPort(aika, { novncPort: 13101 });
assert.equal(healed.changed, true);
assert.equal(healed.bot.vm.novncPort, 13101);
assert.equal(aika.vm.novncPort, 13100, "do not mutate the input bot");
assert.equal(frameKey(healed.bot), "6d6cfe52:13101");
assert.equal(novncAutoconnectUrl(""), "");
assert.match(novncAutoconnectUrl("http://10.0.0.1:3000/vnc.html"), /autoconnect=true/);
assert.match(novncAutoconnectUrl("http://10.0.0.1:3000/vnc.html"), /#autoconnect=true/);
assert.match(novncAutoconnectUrl("http://10.0.0.1:3000/vnc.html?autoconnect=1"), /autoconnect=true/);
assert.doesNotMatch(novncAutoconnectUrl("http://10.0.0.1:3000/vnc.html"), /view_only/);
assert.match(novncAutoconnectUrl("http://10.0.0.1:3000/vnc.html", { viewOnly: true }), /view_only=true/);
assert.match(novncAutoconnectUrl("http://10.0.0.1:3000/vnc.html", { viewOnly: true }), /#.*view_only=true/);
assert.equal(novncAutoconnectUrl("https://example.com/not-vnc"), "https://example.com/not-vnc");
assert.equal(shouldMountCloudFrame({ assigned: false, vncUp: true }), false);
assert.equal(shouldMountCloudFrame({ assigned: true, vncUp: false, waitedMs: 0 }), false);
assert.equal(shouldMountCloudFrame({ assigned: true, vncUp: true }), true);
assert.equal(shouldMountCloudFrame({ assigned: true, vncUp: false, waitedMs: 12000 }), true);
assert.equal(shouldKickCloudFrame({ vncUp: true, hadFrame: true, wasUp: false }), true);
assert.equal(shouldKickCloudFrame({ vncUp: true, hadFrame: false, wasUp: false }), false);
assert.equal(shouldKickCloudFrame({ vncUp: false, hadFrame: true, wasUp: false }), false);
assert.equal(shouldKickCloudFrame({ vncUp: true, hadFrame: true, wasUp: true }), false);
assert.equal(cloudFrameKey(null), "cloud:empty");
assert.equal(
  cloudFrameKey({ id: "cmp_abc", streamUrl: "http://10.0.0.1:3000/vnc.html", status: "assigned" }),
  "cloud:cmp_abc:http://10.0.0.1:3000/vnc.html:assigned",
);
assert.notEqual(
  cloudFrameKey({ id: "cmp_abc", streamUrl: "http://10.0.0.1:3000/vnc.html", status: "assigned" }),
  cloudFrameKey({ id: "cmp_abc", streamUrl: "http://10.0.0.1:3000/vnc.html", status: "warming" }),
);
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

const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]);
const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
assert.equal(looksLikeElf(elf), true);
assert.equal(looksLikeElf(macho), false);
assert.equal(looksLikeMachO(macho), true);
assert.equal(looksLikeMachO(elf), false);
assert.equal(shouldCopyHostGrok(elf), true, "Linux host may docker-cp ELF grok");
assert.equal(shouldCopyHostGrok(macho), false, "never docker-cp Darwin grok into webtop");
assert.equal(linuxGrokArtifactUrl({ arch: "arm64", version: "1.0.8" }), "https://x.ai/cli/grok-1.0.8-linux-aarch64");
console.log("ok vm-status");
