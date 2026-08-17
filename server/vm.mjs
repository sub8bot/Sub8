import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireVm, assertVmShell } from "./isolation.mjs";
import * as trace from "./trace.mjs";
import { appRoot, fileRoot, dataDir } from "./paths.mjs";

export function resolveDockerHost() {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  if (process.platform === "win32") return "npipe:////./pipe/docker_engine";
  const home = process.env.HOME || os.homedir() || "";
  const socks = [home && path.join(home, ".colima", "default", "docker.sock"), "/var/run/docker.sock"].filter(Boolean);
  for (const sock of socks) {
    if (fsSync.existsSync(sock)) return `unix://${sock}`;
  }
  return home ? `unix://${path.join(home, ".colima", "default", "docker.sock")}` : "unix:///var/run/docker.sock";
}

export function dockerPlatform() {
  return process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

const DOCKER_HOST = resolveDockerHost();
const IMAGE = process.env.LOCALBOT_IMAGE || "linuxserver/webtop:ubuntu-xfce";
const START_PORT = 13100;

function dockerEnv() {
  return { ...process.env, DOCKER_HOST };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: dockerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => resolve({ ok: false, out: String(err), code: 1 }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim(), code }));
  });
}

export function docker(args, opts) {
  return run("docker", args, opts);
}

export function containerName(botId) {
  return `localbot-${botId.slice(0, 8)}`;
}

const grokLoginJobs = new Map();
let hostLoginChild = null;

function dockerSpawn(args) {
  return spawn("docker", args, { env: dockerEnv(), stdio: ["ignore", "pipe", "pipe"] });
}

export function hostGrokAuthPath() {
  return path.join(process.env.HOME || "", ".grok", "auth.json");
}

export async function hostHasGrokAuth() {
  try {
    const raw = await fs.readFile(hostGrokAuthPath(), "utf8");
    const data = JSON.parse(raw);
    return Boolean(data && typeof data === "object" && Object.keys(data).length);
  } catch {
    return false;
  }
}

export async function pushHostGrokAuth(container) {
  const src = hostGrokAuthPath();
  if (!(await hostHasGrokAuth())) return { ok: false, error: "No Grok session on this Mac yet." };
  await docker(["exec", container, "bash", "-lc", "mkdir -p /config/.grok && chown abc:abc /config/.grok"]);
  const cp = await docker(["cp", src, `${container}:/config/.grok/auth.json`]);
  if (!cp.ok) return { ok: false, error: cp.out || "copy failed" };
  await docker([
    "exec",
    container,
    "bash",
    "-lc",
    "chown abc:abc /config/.grok/auth.json && chmod 600 /config/.grok/auth.json",
  ]);
  return grokSignedIn(container);
}

export async function pushHostGrokAuthAll() {
  const listed = await docker(["ps", "--format", "{{.Names}}", "--filter", "name=localbot-"]);
  const names = (listed.out || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.startsWith("localbot-"));
  const results = [];
  for (const name of names) results.push({ name, ...(await pushHostGrokAuth(name)) });
  return results;
}

