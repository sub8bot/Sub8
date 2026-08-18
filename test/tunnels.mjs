/**
 * Two-tunnel architecture tests. All computer-use hits the VM, never the host Mac.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "../server/store.mjs";
import * as vm from "../server/vm.mjs";
import { requireVm, assertVmShell, isHostPath } from "../server/isolation.mjs";
import * as routines from "../server/routines.mjs";
import { isChatQuestion } from "../server/agent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

async function pickBot() {
  const bots = await store.loadBots();
  const live = bots.find((b) => b.vm?.status === "running" && b.vm?.container);
  if (!live) throw new Error("No running bot computer. Start Sub8 first.");
  return live;
}

test("isolation rejects a bot with no container", () => {
  assert.throws(() => requireVm({ vm: {} }, "click"), /no bot computer/);
});

test("isolation rejects host-looking container names", () => {
  assert.throws(() => requireVm({ vm: { container: "chrome" } }, "click"), /no bot computer/);
});

test("host path detector", () => {
  assert.equal(isHostPath("/Users/dan/secret"), true);
  assert.equal(isHostPath("/config/Desktop"), false);
});

test("shell blocks host paths", () => {
  assert.throws(() => assertVmShell("cat /Users/dan/.ssh/id_rsa"), /host paths/);
  assert.throws(() => assertVmShell("cd /Users/dan && ls"), /host paths/);
});

test("shell allows VM commands", () => {
  assert.doesNotThrow(() => assertVmShell("ls /config"));
});

test("check again is not a 15-minute routine", () => {
  assert.equal(routines.parseSchedule("check again"), null);
  assert.equal(routines.looksLikeSchedule("check again"), false);
  assert.equal(routines.looksLikeSchedule("check back"), false);
  assert.equal(routines.looksLikeSchedule("every time I click"), false);
  assert.equal(routines.looksLikeSchedule("what is the routine"), false);
});

test("explicit cadence still becomes a routine", () => {
  assert.equal(routines.parseSchedule("do this every 15 minutes")?.intervalMs, 15 * 60_000);
  assert.equal(routines.looksLikeSchedule("check flights daily"), true);
  assert.equal(routines.looksLikeSchedule("watch X inbox every 7 minutes"), true);
});

test("can you open chrome is work, not a chat question", () => {
  assert.equal(isChatQuestion("can you open chrome"), false);
  assert.equal(isChatQuestion("search google flights"), false);
  assert.equal(isChatQuestion("why didn't that work?"), true);
  assert.equal(isChatQuestion("what are you doing?"), true);
});

test("upsert refuses a check-again one-liner", () => {
  const botA = { routines: [] };
  const r = routines.upsertRoutine(botA, { instruction: "check again" });
  assert.equal(r.routine, null);
  assert.match(r.rejected, /standing job/);
  assert.equal(botA.routines.length, 0);
});

let bot;

test("a running bot computer exists", async () => {
  bot = await pickBot();
  assert.match(bot.vm.container, /^localbot-[0-9a-f]{8}$/);
});

test("container name is derived from bot id", async () => {
  assert.equal(bot.vm.container, vm.containerName(bot.id));
});

test("screenshot is a real PNG from the VM", async () => {
  const shot = await vm.screenshot(bot);
  assert.ok(shot.buf[0] === 0x89 && shot.buf[1] === 0x50);
  assert.ok(shot.bytes > 8_000);
  assert.equal(shot.width, 1024);
  assert.equal(shot.height, 768);
});

test("mouse move reports location", async () => {
  await vm.mouseMove(bot, 220, 180);
  const loc = await vm.mouseLocation(bot);
  assert.ok(Math.abs(loc.x - 220) <= 3, `x=${loc.x}`);
  assert.ok(Math.abs(loc.y - 180) <= 3, `y=${loc.y}`);
});

test("mouse clamp stays on 1024x768", () => {
  const p = vm.clampPoint(-20, 9000);
  assert.equal(p.x, 0);
  assert.equal(p.y, 767);
});

test("click empty desktop does not throw", async () => {
  await vm.click(bot, 900, 700, 1, 1);
});

test("double-click does not throw", async () => {
  await vm.click(bot, 880, 680, 1, 2);
});

test("wait helper", async () => {
  const t = Date.now();
  await vm.wait(200);
  assert.ok(Date.now() - t >= 180);
});

test("clipboard write then read", async () => {
  await vm.clipboardWrite(bot, "LOCALBOT_CLIP_OK");
  const got = await vm.clipboardRead(bot);
  assert.match(got, /LOCALBOT_CLIP_OK/);
});

test("type via clipboard paste", async () => {
  await vm.click(bot, 900, 40, 1, 1);
  await vm.typeText(bot, "vm-type-ok");
});

test("key Escape is safe", async () => {
  await vm.key(bot, "Escape");
});

test("scroll does not throw", async () => {
  await vm.scroll(bot, 512, 400, 80, 0);
});

test("small drag does not throw", async () => {
  await vm.drag(bot, 400, 300, 430, 320);
});

test("inside shell: whoami is abc", async () => {
  const r = await vm.shell(bot, "whoami");
  assert.match(r.output, /abc/);
});

test("inside shell: hostname is computer", async () => {
  const r = await vm.shell(bot, "hostname");
  assert.match(r.output, /computer/);
});

test("inside shell: host /Users is not mounted", async () => {
  const r = await vm.shell(bot, "test ! -e /Users; echo $?");
  assert.match(r.output.trim(), /0$/);
});

test("inside shell: /config is home", async () => {
  const r = await vm.shell(bot, "ls /config | head");
  assert.ok(r.ok);
  assert.ok(r.output.length > 0);
});

test("inside shell: DISPLAY is :1", async () => {
  const r = await vm.shell(bot, "echo $DISPLAY");
  assert.match(r.output, /:1/);
});

test("Chrome exists in the VM", async () => {
  const r = await vm.shell(bot, "command -v google-chrome-stable || command -v google-chrome || command -v chrome-desktop");
  assert.ok(/chrome/i.test(r.output));
});

test("Grok CLI exists in the VM", async () => {
  const r = await vm.shell(bot, "test -x /usr/local/bin/grok && /usr/local/bin/grok --version");
  assert.match(r.output, /grok/i);
});

test("AGENTS.md is installed in the VM", async () => {
  const r = await vm.shell(bot, "test -f /config/AGENTS.md && wc -c /config/AGENTS.md");
  assert.ok(r.ok);
});

test("open Chrome via inside command", async () => {
  await vm.shell(bot, "pkill -f 'chrome|chromium' >/dev/null 2>&1 || true");
  await vm.wait(400);
  const r = await vm.shell(bot, "DISPLAY=:1 /usr/local/bin/chrome-desktop >/tmp/chrome.log 2>&1 & echo $!");
  assert.ok(r.ok);
  await vm.wait(2500);
  const procs = await vm.shell(bot, "pgrep -af chrome | head -3");
  assert.match(procs.output, /chrome/i);
});

test("screenshot after Chrome still 1024x768", async () => {
  const shot = await vm.screenshot(bot);
  assert.equal(shot.width, 1024);
  assert.equal(shot.height, 768);
});

test("click Chrome desktop icon (outside tunnel)", async () => {
  await vm.key(bot, "super+d");
  await vm.wait(400);
  await vm.click(bot, 55, 268, 1, 2);
  await vm.wait(1500);
  const shot = await vm.screenshot(bot);
  assert.ok(shot.bytes > 8_000);
});

test("type into a form-like field (ctrl+l then URL)", async () => {
  await vm.key(bot, "ctrl+l");
  await vm.wait(300);
  await vm.typeText(bot, "about:blank");
  await vm.key(bot, "Return");
  await vm.wait(400);
});

test("each bot maps to its own container prefix", async () => {
  const bots = await store.loadBots();
  const names = new Set(bots.map((b) => vm.containerName(b.id)));
  assert.equal(names.size, bots.length);
});

test("host grok --single is not how bots run", async () => {
  let out = "";
  try {
    out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  } catch {
    out = "";
  }
  const leaked = out.split("\n").filter((l) => /grok .*(--single|--print)/.test(l) && !l.includes("docker"));
  assert.equal(leaked.length, 0, leaked.join("\n"));
});

test("stream health reports VM apps", async () => {
  const h = await vm.streamHealth(bot);
  assert.equal(h.container, bot.vm.container);
  assert.equal(h.running, true);
  assert.ok(h.grok || h.chrome);
});

let failed = 0;
for (const { name, fn } of results) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, "-", err.message.split("\n")[0]);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
