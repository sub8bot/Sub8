/**
 * Two-tunnel architecture tests. All computer-use hits the VM, never the host Mac.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "@sub8/store";
import * as vm from "../server/vm.mjs";
import { listComputers, computerForBot } from "../server/computers.mjs";
import { requireVm, assertVmShell, isHostPath } from "../server/isolation.mjs";
import * as routines from "@sub8/automations";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

/**
 * Live-desk tests drive a REAL container: they pkill Chrome inside it, restart
 * it, and (in the paused-desk test) freeze it. They are opt-in, by name:
 *
 *   SUB8_TEST_DESK=localbot-xxxxxxxx node test/tunnels.mjs
 *   SUB8_TEST_DESK=... SUB8_TEST_DESK_PAUSE=1 node test/tunnels.mjs
 *
 * They used to run unconditionally against whatever pickBot() happened to
 * return: the first bot in data/bots.json marked vm.status === "running" whose
 * name did not match /aika/. That file is rewritten continuously by the running
 * app, so the target DRIFTED between runs — a moment where "demo" was not
 * flagged running silently promoted the next bot in the file, and the suite
 * pkill'd Chrome on a desk it was never meant to touch and paused it. Naming the
 * desk explicitly is the only selection that cannot drift onto someone else's
 * work. Unset, every test that touches a container is skipped, loudly.
 */
const LIVE_DESK = String(process.env.SUB8_TEST_DESK || "").trim();
// Freezing a container is gated separately, and hard: `docker pause` is only
// undone by the finally below, which an abnormal exit never reaches.
const ALLOW_PAUSE = process.env.SUB8_TEST_DESK_PAUSE === "1";
const SKIP = Symbol("skip");

/** A test that touches a real container. Skipped unless a desk was named. */
function live(name, fn) {
  test(name, async () => {
    if (!LIVE_DESK) return SKIP;
    return fn();
  });
}

async function pickBot() {
  const bots = await store.loadBots();
  const match = bots.filter((b) => b.vm?.container === LIVE_DESK);
  if (!match.length) {
    throw new Error(`SUB8_TEST_DESK=${LIVE_DESK} matches no bot's vm.container in data/bots.json`);
  }
  // Several bots can share one desk; any of them addresses the same container.
  return match[0];
}

test("isolation rejects a bot with no container", () => {
  assert.throws(() => requireVm({ vm: {} }, "click"), /no bot computer/);
});

test("isolation rejects host-looking container names", () => {
  assert.throws(() => requireVm({ vm: { container: "chrome" } }, "click"), /no bot computer/);
});

test("isolation allows a remote Cloud desk (same computer tools, docker-exec over HTTP)", () => {
  assert.equal(
    requireVm({ vm: { deskUrl: "http://10.0.0.1:3001", deskToken: "t" } }, "screenshot"),
    "sub8-desk",
  );
});

test("host path detector", () => {
  assert.equal(isHostPath("/Users/someone/secret"), true);
  assert.equal(isHostPath("/config/Desktop"), false);
});

test("shell blocks host paths", () => {
  assert.throws(() => assertVmShell("cat /Users/someone/.ssh/id_rsa"), /host paths/);
  assert.throws(() => assertVmShell("cd /Users/someone && ls"), /host paths/);
});

test("shell allows VM commands", () => {
  assert.doesNotThrow(() => assertVmShell("ls /config"));
  assert.doesNotThrow(() => assertVmShell("desk-doctor"));
  assert.doesNotThrow(() => assertVmShell("rg TODO /config/workspace"));
});

test("shell blocks GUI automation and Chrome debug attach", () => {
  assert.throws(() => assertVmShell("xdotool click 1"), /computer tool|click or type/);
  assert.throws(() => assertVmShell("octo-click 100 200"), /computer tool|click or type/);
  assert.throws(() => assertVmShell("curl -s http://127.0.0.1:9222/json/new?https://example.com"), /debug port|open/);
  assert.throws(() => assertVmShell("python3 -m playwright"), /debug port|open/);
});