export function startHostGrokOAuth() {
  if (hostLoginChild && !hostLoginChild.killed) return { started: true };
  hostLoginChild = spawn("grok", ["login", "--oauth"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  hostLoginChild.on("close", () => {
    hostLoginChild = null;
    pushHostGrokAuthAll().catch(() => {});
  });
  return { started: true };
}

export function grokVmArgs(container, grokArgs) {
  return [
    "exec",
    "-u",
    "abc",
    "-e",
    "HOME=/config",
    "-e",
    "DISPLAY=:1",
    "-w",
    "/config",
    container,
    "/usr/local/bin/grok",
    ...grokArgs,
  ];
}

export async function grokSignedIn(container) {
  await docker(["exec", container, "bash", "-lc", "chown -R abc:abc /config/.grok 2>/dev/null || true"]);
  const r = await docker(grokVmArgs(container, ["models"]));
  const t = (r.out || "").toLowerCase();
  if (/not signed in|not logged in|please log in|run `?grok login/i.test(t)) return { ok: false, out: r.out };
  if (r.ok && !/not signed in/i.test(t)) return { ok: true, out: r.out };
  return { ok: false, out: r.out };
}

export function startGrokOAuth(container) {
  const prev = grokLoginJobs.get(container);
  if (prev?.child && !prev.done) {
    return prev;
  }
  const job = { url: "", done: false, ok: false, out: "", child: null };
  grokLoginJobs.set(container, job);
  docker(["exec", container, "bash", "-lc", "chown -R abc:abc /config/.grok 2>/dev/null || true"]).catch(() => {});
  const child = dockerSpawn(grokVmArgs(container, ["login", "--oauth"]));
  job.child = child;
  const grabUrl = (chunk) => {
    job.out += chunk;
    const m = job.out.match(/https:\/\/auth\.x\.ai\/[^\s]+/);
    if (m && !job.url) {
      job.url = m[0];
      docker([
        "exec",
        "-u",
        "abc",
        "-e",
        "DISPLAY=:1",
        "-e",
        "HOME=/config",
        container,
        "bash",
        "-lc",
        `google-chrome --new-window ${JSON.stringify(job.url)} >/tmp/grok-oauth-chrome.log 2>&1 &`,
      ]).catch(() => {});
    }
  };
  child.stdout.on("data", (d) => grabUrl(d.toString()));
  child.stderr.on("data", (d) => grabUrl(d.toString()));
  child.on("close", (code) => {
    job.done = true;
    job.ok = code === 0;
    job.child = null;
  });
  child.on("error", (err) => {
    job.done = true;
    job.ok = false;
    job.out += String(err);
    job.child = null;
  });
  return job;
}

export function grokOAuthStatus(container) {
  const job = grokLoginJobs.get(container);
  if (!job) return { started: false, url: "", done: false, ok: false };
  return { started: true, url: job.url, done: job.done, ok: job.ok, out: (job.out || "").slice(-400) };
}

async function portFree(port) {
  const r = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return !r.ok || !r.out;
}

export async function allocatePort() {
  for (let p = START_PORT; p < START_PORT + 80; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error("No free noVNC port");
}

export async function ensureImage(onLog = () => {}) {
  const inspect = await docker(["image", "inspect", IMAGE]);
  if (inspect.ok) return;
  onLog(`Pulling desktop image ${IMAGE}…`);
  const pull = await docker(["pull", "--platform", dockerPlatform(), IMAGE]);
  if (!pull.ok) throw new Error(`docker pull failed: ${pull.out.slice(-800)}`);
}

function configVolume(bot) {
  return bot.vm?.volume || `localbot-config-${String(bot.id || "bot").slice(0, 8)}`;
}

export async function startVm(bot, onLog = () => {}, shouldAbort = async () => false) {
  const name = containerName(bot.id);
  const volume = configVolume(bot);
  const abortIfGone = async () => {
    if (!(await shouldAbort())) return;
    await docker(["rm", "-f", name]);
    throw new Error("bot deleted");
  };
  const existing = await docker(["inspect", "-f", "{{.State.Running}}", name]);
  if (existing.ok && existing.out === "true") {
    await abortIfGone();
    const port = bot.vm?.novncPort || (await detectMappedPort(name));
    await ensureTools(name, onLog);
    await abortIfGone();
    await ensureApps(name, onLog);
    await abortIfGone();
    return { container: name, novncPort: port, status: "running", display: ":1", volume };
  }
  if (existing.ok) await docker(["rm", "-f", name]);

  await ensureImage(onLog);
  await abortIfGone();
  await docker(["volume", "create", volume]);
  const port = await allocatePort();
  onLog(`Starting computer on port ${port}…`);
  const runr = await docker([
    "run",
    "-d",
    "--platform",
    dockerPlatform(),
    "--name",
    name,
    "--hostname",
    "computer",
    "--shm-size=1g",
    "-e",
    "PUID=1000",
    "-e",
    "PGID=1000",
    "-e",
    "TZ=America/New_York",
    "-e",
    "TITLE=My Computer",
    "-e",
    "SELKIES_MANUAL_WIDTH=1024",
    "-e",
    "SELKIES_MANUAL_HEIGHT=768",
    "-v",
    `${volume}:/config`,
    "-p",
    `${port}:3000`,
    IMAGE,
  ]);
  if (!runr.ok) throw new Error(`docker run failed: ${runr.out.slice(-800)}`);
  await abortIfGone();

  await waitHttp(`http://127.0.0.1:${port}/`, 90_000, onLog, shouldAbort);
  await abortIfGone();
  await ensureTools(name, onLog);
  await abortIfGone();
  await ensureApps(name, onLog);
  await abortIfGone();
  await docker([
    "exec",
    "-u",
    "abc",
    name,
    "bash",
    "-lc",
    `${displayEnv({ vm: { display: ":1" } })}; xrandr --size 1024x768 || true`,
  ]);
  return { container: name, novncPort: port, status: "running", display: ":1", volume };
}

async function detectMappedPort(name) {
  const r = await docker(["port", name, "3000/tcp"]);
  const m = r.out.match(/:(\d+)/);
  return m ? Number(m[1]) : null;
}

async function waitHttp(url, timeoutMs, onLog, shouldAbort) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldAbort && (await shouldAbort())) throw new Error("bot deleted");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 401) return;
    } catch {
      /* still booting */
    }
    onLog("Waiting for desktop…");
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Desktop did not become reachable");
}

async function ensureTools(name, onLog) {
  const check = await docker(["exec", "-u", "root", name, "bash", "-lc", "command -v xdotool && command -v scrot"]);
  if (check.ok) return;
  onLog("Installing computer-use tools…");
  const inst = await docker([
    "exec",
    "-u",
    "root",
    name,
    "bash",
    "-lc",
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xdotool scrot wmctrl x11-apps xclip xsel >/tmp/apt.log 2>&1",
  ]);
  if (!inst.ok) onLog(`tool install warning: ${inst.out.slice(-300)}`);
}

async function ensureApps(name, onLog) {
  const check = await docker([
    "exec",
    "-u",
    "root",
    name,
    "bash",
    "-lc",
    "command -v google-chrome-stable >/dev/null && command -v rustdesk >/dev/null && test -f /config/Desktop/RustDesk.desktop && test -f '/config/Desktop/Grok Build.desktop'",
  ]);
  if (!check.ok) onLog("Installing Chrome, RustDesk, and Grok Build on the computer…");
  else onLog("Updating Grok Build CLI on the computer…");
  const scriptHost = path.resolve(fileRoot, "vm", "setup-apps.sh");
  const cp = await docker(["cp", scriptHost, `${name}:/tmp/setup-apps.sh`]);
  if (!cp.ok) throw new Error(`copy setup-apps failed: ${cp.out}`);
  const inst = await docker(["exec", "-u", "root", name, "bash", "/tmp/setup-apps.sh"]);
  onLog(inst.out.split("\n").slice(-3).join(" | "));
  if (!inst.ok) throw new Error(`app install failed: ${inst.out.slice(-800)}`);
  const auth = await pushHostGrokAuth(name);
  if (auth.ok) onLog("Grok session copied onto the computer.");
  await installOctoClick(name);
  await installAgentsMd(name, "");
}

export async function installOctoClick(container) {
  const host = path.resolve(fileRoot, "vm", "octo-click.sh");
  const cp = await docker(["cp", host, `${container}:/tmp/octo-click.sh`]);
  if (!cp.ok) return;
  await docker([
    "exec",
    "-u",
    "root",
    container,
    "bash",
    "-lc",
    "install -m 755 /tmp/octo-click.sh /usr/local/bin/octo-click",
  ]);
}

export async function installAgentsMd(container, extra = "") {
  const host = path.resolve(appRoot, "prompts", "grok-build-vm.txt");
  const control = path.resolve(appRoot, "prompts", "computer-control.txt");
  const base = await fs.readFile(host, "utf8").catch(() => "");
  const how = await fs.readFile(control, "utf8").catch(() => "");
  const body = `${base}\n${how}\n${extra}\n`;
  const b64 = Buffer.from(body, "utf8").toString("base64");
  await docker([
    "exec",
    "-u",
    "abc",
    "-e",
    "HOME=/config",
    container,
    "bash",
    "-lc",
    `mkdir -p /config /config/.grok && echo ${JSON.stringify(b64)} | base64 -d > /config/AGENTS.md && cp /config/AGENTS.md /config/.grok/AGENTS.md && chown abc:abc /config/AGENTS.md /config/.grok/AGENTS.md`,
  ]);
}

export async function stopVm(bot) {
  const name = bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  if (!name) return;
  await docker(["rm", "-f", name]);
}