test("shell blocks cookie dumps", () => {
  assert.throws(() => assertVmShell("cat /config/chrome-desk/Default/Cookies"), /cookies or secrets/);
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

test("Maps hours and teammate reports are not routines", () => {
  const tacos = `Tacos replies:
Re-verified on my own screen (display :3). Hours: page reads "Closed · Opens 10 AM" — consistent with 10 AM–10 PM daily.
Rating: 4.6 ★ · 1,530 reviews.`;
  assert.equal(routines.looksLikeSchedule(tacos), false);
  assert.equal(routines.looksLikeTeammateTraffic(tacos), true);
  assert.equal(routines.looksLikeSchedule("check the inbox daily"), true);
  assert.equal(
    routines.looksLikeSchedule("Scout replies:\nVerified Kuma Sushi 4.7 on Google Maps, display :4."),
    false,
  );
});

test("upsert refuses a check-again one-liner", () => {
  const botA = { routines: [] };
  const r = routines.upsertRoutine(botA, { instruction: "check again" });
  assert.equal(r.routine, null);
  assert.match(r.rejected, /standing job/);
  assert.equal(botA.routines.length, 0);
});

let bot;

live("a running bot computer exists", async () => {
  bot = await pickBot();
  assert.match(bot.vm.container, /^localbot-[0-9a-f]{8}$/);
});

// Containers are named after the COMPUTER, not the bot. data/computers.json has
// been the source of truth since desks became first-class (server/computers.mjs):
// a desk's container is containerForId(computer.id), several bots can share one
// (a team, or a bot moved onto another desk), and containerName(botId) survives
// only as the fallback for a bot that has no computer row yet. Reads two JSON
// files — no docker, no live desk — so it holds for EVERY bot, not just whichever
// one a live run happened to select.
//
// Deliberately NOT asserted: container === containerForId(computer.id). That
// holds only for desks newComputer() named itself. migrateFromBots() adopts the
// container a bot already had (AikaBotto: computer 316f4d5d… keeps the older
// bot-derived localbot-6d6cfe52), and a Cloud desk carries its own name
// (localbot-cloud-cm). The invariant is bot -> computer row -> container; where
// that name originally came from is history, not a rule.
test("every bot's container comes from its computer, not its bot id", async () => {
  const computers = await listComputers();
  const all = await store.loadBots();
  let checked = 0;
  for (const b of all) {
    if (!b.vm?.container) continue;
    const row = computerForBot(computers, b);
    assert.ok(row, `${b.name} has a container but no computer row`);
    assert.equal(b.vm.container, row.container, `${b.name}: container must come from its computer row`);
    checked += 1;
  }
  assert.ok(checked > 0, "no bot had a container to check");
});

test("a bot with no computer yet falls back to a container named for its id", () => {
  const fresh = { id: "0ff70ec2-e3af-4915-8155-8bedb18302f3", vm: {} };
  assert.equal(vm.containerName(fresh.id), "localbot-0ff70ec2");
  assert.equal(vm.vmNames(fresh).name, "localbot-0ff70ec2");
});

live("screenshot is a real PNG from the VM", async () => {
  const shot = await vm.screenshot(bot);
  assert.ok(shot.buf[0] === 0x89 && shot.buf[1] === 0x50);
  assert.ok(shot.bytes > 500);
  assert.equal(shot.width, 1024);
  assert.equal(shot.height, 768);
});

live("mouse move reports location", async () => {
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

live("click empty desktop does not throw", async () => {
  await vm.click(bot, 900, 700, 1, 1);
});

live("double-click does not throw", async () => {
  await vm.click(bot, 880, 680, 1, 2);
});

test("wait helper", async () => {
  const t = Date.now();
  await vm.wait(200);
  assert.ok(Date.now() - t >= 180);
});

live("clipboard write then read", async () => {
  await vm.clipboardWrite(bot, "LOCALBOT_CLIP_OK");
  const got = await vm.clipboardRead(bot);
  assert.match(got, /LOCALBOT_CLIP_OK/);
});

live("type via clipboard paste", async () => {
  await vm.click(bot, 900, 40, 1, 1);
  await vm.typeText(bot, "vm-type-ok");
});

live("key Escape is safe", async () => {
  await vm.key(bot, "Escape");
});

live("scroll does not throw", async () => {
  await vm.scroll(bot, 512, 400, 80, 0);
});

live("small drag does not throw", async () => {
  await vm.drag(bot, 400, 300, 430, 320);
});

live("inside shell: whoami is abc", async () => {
  const r = await vm.shell(bot, "whoami");
  assert.match(r.output, /abc/);
});

live("inside shell: hostname is computer", async () => {
  const r = await vm.shell(bot, "hostname");
  assert.match(r.output, /computer/);
});

live("inside shell: host /Users is not mounted", async () => {
  const r = await vm.shell(bot, "test ! -e /Users; echo $?");
  assert.match(r.output.trim(), /0$/);
});

live("inside shell: /config is home", async () => {
  const r = await vm.shell(bot, "ls /config | head");
  assert.ok(r.ok);
  assert.ok(r.output.length > 0);
});

live("inside shell: DISPLAY is :1", async () => {
  const r = await vm.shell(bot, "echo $DISPLAY");
  assert.match(r.output, /:1/);
});

live("Chrome exists in the VM", async () => {
  const r = await vm.shell(bot, "command -v google-chrome-stable || command -v google-chrome || command -v chrome-desktop");
  assert.ok(/chrome/i.test(r.output));
});

live("Grok Build is not required inside the VM", async () => {
  const r = await vm.shell(bot, "command -v grok || echo no-grok");
  assert.ok(r.ok);
  assert.match(r.output, /grok|no-grok/i);
});

live("AGENTS.md is installed in the VM", async () => {
  const r = await vm.shell(bot, "test -f /config/AGENTS.md && wc -c /config/AGENTS.md");
  assert.ok(r.ok);
});

live("open Chrome via inside command", async () => {
  await vm.shell(bot, "pkill -f 'chrome|chromium' >/dev/null 2>&1 || true");
  await vm.wait(400);
  const r = await vm.shell(bot, "DISPLAY=:1 /usr/local/bin/chrome-desktop >/tmp/chrome.log 2>&1 & echo $!");
  assert.ok(r.ok);
  await vm.wait(2500);
  const procs = await vm.shell(bot, "pgrep -af chrome | head -3");
  assert.match(procs.output, /chrome/i);
});

live("screenshot after Chrome still 1024x768", async () => {
  const shot = await vm.screenshot(bot);
  assert.equal(shot.width, 1024);
  assert.equal(shot.height, 768);
});

live("click Chrome desktop icon (outside tunnel)", async () => {
  await vm.key(bot, "super+d");
  await vm.wait(400);
  await vm.click(bot, 55, 268, 1, 2);
  await vm.wait(1500);
  const shot = await vm.screenshot(bot);
  assert.ok(shot.bytes > 500);
});

live("type into a form-like field (ctrl+l then URL)", async () => {
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

live("stream health reports VM apps", async () => {
  const h = await vm.streamHealth(bot);
  assert.equal(h.container, bot.vm.container);
  assert.equal(h.running, true);
  assert.ok(h.grok || h.chrome);
});

// A desk that is merely paused, or whose host port drifted, is still a healthy
// desk. Both used to read as "Chrome is not ready yet" forever.
live("stream health survives a stale novnc port", async () => {
  const real = (await vm.streamHealth(bot)).novncPort;
  assert.ok(real, "desk should report a mapped port");
  const stale = { ...bot, vm: { ...bot.vm, novncPort: real + 7 } };
  const h = await vm.streamHealth(stale);
  assert.equal(h.novncPort, real, "health should re-detect the mapped port");
  assert.equal(h.ok, true);
});

live("a paused desk is woken, not waited on", async () => {
  if (!ALLOW_PAUSE) return SKIP;
  const name = bot.vm.container;
  // `docker pause` freezes a real desk and only the finally below thaws it —
  // which a SIGKILL, a `timeout` kill, or a crash never reaches, stranding the
  // container paused for whoever owns it. Register the recovery with the process
  // itself (synchronously, as exit handlers must be) so an abnormal end still
  // unpauses. Only SIGKILL can now get past this.
  const thaw = () => {
    try {
      const st = execFileSync("docker", ["inspect", "-f", "{{.State.Paused}}", name], { encoding: "utf8" });
      if (st.trim() === "true") execFileSync("docker", ["unpause", name], { stdio: "ignore" });
    } catch {
      /* nothing an exit handler can do about it */
    }
  };
  const onSignal = (sig) => {
    thaw();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("exit", thaw);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  execFileSync("docker", ["pause", name], { stdio: "ignore" });
  try {
    const paused = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" });
    assert.equal(paused.trim(), "true", "paused containers still report Running=true");
    const seen = [];
    const r = await vm.waitForDesktop({ ...bot }, { timeoutMs: 120_000, onLog: (m) => seen.push(m) });
    const h = await vm.streamHealth({ ...bot });
    assert.equal(
      r.ok,
      true,
      `${r.reason || "desk should come back"} | log: ${[...new Set(seen)].join(" / ")} | health: ${JSON.stringify({ running: h.running, port: h.novncPort, http: h.http, x11: h.x11, chrome: h.chrome })} | stored: ${bot.vm.novncPort}`,
    );
  } finally {
    thaw();
    process.off("exit", thaw);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
});

let failed = 0;
let skipped = 0;
for (const { name, fn } of results) {
  try {
    const out = await fn();
    if (out === SKIP) {
      skipped += 1;
      console.log("SKIP", name);
      continue;
    }
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, "-", err.message.split("\n")[0]);
  }
}
const ran = results.length - skipped;
console.log(`\n${ran - failed}/${ran} passed${skipped ? `, ${skipped} skipped` : ""}`);
if (skipped) {
  console.log("Live-desk tests are opt-in: SUB8_TEST_DESK=<container>, plus SUB8_TEST_DESK_PAUSE=1 for the pause test.");
}
// waitForDesktop can publish the desk-brain proxy: a host-side net.Server that
// stays listening on purpose. In the app that is what you want; in a one-shot
// test process it keeps the event loop alive forever, so exit explicitly. This
// only ever showed up once the suite started passing — a failing run exited 1.
process.exit(failed ? 1 : 0);