/** Remove localbot-* containers that do not belong to a known bot. */
export async function sweepOrphans(keepNames = []) {
  const keep = new Set(keepNames.filter(Boolean));
  // Empty bot list = new data dir. Never delete every computer.
  if (keep.size === 0) return [];
  const listed = await docker(["ps", "-aq", "--filter", "name=localbot-"]);
  if (!listed.ok || !listed.out.trim()) return [];
  const inspect = await docker([
    "ps",
    "-a",
    "--filter",
    "name=localbot-",
    "--format",
    "{{.Names}}",
  ]);
  const removed = [];
  for (const name of inspect.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!name.startsWith("localbot-") || keep.has(name)) continue;
    await docker(["rm", "-f", name]);
    removed.push(name);
  }
  return removed;
}

export async function streamHealth(bot) {
  const name = bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  const port = bot.vm?.novncPort;
  const inspect = name ? await docker(["inspect", "-f", "{{.State.Running}}", name]) : { ok: false, out: "" };
  const running = inspect.ok && inspect.out.trim() === "true";
  let http = 0;
  if (port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      http = res.status;
    } catch {
      http = 0;
    }
  }
  let grok = false;
  let chrome = false;
  if (running && name) {
    const apps = await docker([
      "exec",
      name,
      "bash",
      "-lc",
      "command -v grok; command -v google-chrome-stable || command -v google-chrome",
    ]);
    grok = /(^|\/)grok\b/.test(apps.out);
    chrome = /chrome/i.test(apps.out);
  }
  let x11 = false;
  if (running && name) {
    const xr = await docker([
      "exec",
      "-u",
      "abc",
      "-e",
      "HOME=/config",
      "-e",
      `DISPLAY=${bot.vm?.display || ":1"}`,
      name,
      "bash",
      "-lc",
      "xset q >/dev/null 2>&1 && echo X_OK",
    ]);
    x11 = /X_OK/.test(xr.out || "");
  }
  return {
    ok: running && (http === 200 || http === 401) && x11,
    container: name,
    running,
    novncPort: port || null,
    http,
    grok,
    chrome,
    x11,
    display: bot.vm?.display || ":1",
  };
}

export async function waitForDesktop(bot, { timeoutMs = 90_000, onLog = () => {}, shouldAbort } = {}) {
  const start = Date.now();
  const gone = async () => Boolean(shouldAbort && (await shouldAbort()));
  const name = containerName(bot.id);
  const inspect = await docker(["inspect", "-f", "{{.State.Running}}", name]);
  const alive = inspect.ok && inspect.out.trim() === "true";
  if (!alive) {
    onLog("Starting computer…");
    const info = await startVm(bot, onLog, shouldAbort);
    bot.vm = { ...bot.vm, ...info, error: null };
  }
  while (Date.now() - start < timeoutMs) {
    if (await gone()) return { ok: false, reason: "aborted" };
    const h = await streamHealth(bot);
    if (h.ok) return { ok: true, health: h };
    const why = !h.running ? "container not running" : !h.http ? "stream not up" : !h.x11 ? "display not ready" : "not ready";
    onLog(`Waiting for desktop (${why})…`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, reason: "Desktop did not become ready in time. Open the computer pane or try again." };
}

export async function resetVm(bot, onLog) {
  await stopVm(bot);
  return startVm({ ...bot, vm: { ...bot.vm, container: null } }, onLog);
}

function displayEnv(bot) {
  return `export DISPLAY=${bot.vm?.display || ":1"}; export XAUTHORITY=/config/.Xauthority; export HOME=/config`;
}

const SCREEN_W = 1024;
const SCREEN_H = 768;

export function clampPoint(x, y) {
  const cx = Math.round(Number(x));
  const cy = Math.round(Number(y));
  return {
    x: Number.isFinite(cx) ? Math.max(0, Math.min(SCREEN_W - 1, cx)) : 0,
    y: Number.isFinite(cy) ? Math.max(0, Math.min(SCREEN_H - 1, cy)) : 0,
  };
}

/** Keep the desktop at 1024x768 so click coords stay 1:1 with screenshots. */
export async function ensureDisplay(bot) {
  const name = bot.vm?.container;
  if (!name) return;
  await docker([
    "exec",
    "-u",
    "abc",
    name,
    "bash",
    "-lc",
    `${displayEnv(bot)}; xrandr --size 1024x768 >/dev/null 2>&1 || true`,
  ]);
}

function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function annotateShot(hostPath, x, y) {
  const script = path.resolve(appRoot, "scripts", "annotate-shot.py");
  const tmp = `${hostPath}.ann.png`;
  const r = await new Promise((resolve) => {
    const child = spawn("python3", [script, hostPath, tmp, String(Math.round(x)), String(Math.round(y))], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ ok: false, out: String(err) }));
    child.on("close", (code) => resolve({ ok: code === 0, out }));
  });
  if (!r.ok) return null;
  try {
    const buf = await fs.readFile(tmp);
    await fs.rename(tmp, hostPath);
    return buf;
  } catch {
    return null;
  }
}

async function takeScreenshotPng(bot, name, dest) {
  return docker([
    "exec",
    "-u",
    "abc",
    name,
    "bash",
    "-lc",
    `${displayEnv(bot)}; xrandr --size 1024x768 >/dev/null 2>&1 || true; mkdir -p /tmp; scrot -p -o ${dest} || import -window root ${dest}`,
  ]);
}

function missingShotTool(out = "") {
  return /scrot:.*(not found|command not found)|import:.*(not found|command not found)|command not found: (scrot|import)/i.test(out);
}

export async function screenshot(bot) {
  const name = requireVm(bot, "screenshot");
  return trace.span(bot, "outside", "screenshot", {}, async () => {
    const dest = `/tmp/shot-${Date.now()}.png`;
    let r = await takeScreenshotPng(bot, name, dest);
    if (!r.ok && missingShotTool(r.out)) {
      await ensureTools(name, () => {});
      r = await takeScreenshotPng(bot, name, dest);
    }
    if (!r.ok) throw new Error(`screenshot failed: ${r.out.slice(-400)}`);
    const hostPath = path.resolve(dataDir, "screens", `${bot.id}.png`);
    await fs.mkdir(path.dirname(hostPath), { recursive: true });
    const cp = await docker(["cp", `${name}:${dest}`, hostPath]);
    if (!cp.ok) throw new Error(`copy screenshot failed: ${cp.out}`);
    const raw = await fs.readFile(hostPath);
    const loc = await mouseLocation(bot).catch(() => ({ x: -1, y: -1 }));
    const annotated = await annotateShot(hostPath, loc.x, loc.y);
    const buf = annotated || raw;
    return { path: hostPath, ...pngSize(buf), bytes: buf.length, buf, pointer: loc };
  });
}

export async function mouseMove(bot, x, y) {
  requireVm(bot, "mouse");
  const p = clampPoint(x, y);
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; unset WINDOW; xdotool mousemove --screen 0 ${p.x} ${p.y}`,
  ]);
  if (!r.ok) throw new Error(`mousemove failed: ${r.out.slice(-400)}`);
}

export async function mouseLocation(bot) {
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; xdotool getmouselocation --shell`,
  ]);
  const x = Number((r.out.match(/X=(\d+)/) || [])[1] || -1);
  const y = Number((r.out.match(/Y=(\d+)/) || [])[1] || -1);
  return { x, y, raw: r.out };
}

function pointerScript(x, y) {
  return `
unset WINDOW
timeout 0.2 xdotool mousemove --sync --screen 0 ${x} ${y} >/dev/null 2>&1 \
  || xdotool mousemove --screen 0 ${x} ${y}
for i in 1 2 3 4 5; do
  eval "$(xdotool getmouselocation --shell)"
  dx=$((X - ${x})); dy=$((Y - ${y}))
  [ "\${dx#-}" -le 2 ] && [ "\${dy#-}" -le 2 ] && break
  xdotool mousemove --screen 0 ${x} ${y}
  sleep 0.03
done
wid=$(xdotool getmouselocation --shell | awk -F= '/^WINDOW=/{print $2}')
if [ -n "$wid" ] && [ "$wid" != "0" ]; then
  timeout 0.2 xdotool windowactivate --sync "$wid" >/dev/null 2>&1 \
    || xdotool windowactivate "$wid" >/dev/null 2>&1 || true
fi
unset WINDOW
`.trim();
}

export async function click(bot, x, y, button = 1, count = 1) {
  requireVm(bot, "click");
  const p = clampPoint(x, y);
  return trace.span(bot, "outside", "click", { x: p.x, y: p.y, button, count }, async () => {
    const n = Math.max(1, Math.min(5, Math.round(count)));
    const r = await docker([
      "exec",
      "-u",
      "abc",
      bot.vm.container,
      "bash",
      "-lc",
      `${displayEnv(bot)}; if [ -x /usr/local/bin/octo-click ]; then /usr/local/bin/octo-click ${p.x} ${p.y} ${button} ${n}; else ${pointerScript(p.x, p.y)}; xdotool click --clearmodifiers --repeat ${n} --delay 40 ${button}; eval "$(xdotool getmouselocation --shell)"; echo POINTER=$X,$Y; fi`,
    ]);
    if (!r.ok) throw new Error(`click failed: ${r.out.slice(-400)}`);
    await wait(160);
  });
}

export async function drag(bot, x1, y1, x2, y2) {
  const a = clampPoint(x1, y1);
  const b = clampPoint(x2, y2);
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; ${pointerScript(a.x, a.y)}; xdotool mousedown 1; xdotool mousemove --screen 0 ${b.x} ${b.y}; xdotool mouseup 1`,
  ]);
  if (!r.ok) throw new Error(`drag failed: ${r.out.slice(-400)}`);
}

export async function typeText(bot, text) {
  if (!text) return;
  requireVm(bot, "type");
  const escaped = String(text).replace(/'/g, `'\\''`);
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; wid=$(xdotool getwindowfocus); xdotool windowactivate "$wid" 2>/dev/null || true; xdotool type --clearmodifiers --delay 12 '${escaped}'`,
  ]);
  if (!r.ok) {
    const b64 = Buffer.from(String(text), "utf8").toString("base64");
    const t = await docker([
      "exec",
      "-u",
      "abc",
      bot.vm.container,
      "bash",
      "-lc",
      `${displayEnv(bot)}; echo '${b64}' | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v`,
    ]);
    if (!t.ok) throw new Error(`type failed: ${t.out.slice(-400)}`);
  }
}

export async function key(bot, keys) {
  const seq = String(keys).trim().replace(/\+/g, "+");
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; xdotool key --clearmodifiers ${seq}`,
  ]);
  if (!r.ok) throw new Error(`key failed: ${r.out.slice(-400)}`);
}

export async function scroll(bot, x, y, dy, dx = 0) {
  await mouseMove(bot, x, y);
  const vbtn = dy < 0 ? 4 : dy > 0 ? 5 : 0;
  const hbtn = dx < 0 ? 6 : dx > 0 ? 7 : 0;
  const vn = Math.min(16, Math.max(vbtn ? 1 : 0, Math.abs(Math.round(dy / 40)) || 0));
  const hn = Math.min(16, Math.max(hbtn ? 1 : 0, Math.abs(Math.round(dx / 40)) || 0));
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; ${vn && vbtn ? `for i in $(seq 1 ${vn}); do xdotool click ${vbtn}; done;` : ""} ${hn && hbtn ? `for i in $(seq 1 ${hn}); do xdotool click ${hbtn}; done;` : ""} true`,
  ]);
  if (!r.ok) throw new Error(`scroll failed: ${r.out.slice(-400)}`);
}

export async function clipboardRead(bot) {
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; xclip -selection clipboard -o 2>/dev/null || true`,
  ]);
  return r.out;
}

export async function clipboardWrite(bot, text) {
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; echo '${b64}' | base64 -d | xclip -selection clipboard`,
  ]);
  if (!r.ok) throw new Error(`clipboard write failed: ${r.out.slice(-400)}`);
}

export async function wait(ms) {
  await new Promise((r) => setTimeout(r, Math.max(0, Math.min(15000, ms))));
}

export async function shell(bot, command) {
  requireVm(bot, "shell");
  assertVmShell(command);
  if (/\b(google-chrome|chrome-desktop|chromium|xdg-open|firefox)\b/i.test(command) && /https?:\/\//i.test(command)) {
    throw new Error("Use the computer tool to click. Do not open URLs from the shell.");
  }
  return trace.span(bot, "inside", "shell", { command: String(command).slice(0, 180) }, async () => {
    const r = await docker([
      "exec",
      "-u",
      "abc",
      bot.vm.container,
      "bash",
      "-lc",
      `${displayEnv(bot)}; ${command}`,
    ]);
    return { ok: r.ok, output: r.out.slice(0, 8000) };
  });
}
