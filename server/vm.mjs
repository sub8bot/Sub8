import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireVm, assertVmShell } from "./isolation.mjs";
import * as trace from "./trace.mjs";
import { appRoot, fileRoot, dataDir } from "./paths.mjs";

function isWindows() {
  return process.platform === "win32" || process.env.OS === "Windows_NT";
}

export function dockerBin() {
  // Docker Desktop ships an extensionless `docker` sh-wrapper next to docker.exe.
  // Node's spawn on Windows can pick that file and fail to exec.
  if (isWindows()) return "docker.exe";
  const home = process.env.HOME || os.homedir() || "";
  const candidates = [
    process.env.DOCKER_BIN,
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    path.join(home, ".docker", "bin", "docker"),
    "/usr/bin/docker",
  ].filter(Boolean);
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p;
  }
  return "docker";
}

export function resolveDockerHost() {
  const env = String(process.env.DOCKER_HOST || "").trim();
  // Windows Docker Desktop uses context "desktop-linux"
  // (npipe:////./pipe/dockerDesktopLinuxEngine). Forcing docker_engine
  // or a Colima unix:// path makes docker pull return HTTP 500.
  if (isWindows()) {
    if (env && /colima|unix:\/\//i.test(env)) return "";
    if (env && /^npipe:\/\/\/\.\/\/pipe\/dockerDesktop/i.test(env)) return env;
    return "";
  }
  if (env && !/^unix:\/\/[A-Za-z]:/.test(env)) return env;
  const home = process.env.HOME || os.homedir() || "";
  const socks = [home && path.join(home, ".colima", "default", "docker.sock"), "/var/run/docker.sock"].filter(Boolean);
  for (const sock of socks) {
    if (fsSync.existsSync(sock)) return `unix://${sock}`;
  }
  return "unix:///var/run/docker.sock";
}

export function dockerPlatform() {
  return process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

export const SLIM_IMAGE = "sub8-desk:trixie";
export const FALLBACK_IMAGE = "linuxserver/webtop:ubuntu-xfce";
const START_PORT = 13100;

let resolvedImage = process.env.LOCALBOT_IMAGE || SLIM_IMAGE;

export function deskImage() {
  return resolvedImage;
}

export const DISPLAY_SLOTS = 8;

export function displayNum(bot) {
  const n = Number(String(bot?.vm?.display || ":1").replace(":", "").split(".")[0]);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(DISPLAY_SLOTS, Math.max(1, n));
}

export function debugPortFor(n = 1) {
  return 9221 + Number(n || 1);
}

export function deskMemory(memberCount) {
  if (process.env.LOCALBOT_MEMORY) return process.env.LOCALBOT_MEMORY;
  const n = Number(memberCount);
  if (!Number.isFinite(n) || n <= 1) return "2g";
  return `${Math.min(6, 2 + (n - 1))}g`;
}

export function deskShm() {
  return process.env.LOCALBOT_SHM || "256m";
}

export function parseDockerProgress(text) {
  const s = String(text || "");
  const pcts = [...s.matchAll(/(\d+)\s*%/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 100);
  if (pcts.length) return Math.max(...pcts);
  return null;
}

export function deskCreateArgs({ name, volume, port, image } = {}) {
  const img = image || resolvedImage || SLIM_IMAGE;
  const mem = deskMemory();
  const shm = deskShm();
  return [
    "run",
    "-d",
    "--platform",
    dockerPlatform(),
    "--name",
    name,
    "--hostname",
    "computer",
    "--restart",
    "unless-stopped",
    "--dns",
    "8.8.8.8",
    "--dns",
    "1.1.1.1",
    "--shm-size",
    shm,
    "--memory",
    mem,
    "--memory-swap",
    mem,
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
    `${port}-${port + DISPLAY_SLOTS - 1}:3000-${3000 + DISPLAY_SLOTS - 1}`,
    img,
  ];
}

function dockerEnv() {
  const env = { ...process.env };
  if (isWindows()) {
    if (/colima|unix:\/\//i.test(env.DOCKER_HOST || "")) delete env.DOCKER_HOST;
    return env;
  }
  const host = resolveDockerHost();
  if (host) env.DOCKER_HOST = host;
  const extras = ["/opt/homebrew/bin", "/usr/local/bin", path.join(env.HOME || os.homedir() || "", ".docker", "bin")];
  const prefix = extras.filter((p) => fsSync.existsSync(p)).join(path.delimiter);
  if (prefix) env.PATH = `${prefix}${path.delimiter}${env.PATH || "/usr/bin:/bin"}`;
  return env;
}

const dockerKids = new Set();

function makeLimiter(n) {
  let active = 0;
  const q = [];
  return {
    async acquire() {
      if (active < n) {
        active += 1;
        return;
      }
      await new Promise((resolve) => q.push(resolve));
    },
    release() {
      if (q.length) q.shift()();
      else active = Math.max(0, active - 1);
    },
    stats() {
      return { active, waiting: q.length };
    },
  };
}

const shortDocker = makeLimiter(2);
const longDocker = makeLimiter(1);

export function isLongDocker(args = [], opts = {}) {
  const joined = (Array.isArray(args) ? args : []).join(" ");
  if (/setup-apps|apt-get|\bapt\b|^build\b|^pull\b/i.test(joined)) return true;
  return (opts.timeout || 0) >= 60_000;
}

export function dockerQueueStats() {
  return { short: shortDocker.stats(), long: longDocker.stats(), kids: dockerKids.size };
}

function run(cmd, args, opts = {}) {
  const { timeout, track, env, onData, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: env || dockerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...spawnOpts,
    });
    if (track) track.add(child);
    let out = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (track) track.delete(child);
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = timeout
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          finish({ ok: false, out: "timeout", code: 124 });
        }, timeout)
      : null;
    const take = (d) => {
      const s = d.toString();
      out += s;
      try {
        onData?.(s);
      } catch {
        /* ignore */
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => finish({ ok: false, out: String(err), code: 1 }));
    child.on("close", (code) => finish({ ok: code === 0, out: out.trim(), code }));
  });
}

export async function docker(args, opts = {}) {
  const lim = isLongDocker(args, opts) ? longDocker : shortDocker;
  await lim.acquire();
  try {
    return await run(dockerBin(), args, { ...opts, track: dockerKids });
  } finally {
    lim.release();
  }
}

export function killHungDockerClients() {
  let n = 0;
  for (const child of [...dockerKids]) {
    try {
      child.kill("SIGKILL");
      n += 1;
    } catch {
      /* already gone */
    }
  }
  dockerKids.clear();
  return n;
}

let dockerStatusCache = { at: 0, value: null };
let lastGoodDocker = { at: 0, value: null };
let dockerFailStreak = 0;

function dockerInstallHint() {
  if (process.platform === "darwin") {
    return "Install Docker or start Colima. Sub8 needs Docker so each Bot can have a computer.";
  }
  if (process.platform === "win32") {
    return "Install Docker Desktop and wait until it is running. Sub8 needs Docker so each Bot can have a computer.";
  }
  return "Install Docker Engine and start the daemon. Sub8 needs Docker so each Bot can have a computer.";
}

function dockerDaemonHint() {
  if (process.platform === "darwin") {
    return "Docker is installed but not running. Start Colima (colima start) or open Docker Desktop.";
  }
  if (process.platform === "win32") {
    return "Docker is installed but not running. Open Docker Desktop and wait until it is ready.";
  }
  return "Docker is installed but the daemon is not running. Try: sudo systemctl start docker";
}

function dockerStuckHint() {
  if (process.platform === "darwin") {
    return "Docker stopped answering. Desks are probably still running inside Colima. Recover unsticks it without wiping files.";
  }
  return "Docker stopped answering. Desks are probably still running. Recover will retry and restart the engine if needed.";
}

function timedOut(r) {
  return Boolean(r && (r.code === 124 || /timeout/i.test(r.out || "")));
}

function hostBin(name) {
  const home = process.env.HOME || os.homedir() || "";
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    path.join(home, ".local", "bin", name),
  ];
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p;
  }
  return name;
}

function invalidateDockerCache() {
  dockerStatusCache = { at: 0, value: null };
  containerListCache = { at: 0, value: null };
  dockerFailStreak = 0;
}

let dockerStatusInflight = null;

async function dockerStatusFresh() {
  const now = Date.now();
  const cli = await docker(["version", "--format", "{{.Client.Version}}"], { timeout: 8_000 });
  const missing = !cli.ok && /enoent|not found|cannot find|is not recognized/i.test(cli.out || "");
  if (missing) {
    const value = { ok: false, cli: false, daemon: false, stuck: false, recover: true, hint: dockerInstallHint() };
    dockerStatusCache = { at: now, value };
    return value;
  }
  if (!cli.ok && timedOut(cli)) {
    return settleDockerStatus({ ok: false, cli: true, daemon: false, stuck: true, recover: true, hint: dockerStuckHint() });
  }
  const info = await docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 8_000 });
  const value = info.ok
    ? { ok: true, cli: true, daemon: true, stuck: false, recover: false, hint: "", engine: (info.out || "").trim() }
    : {
        ok: false,
        cli: true,
        daemon: false,
        stuck: timedOut(info),
        recover: true,
        hint: timedOut(info) ? dockerStuckHint() : dockerDaemonHint(),
      };
  return settleDockerStatus(value);
}

function settleDockerStatus(value) {
  if (value.ok) {
    dockerFailStreak = 0;
    lastGoodDocker = { at: Date.now(), value };
    dockerStatusCache = { at: Date.now(), value };
    return value;
  }
  dockerFailStreak += 1;
  const recentlyOk = lastGoodDocker.value && Date.now() - lastGoodDocker.at < 120_000;
  if (value.stuck && dockerFailStreak < 2 && recentlyOk) {
    const keep = { ...lastGoodDocker.value, stale: true };
    dockerStatusCache = { at: Date.now(), value: keep };
    return keep;
  }
  dockerStatusCache = { at: Date.now(), value };
  return value;
}

export async function dockerStatus() {
  const now = Date.now();
  if (dockerStatusCache.value && now - dockerStatusCache.at < 4000) return dockerStatusCache.value;
  if (dockerStatusInflight) return dockerStatusInflight;
  dockerStatusInflight = dockerStatusFresh().finally(() => {
    dockerStatusInflight = null;
  });
  return dockerStatusInflight;
}

export function parseDisplayPorts(ports) {
  const map = {};
  const re = /:(\d+)->(300[0-7])\/tcp/g;
  const s = String(ports || "");
  let m;
  while ((m = re.exec(s))) map[Number(m[2])] = Number(m[1]);
  return map;
}

/** Host noVNC port for display :N. Never fall back to :1's mapping for N>1. */
export function streamPortForDisplay(n, portMap, stored) {
  const slot = Number(n) >= 1 ? Number(n) : 1;
  const cport = 2999 + slot;
  if (portMap && portMap[cport]) return portMap[cport];
  if (slot <= 1) return (portMap && portMap[3000]) || stored || null;
  if (stored && portMap && stored === portMap[3000]) return null;
  return stored || null;
}

export function parseLocalbotPs(out) {
  const states = new Map();
  for (const line of String(out || "").split("\n")) {
    const [name, state, status, ports] = line.split("\t");
    if (!name || !name.startsWith("localbot-")) continue;
    // docker ps already knows the host port; reading it here keeps a remembered
    // port from outliving the mapping it came from.
    const portMap = parseDisplayPorts(ports);
    const novncPort = portMap[3000] || null;
    const paused = state === "paused" || /paused/i.test(status || "");
    let st = "exited";
    if (paused) st = "paused";
    else if (state === "running") st = "running";
    else if (state === "dead") st = "missing";
    else if (state === "created" || state === "exited") st = "exited";
    else if (state) st = state;
    states.set(name, { exists: true, status: st, running: st === "running", paused, stuck: false, novncPort, portMap });
  }
  return states;
}

let containerListCache = { at: 0, value: null };
let containerListInflight = null;

export async function listLocalbotStates({ force = false } = {}) {
  const now = Date.now();
  if (!force && dockerStatusCache.value?.stuck && now - dockerStatusCache.at < 4000) {
    return { ok: false, stuck: true, states: new Map() };
  }
  if (!force && containerListCache.value && now - containerListCache.at < 2000) return containerListCache.value;
  if (containerListInflight) return containerListInflight;
  containerListInflight = (async () => {
    const r = await docker(["ps", "-a", "--filter", "name=localbot-", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"], {
      timeout: 8_000,
    });
    const value = r.ok
      ? { ok: true, stuck: false, states: parseLocalbotPs(r.out) }
      : { ok: false, stuck: timedOut(r), states: new Map() };
    containerListCache = { at: Date.now(), value };
    return value;
  })().finally(() => {
    containerListInflight = null;
  });
  return containerListInflight;
}

export async function recoverDocker() {
  invalidateDockerCache();
  const killed = killHungDockerClients();
  let docker = await dockerStatusFresh();
  if (docker.ok) return { ok: true, action: "retry", killed, docker };

  if (process.platform === "darwin") {
    const colima = hostBin("colima");
    const listed = await run(colima, ["list"], { timeout: 12_000, env: dockerEnv() });
    const running = /\bRunning\b/i.test(listed.out || "");
    if (!running) {
      const start = await run(colima, ["start"], { timeout: 180_000, env: dockerEnv() });
      invalidateDockerCache();
      docker = await dockerStatusFresh();
      return { ok: docker.ok, action: "colima-start", killed, docker, log: (start.out || "").slice(-500) };
    }
    const rst = await run(colima, ["ssh", "--", "sudo", "service", "docker", "restart"], {
      timeout: 60_000,
      env: dockerEnv(),
    });
    await new Promise((r) => setTimeout(r, 2500));
    invalidateDockerCache();
    docker = await dockerStatusFresh();
    if (docker.ok) return { ok: true, action: "docker-restart", killed, docker, log: (rst.out || "").slice(-500) };
    const cr = await run(colima, ["restart"], { timeout: 180_000, env: dockerEnv() });
    invalidateDockerCache();
    docker = await dockerStatusFresh();
    return { ok: docker.ok, action: "colima-restart", killed, docker, log: (cr.out || "").slice(-500) };
  }

  if (isWindows()) {
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    if (fsSync.existsSync(exe)) {
      try {
        spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 8000));
      invalidateDockerCache();
      docker = await dockerStatusFresh();
      return { ok: docker.ok, action: "docker-desktop", killed, docker };
    }
  }

  return { ok: false, action: "retry", killed, docker };
}

export async function startExistingContainer(name) {
  if (!name) return { ok: false };
  const r = await docker(["start", name], { timeout: 30_000 });
  invalidateDockerCache();
  return { ok: r.ok, out: r.out };
}

export function containerName(botId) {
  return `localbot-${botId.slice(0, 8)}`;
}

const grokLoginJobs = new Map();
let hostLoginChild = null;

export function dockerSpawn(args, opts = {}) {
  return spawn(dockerBin(), args, {
    env: dockerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...opts,
  });
}

export function hostGrokAuthPath() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  return path.join(home, ".grok", "auth.json");
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
  const listed = await docker(["ps", "--format", "{{.Names}}", "--filter", "name=localbot-"], { timeout: 8_000 });
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
  const r = await docker(grokVmArgs(container, ["models"]), { timeout: 25_000 });
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
  const published = await docker(["ps", "--format", "{{.Ports}}"], { timeout: 8_000 });
  if (published.ok && new RegExp(`[:.]${port}->`).test(published.out || "")) return false;
  if (isWindows()) {
    const r = await run("cmd.exe", ["/c", `netstat -ano | findstr :${port}`]);
    return !r.ok || !String(r.out || "").trim();
  }
  const r = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return !r.ok || !r.out;
}

let portLock = Promise.resolve();

export async function allocatePort() {
  const run = portLock.then(async () => {
    for (let p = START_PORT; p < START_PORT + 80; p++) {
      let ok = true;
      for (let i = 0; i < DISPLAY_SLOTS; i++) {
        if (!(await portFree(p + i))) {
          ok = false;
          break;
        }
      }
      if (ok) return p;
    }
    throw new Error("No free noVNC port");
  });
  portLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

function progressLogger(onLog, prefix) {
  let last = 0;
  let lastPct = -1;
  return (chunk) => {
    const pct = parseDockerProgress(chunk);
    const now = Date.now();
    if (pct != null && pct !== lastPct && (now - last > 800 || pct === 100)) {
      last = now;
      lastPct = pct;
      onLog(`${prefix} ${pct}% — one-time download of the computer image.`);
      return;
    }
    if (now - last < 2000) return;
    const line = String(chunk)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^#\d+\s+\w+\s+sha256/.test(l))
      .pop();
    if (!line) return;
    last = now;
    onLog(`${prefix} ${line.slice(0, 140)}`);
  };
}

export async function ensureImage(onLog = () => {}) {
  const override = String(process.env.LOCALBOT_IMAGE || "").trim();
  if (override) {
    const inspect = await docker(["image", "inspect", override], { timeout: 8_000 });
    if (inspect.ok) {
      resolvedImage = override;
      return;
    }
    onLog(`Pulling desktop image ${override}… This is a one-time download.`);
    const pull = await docker(["pull", "--platform", dockerPlatform(), override], {
      timeout: 600_000,
      onData: progressLogger(onLog, "Downloading"),
    });
    if (!pull.ok) throw new Error(`docker pull failed: ${pull.out.slice(-800)}`);
    resolvedImage = override;
    return;
  }

  const haveSlim = await docker(["image", "inspect", SLIM_IMAGE], { timeout: 8_000 });
  if (haveSlim.ok) {
    resolvedImage = SLIM_IMAGE;
    return;
  }

  const ctx = path.resolve(fileRoot, "vm");
  onLog("Building the computer image (Debian 13, one-time). Later computers reuse it.");
  const built = await docker(["build", "--platform", dockerPlatform(), "-t", SLIM_IMAGE, "-f", "Dockerfile", "."], {
    timeout: 600_000,
    cwd: ctx,
    onData: progressLogger(onLog, "Building"),
  });
  if (built.ok) {
    resolvedImage = SLIM_IMAGE;
    onLog("Computer image is ready.");
    return;
  }

  onLog(`Slim image build failed, falling back to ${FALLBACK_IMAGE}…`);
  const pull = await docker(["pull", "--platform", dockerPlatform(), FALLBACK_IMAGE], {
    timeout: 600_000,
    onData: progressLogger(onLog, "Downloading"),
  });
  if (!pull.ok) throw new Error(`docker pull failed: ${pull.out.slice(-800)}`);
  resolvedImage = FALLBACK_IMAGE;
}

export function configVolume(bot) {
  return bot.vm?.volume || `localbot-config-${String(bot.id || "bot").slice(0, 8)}`;
}

export function vmNames(bot, computer) {
  const name = computer?.container || bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  const volume = computer?.volume || bot.vm?.volume || (bot.id ? configVolume(bot) : null);
  return { name, volume };
}

export async function inspectState(name) {
  if (!name) return { exists: false, status: "missing", running: false, paused: false, stuck: false };
  const list = await listLocalbotStates();
  if (list.stuck) return { exists: false, status: "unknown", running: false, paused: false, stuck: true };
  return list.states.get(name) || { exists: false, status: "missing", running: false, paused: false, stuck: false };
}

export async function pauseContainer(name) {
  const st = await inspectState(name);
  if (st.stuck) return { ok: false, error: "docker stuck", status: "unknown" };
  if (!st.exists) return { ok: false, error: "missing", status: "missing" };
  if (st.paused) return { ok: true, status: "paused" };
  if (!st.running) return { ok: false, error: "not running", status: st.status };
  const r = await docker(["pause", name], { timeout: 15_000 });
  if (!r.ok) return { ok: false, error: r.out || "pause failed", status: st.status };
  invalidateDockerCache();
  return { ok: true, status: "paused" };
}

export async function resumeContainer(name) {
  const st = await inspectState(name);
  if (st.stuck) return { ok: false, error: "docker stuck", status: "unknown" };
  if (!st.exists) return { ok: false, error: "missing", status: "missing" };
  if (!st.paused) return { ok: true, status: st.running ? "running" : st.status };
  const r = await docker(["unpause", name], { timeout: 15_000 });
  if (!r.ok) return { ok: false, error: r.out || "unpause failed", status: st.status };
  invalidateDockerCache();
  return { ok: true, status: "running" };
}

export async function rebootContainer(name) {
  if (!name) return { ok: false, error: "no container", status: "missing" };
  const st = await inspectState(name);
  if (st.stuck) return { ok: false, error: "docker stuck", status: "unknown" };
  if (!st.exists) return { ok: false, error: "missing", status: "missing" };
  if (st.paused) await docker(["unpause", name], { timeout: 15_000 });
  const r = await docker(["restart", "-t", "8", name], { timeout: 45_000 });
  invalidateDockerCache();
  if (!r.ok) return { ok: false, error: r.out || "restart failed", status: st.status };
  const port = await detectMappedPort(name);
  if (port) {
    try {
      await waitHttp(`http://127.0.0.1:${port}/`, 60_000, () => {}, async () => false);
    } catch (err) {
      return { ok: false, error: err.message || "desktop did not come back", status: "starting", novncPort: port };
    }
  }
  return { ok: true, status: "running", novncPort: port };
}

export async function stopContainer(name) {
  if (!name) return { ok: true, status: "missing" };
  const st = await inspectState(name);
  if (st.stuck) return { ok: false, error: "docker stuck", status: "unknown" };
  if (!st.exists) return { ok: true, status: "missing" };
  if (st.paused) await docker(["unpause", name], { timeout: 15_000 });
  await docker(["stop", "-t", "8", name], { timeout: 20_000 });
  await docker(["rm", "-f", name], { timeout: 15_000 });
  invalidateDockerCache();
  return { ok: true, status: "exited" };
}

function memToBytes(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^([\d.]+)\s*([KMGT]i?B)?/i);
  if (!m) return 0;
  const n = Number(m[1]) || 0;
  const u = (m[2] || "").toUpperCase();
  if (u.startsWith("G")) return n * 1024 * 1024 * 1024;
  if (u.startsWith("M")) return n * 1024 * 1024;
  if (u.startsWith("K")) return n * 1024;
  return n;
}

export async function containerStats(names = []) {
  const want = new Set(names.filter(Boolean));
  if (!want.size) return {};
  const r = await docker(
    ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}", ...want],
    { timeout: 8_000 },
  );
  const out = {};
  for (const line of (r.out || "").split("\n")) {
    const [name, mem, cpu] = line.split("\t");
    if (!name) continue;
    const [used, limit] = String(mem || "").split("/").map((x) => x.trim());
    const usedB = memToBytes(used);
    const limitB = memToBytes(limit);
    out[name] = {
      mem: used || mem || "",
      memLimit: limit || "",
      memBytes: usedB,
      limitBytes: limitB,
      memPct: limitB ? Math.min(100, Math.round((usedB / limitB) * 100)) : 0,
      cpu: cpu || "",
    };
  }
  return out;
}

export async function startVm(bot, onLog = () => {}, shouldAbort = async () => false) {
  const dock = await dockerStatus();
  if (!dock.ok) throw new Error(dock.hint);
  const name = bot.vm?.container || containerName(bot.id);
  const volume = bot.vm?.volume || configVolume(bot);
  const abortIfGone = async () => {
    if (!(await shouldAbort())) return;
    await docker(["rm", "-f", name], { timeout: 20_000 });
    throw new Error("bot deleted");
  };
  const existing = await inspectState(name);
  if (existing.stuck) throw new Error((await dockerStatus()).hint || "Docker stopped answering.");
  if (existing.paused) {
    await resumeContainer(name);
  }
  if (existing.exists && !existing.running && !existing.paused) {
    const started = await startExistingContainer(name);
    if (!started.ok) {
      onLog(`Could not resume ${name}, recreating…`);
      await docker(["rm", "-f", name], { timeout: 20_000 });
    }
  }
  const live = await inspectState(name);
  if (live.exists && (live.running || live.paused)) {
    await abortIfGone();
    const mapped = live.novncPort || (await detectMappedPort(name));
    const port = resolveStreamPort(bot.vm?.novncPort, mapped);
    const chrome = await chromeReady(name);
    finishDesktopSetup(name, onLog).catch((err) => onLog(String(err.message || err)));
    return {
      container: name,
      novncPort: port,
      status: chrome ? "running" : "starting",
      display: bot.vm?.display || ":1",
      volume,
      setup: setupProgress(name),
    };
  }
  if (live.exists) await docker(["rm", "-f", name], { timeout: 20_000 });

  await ensureImage(onLog);
  await abortIfGone();
  await docker(["volume", "create", volume], { timeout: 20_000 });
  const port = await allocatePort();
  onLog(`Starting computer on port ${port}…`);
  const runr = await docker(deskCreateArgs({ name, volume, port, image: resolvedImage }), { timeout: 60_000 });
  if (!runr.ok) throw new Error(`docker run failed: ${runr.out.slice(-800)}`);
  invalidateDockerCache();
  await abortIfGone();

  await waitHttp(`http://127.0.0.1:${port}/`, 90_000, onLog, shouldAbort);
  await abortIfGone();
  setSetup(name, 1, "Starting desktop");
  onLog(setupLine(setupProgress(name)));
  finishDesktopSetup(name, onLog).catch((err) => onLog(String(err.message || err)));
  const chrome = await chromeReady(name);
  return {
    container: name,
    novncPort: port,
    status: chrome ? "running" : "starting",
    display: bot.vm?.display || ":1",
    volume,
    setup: setupProgress(name),
  };
}

const SETUP_TOTAL = 4;
const setupJobs = new Map();

function setSetup(name, step, label, ready = false) {
  const job = setupJobs.get(name) || {};
  if (job.progress?.ready && !ready) return job.progress;
  const progress = { step, total: SETUP_TOTAL, label, ready };
  job.progress = progress;
  job.ready = ready;
  setupJobs.set(name, job);
  return progress;
}

export function setupProgress(name) {
  return setupJobs.get(name)?.progress || { step: 0, total: SETUP_TOTAL, label: "", ready: false };
}

const chromeCache = new Map();
const CHROME_TTL_MS = 12_000;

export async function chromeReady(name) {
  if (!name) return false;
  if (setupProgress(name).ready) return true;
  const now = Date.now();
  const hit = chromeCache.get(name);
  if (hit?.value === true) return true;
  if (hit?.inflight) return hit.inflight;
  if (hit && now - hit.at < CHROME_TTL_MS) return Boolean(hit.value);
  const inflight = (async () => {
    const r = await docker(
      [
        "exec",
        name,
        "bash",
        "-lc",
        "command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser",
      ],
      { timeout: 12_000 },
    );
    const ok = r.ok && /chrome|chromium/i.test(r.out || "");
    chromeCache.set(name, { at: Date.now(), value: ok, inflight: null });
    if (ok) setSetup(name, SETUP_TOTAL, "Ready", true);
    return ok;
  })();
  chromeCache.set(name, { at: hit?.at || now, value: Boolean(hit?.value), inflight });
  try {
    return await inflight;
  } finally {
    const cur = chromeCache.get(name);
    if (cur?.inflight === inflight) cur.inflight = null;
  }
}

function setupLine(p) {
  if (!p) return "Setting up the computer…";
  if (p.ready) return "Computer is ready.";
  return `Setting up the computer (${p.step}/${p.total}): ${p.label}`;
}

async function markReadyIfChrome(name, onLog) {
  if (setupProgress(name).ready) return true;
  if (!(await chromeReady(name))) return false;
  setSetup(name, SETUP_TOTAL, "Ready", true);
  onLog("Computer is ready.");
  return true;
}

async function finishDesktopSetup(name, onLog) {
  const job = setupJobs.get(name) || {};
  if (job.running) return job.running;
  const say = (step, label) => {
    if (setupProgress(name).ready) return setupProgress(name);
    const p = setSetup(name, step, label, false);
    onLog(setupLine(p));
    return p;
  };
  job.running = (async () => {
    try {
      say(1, "Starting desktop");
      say(2, "Installing click tools");
      await ensureTools(name, onLog);
      if (await markReadyIfChrome(name, onLog)) {
        ensureApps(name, onLog).catch((err) => onLog(String(err.message || err)));
        return;
      }
      say(3, "Installing Chrome");
      const iv = setInterval(() => {
        markReadyIfChrome(name, onLog).catch(() => {});
      }, 8000);
      try {
        await ensureApps(name, (m) => {
          if (setupProgress(name).ready) {
            onLog(m);
            return;
          }
          if (/Installing Google Chrome/i.test(m)) say(3, "Installing Chrome");
          else if (/RustDesk|Grok Build CLI|extra apps/i.test(m)) say(4, "Installing extra apps");
          else onLog(m);
        });
      } finally {
        clearInterval(iv);
      }
      await docker(
        [
          "exec",
          "-u",
          "abc",
          name,
          "bash",
          "-lc",
          `${displayEnv({ vm: { display: ":1" } })}; xrandr --size 1024x768 || true`,
        ],
        { timeout: 20_000 },
      );
      await markReadyIfChrome(name, onLog);
      if (!setupProgress(name).ready) {
        setSetup(name, SETUP_TOTAL, "Ready", true);
        onLog("Computer is ready.");
      }
    } catch (err) {
      if (!(await markReadyIfChrome(name, onLog))) {
        setSetup(name, setupProgress(name).step || 3, err.message || "setup failed", false);
      }
      throw err;
    } finally {
      job.running = null;
    }
  })();
  setupJobs.set(name, job);
  return job.running;
}

export async function detectMappedPort(name, containerPort = 3000) {
  const r = await docker(["port", name, `${containerPort}/tcp`], { timeout: 8_000 });
  const m = r.out.match(/:(\d+)/);
  return m ? Number(m[1]) : null;
}

// Docker's current mapping is the source of truth. A port we wrote down can
// still answer HTTP after a remap — it just belongs to a different desk.
export function resolveStreamPort(stored, mapped) {
  return mapped || stored || null;
}

export function cachedMappedPort(name) {
  if (!name || !containerListCache.value?.states) return null;
  return containerListCache.value.states.get(name)?.novncPort || null;
}

export function cachedPortMap(name) {
  if (!name || !containerListCache.value?.states) return null;
  return containerListCache.value.states.get(name)?.portMap || null;
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

let setupLock = Promise.resolve();
function withSetupLock(fn) {
  const run = setupLock.then(fn, fn);
  setupLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function ensureTools(name, onLog) {
  const check = await docker(
    [
      "exec",
      "-u",
      "root",
      name,
      "bash",
      "-lc",
      "ok=1; command -v box-input >/dev/null || command -v xdotool >/dev/null || ok=0; command -v ffmpeg >/dev/null || command -v scrot >/dev/null || ok=0; command -v xclip >/dev/null || ok=0; echo TOOLS_$ok",
    ],
    { timeout: 20_000 },
  );
  if (check.ok && /TOOLS_1/.test(check.out || "")) return;
  onLog("Installing computer-use tools…");
  const inst = await withSetupLock(() =>
    docker(
      [
        "exec",
        "-u",
        "root",
        name,
        "bash",
        "-lc",
        "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xdotool scrot wmctrl x11-apps xclip xsel >/tmp/apt.log 2>&1",
      ],
      { timeout: 120_000 },
    ),
  );
  if (!inst.ok) onLog(`tool install warning: ${inst.out.slice(-300)}`);
}

async function appsReady(name) {
  return chromeReady(name);
}

async function ensureApps(name, onLog) {
  if (await appsReady(name)) onLog("Chrome is already on the computer.");
  else onLog("Installing Chrome on the computer…");
  const scriptHost = path.resolve(fileRoot, "vm", "setup-apps.sh");
  const cp = await docker(["cp", scriptHost, `${name}:/tmp/setup-apps.sh`], { timeout: 15_000 });
  if (!cp.ok) throw new Error(`copy setup-apps failed: ${cp.out}`);
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const inst = await withSetupLock(() =>
      docker(["exec", "-u", "root", name, "bash", "/tmp/setup-apps.sh"], { timeout: 180_000 }),
    );
    last = inst.out || "";
    const tail = last.split("\n").filter(Boolean).slice(-2).join(" | ");
    if (tail) onLog(tail);
    if (inst.ok || (await appsReady(name))) {
      const auth = await pushHostGrokAuth(name);
      if (auth.ok) onLog("Grok session copied onto the computer.");
      await installOctoClick(name);
      await installChromeDesk(name);
      await installDeskDoctor(name);
      await installOctoVault(name);
      await installAgentsMd(name, "");
      await mkdirpInContainer(name, "/config/agent-data/workflows").catch(() => {});
      await mkdirpInContainer(name, "/config/workspace").catch(() => {});
      onLog("Computer is ready.");
      return;
    }
    onLog(`Still setting up the computer (${attempt}/4)…`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  throw new Error(`app install failed: ${last.slice(-800)}`);
}

export async function installOctoVault(container) {
  const host = path.resolve(fileRoot, "vm", "octo-vault.sh");
  const cp = await docker(["cp", host, `${container}:/tmp/octo-vault.sh`]);
  if (!cp.ok) return;
  await docker([
    "exec",
    "-u",
    "root",
    container,
    "bash",
    "-lc",
    "install -m 755 /tmp/octo-vault.sh /usr/local/bin/octo-vault && ln -sfn /usr/local/bin/octo-vault /usr/bin/octo-vault",
  ]);
}

export async function installOctoClick(container) {
  const clickHost = path.resolve(fileRoot, "vm", "octo-click.sh");
  const inputHost = path.resolve(fileRoot, "vm", "box-input.py");
  await docker(["cp", clickHost, `${container}:/tmp/octo-click.sh`]);
  const input = await docker(["cp", inputHost, `${container}:/tmp/box-input.py`]);
  await docker([
    "exec",
    "-u",
    "root",
    container,
    "bash",
    "-lc",
    "install -m 755 /tmp/octo-click.sh /usr/local/bin/octo-click" +
      (input.ok ? " && install -m 755 /tmp/box-input.py /usr/local/bin/box-input" : ""),
  ]);
}

export async function installChromeDesk(container) {
  const deskHost = path.resolve(fileRoot, "vm", "chrome-desktop.sh");
  const oneTabHost = path.resolve(fileRoot, "vm", "chrome-one-tab.py");
  const desk = await docker(["cp", deskHost, `${container}:/tmp/chrome-desktop.sh`]);
  const one = await docker(["cp", oneTabHost, `${container}:/tmp/chrome-one-tab.py`]);
  const parts = [];
  if (desk.ok) parts.push("install -m 755 /tmp/chrome-desktop.sh /usr/local/bin/chrome-desktop");
  if (one.ok) parts.push("install -m 755 /tmp/chrome-one-tab.py /usr/local/bin/chrome-one-tab");
  const disp = await docker(["cp", path.resolve(fileRoot, "vm", "desk-display.sh"), `${container}:/tmp/desk-display.sh`]);
  const page = await docker(["cp", path.resolve(fileRoot, "vm", "page-agent.py"), `${container}:/tmp/page-agent.py`]);
  if (disp.ok) parts.push("install -m 755 /tmp/desk-display.sh /usr/local/bin/desk-display");
  if (page.ok) parts.push("install -m 755 /tmp/page-agent.py /usr/local/bin/page-agent");
  if (!parts.length) return;
  parts.push("ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/chrome");
  parts.push("ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/box-chrome");
  await docker(["exec", "-u", "root", container, "bash", "-lc", parts.join(" && ")]);
}

export async function installDeskDoctor(container) {
  const doctorHost = path.resolve(fileRoot, "vm", "desk-doctor.sh");
  const debugHost = path.resolve(fileRoot, "vm", "reference", "debugging.md");
  const uiHost = path.resolve(fileRoot, "vm", "reference", "app-ui.md");
  const doc = await docker(["cp", doctorHost, `${container}:/tmp/desk-doctor.sh`]);
  await docker(["exec", "-u", "root", container, "bash", "-lc", "mkdir -p /config/reference && chown abc:abc /config/reference"]);
  if (doc.ok) {
    await docker([
      "exec",
      "-u",
      "root",
      container,
      "bash",
      "-lc",
      "install -m 755 /tmp/desk-doctor.sh /usr/local/bin/desk-doctor && ln -sfn /usr/local/bin/desk-doctor /usr/local/bin/box-doctor",
    ]);
  }
  await docker(["cp", debugHost, `${container}:/config/reference/debugging.md`]).catch(() => {});
  await docker(["cp", uiHost, `${container}:/config/reference/app-ui.md`]).catch(() => {});
  await docker([
    "exec",
    "-u",
    "root",
    container,
    "bash",
    "-lc",
    "chown -R abc:abc /config/reference",
  ]);
}

export async function writeFileToContainer(container, dest, text) {
  const tmp = path.join(os.tmpdir(), `sub8-vm-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fs.writeFile(tmp, String(text ?? ""), "utf8");
  try {
    const cp = await docker(["cp", tmp, `${container}:${dest}`]);
    if (!cp.ok) throw new Error(cp.out || `copy ${dest} failed`);
    await docker(["exec", "-u", "root", container, "bash", "-lc", `chown abc:abc ${JSON.stringify(dest)} 2>/dev/null || true`]);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function mkdirpInContainer(container, dir) {
  const d = String(dir || "");
  if (!d.startsWith("/config")) throw new Error("mkdir must be under /config");
  await docker([
    "exec",
    "-u",
    "abc",
    "-e",
    "HOME=/config",
    container,
    "bash",
    "-lc",
    `mkdir -p ${JSON.stringify(d)}`,
  ]);
}

export async function readFileFromContainer(container, dest) {
  const r = await docker([
    "exec",
    "-u",
    "abc",
    container,
    "bash",
    "-lc",
    `if [ -f ${JSON.stringify(dest)} ]; then cat ${JSON.stringify(dest)}; else echo -n ""; fi`,
  ]);
  return r.ok ? String(r.out || "") : "";
}

export async function installAgentsMd(container, extra = "") {
  const host = path.resolve(appRoot, "prompts", "grok-build-vm.txt");
  const control = path.resolve(appRoot, "prompts", "computer-control.txt");
  const caps = path.resolve(appRoot, "prompts", "capabilities.txt");
  const base = await fs.readFile(host, "utf8").catch(() => "");
  const how = await fs.readFile(control, "utf8").catch(() => "");
  const can = await fs.readFile(caps, "utf8").catch(() => "");
  const body = `${base}\n${can}\n${how}\n${extra}\n`;
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

export async function stopVm(bot, { wipe = false } = {}) {
  const name = bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  if (name) await docker(["rm", "-f", name]);
  if (wipe) {
    const volume = bot.vm?.volume || (bot?.id ? configVolume(bot) : null);
    if (volume) await docker(["volume", "rm", "-f", volume]);
  }
}

/** Remove localbot-* containers and config volumes that do not belong to a known bot. */
export async function sweepOrphans(keepNames = [], keepVolumes = []) {
  const keep = new Set(keepNames.filter(Boolean));
  const keepVol = new Set(keepVolumes.filter(Boolean));
  // Empty bot list = new data dir. Never delete every computer.
  if (keep.size === 0 && keepVol.size === 0) return [];
  const removed = [];
  if (keep.size) {
    const inspect = await docker([
      "ps",
      "-a",
      "--filter",
      "name=localbot-",
      "--format",
      "{{.Names}}",
    ]);
    for (const name of inspect.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (!name.startsWith("localbot-") || keep.has(name)) continue;
      await docker(["rm", "-f", name]);
      removed.push(name);
    }
  }
  if (keepVol.size) {
    const vols = await docker(["volume", "ls", "-q"]);
    for (const name of (vols.out || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (!name.startsWith("localbot-config-") || keepVol.has(name)) continue;
      const drop = await docker(["volume", "rm", "-f", name]);
      if (drop.ok) removed.push(name);
    }
  }
  return removed;
}

export async function streamHealth(bot) {
  const name = bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  const inspect = name ? await docker(["inspect", "-f", "{{.State.Running}}", name]) : { ok: false, out: "" };
  const running = inspect.ok && inspect.out.trim() === "true";
  const probe = async (p) => {
    if (!p) return 0;
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(3000) });
      return res.status;
    } catch {
      return 0;
    }
  };
  // Ask Docker first. Probing the stored port and treating HTTP 200 as "ours"
  // steals another desk's stream after a remap (stored 13100, mapped 13101).
  let mapped = null;
  let portMap = null;
  if (running && name) {
    const st = await inspectState(name);
    mapped = st.novncPort || (await detectMappedPort(name));
    portMap = st.portMap || null;
    if (!portMap || !Object.keys(portMap).length) {
      portMap = mapped ? { 3000: mapped } : {};
      const n = displayNum(bot);
      if (n > 1) {
        const extra = await detectMappedPort(name, 2999 + n);
        if (extra) portMap[2999 + n] = extra;
      }
    }
  }
  const port = streamPortForDisplay(displayNum(bot), portMap, bot.vm?.novncPort) || (displayNum(bot) <= 1 ? mapped : null);
  const http = await probe(port);
  let grok = false;
  let chrome = name ? setupProgress(name).ready || chromeCache.get(name)?.value === true : false;
  if (running && name && !chrome) chrome = await chromeReady(name);
  let x11 = false;
  if (running && name) {
    const xr = await docker(
      [
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
        "(xdpyinfo >/dev/null 2>&1 || xset q >/dev/null 2>&1) && echo X_OK",
      ],
      { timeout: 8_000 },
    );
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
  const dock = await dockerStatus();
  if (!dock.ok) return { ok: false, reason: dock.hint };
  const start = Date.now();
  const gone = async () => Boolean(shouldAbort && (await shouldAbort()));
  const name = bot.vm?.container || containerName(bot.id);
  // A paused container still reports State.Running=true, but every exec into it
  // fails, so the desk can never look ready. Wake it before waiting on it.
  const inspect = await docker(["inspect", "-f", "{{.State.Running}} {{.State.Paused}}", name], { timeout: 8_000 });
  const [wasRunning, wasPaused] = inspect.out.trim().split(/\s+/);
  if (inspect.ok && wasPaused === "true") {
    onLog("Waking the computer…");
    await resumeContainer(name);
  }
  let alive = inspect.ok && wasRunning === "true" && wasPaused !== "true";
  if (!alive && inspect.ok && wasPaused === "true") {
    const woke = await docker(["inspect", "-f", "{{.State.Running}} {{.State.Paused}}", name], { timeout: 8_000 });
    alive = woke.ok && woke.out.trim() === "true false";
  }
  if (!alive) {
    onLog("Starting computer…");
    const grace = Date.now() + 25_000;
    while (Date.now() < grace && !(await gone())) {
      const again = await docker(["inspect", "-f", "{{.State.Running}}", name]);
      if (again.ok && again.out.trim() === "true") {
        alive = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!alive) {
    try {
      const info = await startVm(bot, onLog, shouldAbort);
      bot.vm = { ...bot.vm, ...info, error: null };
    } catch (err) {
      return { ok: false, reason: err.message || "Could not start the computer." };
    }
  }
  while (Date.now() - start < timeoutMs) {
    if (await gone()) return { ok: false, reason: "aborted" };
    const h = await streamHealth(bot);
    const box = bot.vm?.container || name;
    if (h.ok) {
      if (h.chrome || setupProgress(box).ready || (await chromeReady(box))) {
        setSetup(box, SETUP_TOTAL, "Ready", true);
        return { ok: true, health: { ...h, chrome: true }, setup: setupProgress(box) };
      }
      finishDesktopSetup(box, onLog).catch((err) => onLog(String(err.message || err)));
      const p = setupProgress(box);
      onLog(p.label ? setupLine(p) : "Setting up the computer: Installing Chrome…");
    } else {
      const why = !h.running ? "container not running" : !h.http ? "stream not up" : !h.x11 ? "display not ready" : "not ready";
      onLog(`Waiting for desktop (${why})…`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  const p = setupProgress(bot.vm?.container || name);
  return {
    ok: false,
    reason: p.label
      ? `Still ${setupLine(p)}. Chrome is not ready yet.`
      : "Desktop did not become ready in time. Open the computer pane or try again.",
    setup: p,
  };
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
    await fs.unlink(tmp).catch(() => {});
    return buf;
  } catch {
    return null;
  }
}

export function screenshotCmd(dest) {
  return [
    `ffmpeg -y -nostdin -loglevel error -f x11grab -video_size ${SCREEN_W}x${SCREEN_H} -i "\${DISPLAY}.0" -frames:v 1 -update 1 ${dest}`,
    `scrot -o ${dest}`,
    `import -window root ${dest}`,
    `xwd -root -silent | convert xwd:- png:${dest}`,
  ].join(" || ");
}

async function takeScreenshotPng(bot, name, dest) {
  return docker([
    "exec",
    "-u",
    "abc",
    name,
    "bash",
    "-lc",
    `${displayEnv(bot)}; xrandr --size ${SCREEN_W}x${SCREEN_H} >/dev/null 2>&1 || true; mkdir -p /tmp; ${screenshotCmd(dest)}`,
  ]);
}

function missingShotTool(out = "") {
  return /not found|No such file|Unrecognized option|Invalid argument/i.test(out) && /ffmpeg|scrot|import|xwd|convert/i.test(out);
}

export function computerPreviewPath(id) {
  return path.resolve(dataDir, "screens", `computer-${id}.png`);
}

export async function screenshotContainer(name, hostPath) {
  if (!name) return { ok: false, error: "no container" };
  const dest = `/tmp/cprev-${Date.now()}.png`;
  const r = await docker(
    [
      "exec",
      "-u",
      "abc",
      name,
      "bash",
      "-lc",
      `export DISPLAY=:1 HOME=/config; mkdir -p /tmp; ${screenshotCmd(dest)}`,
    ],
    { timeout: 15_000 },
  );
  if (!r.ok) return { ok: false, error: r.out || "scrot failed" };
  await fs.mkdir(path.dirname(hostPath), { recursive: true });
  const cp = await docker(["cp", `${name}:${dest}`, hostPath], { timeout: 10_000 });
  if (!cp.ok) return { ok: false, error: cp.out || "copy failed" };
  return { ok: true, path: hostPath };
}

export async function screenshot(bot) {
  const name = requireVm(bot, "screenshot");
  await ensureBotDisplay(bot).catch(() => {});
  return withDeskLock(name, () => trace.span(bot, "outside", "screenshot", {}, async () => {
    await focusOwnedWindow(bot);
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
  }), bot.vm?.display);
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
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input move ${p.x} ${p.y}; else unset WINDOW; xdotool mousemove --screen 0 ${p.x} ${p.y}; fi`,
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
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input location; else xdotool getmouselocation --shell; fi`,
  ]);
  const ptr = r.out.match(/POINTER=(\d+),(\d+)/);
  if (ptr) return { x: Number(ptr[1]), y: Number(ptr[2]), raw: r.out };
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
  await ensureBotDisplay(bot).catch(() => {});
  return withDeskLock(bot.vm.container, () => trace.span(bot, "outside", "click", { x: p.x, y: p.y, button, count }, async () => {
    await focusOwnedWindow(bot);
    const n = Math.max(1, Math.min(5, Math.round(count)));
    const r = await docker([
      "exec",
      "-u",
      "abc",
      bot.vm.container,
      "bash",
      "-lc",
      `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input click ${p.x} ${p.y} ${button} ${n}; elif [ -x /usr/local/bin/octo-click ]; then /usr/local/bin/octo-click ${p.x} ${p.y} ${button} ${n}; else ${pointerScript(p.x, p.y)}; xdotool click --clearmodifiers --repeat ${n} --delay 40 ${button}; eval "$(xdotool getmouselocation --shell)"; echo POINTER=$X,$Y; fi`,
    ]);
    if (!r.ok) throw new Error(`click failed: ${r.out.slice(-400)}`);
    await wait(160);
  }), bot.vm?.display);
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
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input move ${a.x} ${a.y}; /usr/local/bin/box-input down 1; /usr/local/bin/box-input move ${b.x} ${b.y}; /usr/local/bin/box-input up 1; else ${pointerScript(a.x, a.y)}; xdotool mousedown 1; xdotool mousemove --screen 0 ${b.x} ${b.y}; xdotool mouseup 1; fi`,
  ]);
  if (!r.ok) throw new Error(`drag failed: ${r.out.slice(-400)}`);
}

export async function typeText(bot, text) {
  await focusOwnedWindow(bot);
  if (!text) return;
  requireVm(bot, "type");
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input type-b64 ${b64}; else echo '${b64}' | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v; fi`,
  ]);
  if (!r.ok) throw new Error(`type failed: ${r.out.slice(-400)}`);
}

export async function key(bot, keys) {
  await focusOwnedWindow(bot);
  const seq = String(keys).trim().replace(/\+/g, "+");
  const safe = seq.replace(/[^A-Za-z0-9+_]/g, "");
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input key ${safe}; else xdotool key --clearmodifiers ${safe}; fi`,
  ]);
  if (!r.ok) throw new Error(`key failed: ${r.out.slice(-400)}`);
}

export async function scroll(bot, x, y, dy, dx = 0) {
  await mouseMove(bot, x, y);
  const vbtn = dy < 0 ? 4 : dy > 0 ? 5 : 0;
  const hbtn = dx < 0 ? 6 : dx > 0 ? 7 : 0;
  const vn = Math.min(16, Math.max(vbtn ? 1 : 0, Math.abs(Math.round(dy / 40)) || 0));
  const hn = Math.min(16, Math.max(hbtn ? 1 : 0, Math.abs(Math.round(dx / 40)) || 0));
  const clicker = (btn, n) =>
    n && btn
      ? `for i in $(seq 1 ${n}); do if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input down ${btn}; /usr/local/bin/box-input up ${btn}; else xdotool click ${btn}; fi; done;`
      : "";
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; ${clicker(vbtn, vn)} ${clicker(hbtn, hn)} true`,
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

/** Paste a secret into the focused field, then wipe the clipboard. Never logs the value. */
export async function pasteSecret(bot, text) {
  requireVm(bot, "paste");
  await clipboardWrite(bot, text);
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; wid=$(xdotool getwindowfocus); xdotool windowactivate "$wid" 2>/dev/null || true; xdotool key --clearmodifiers ctrl+v`,
  ]);
  await clipboardWrite(bot, "").catch(() => {});
  if (!r.ok) throw new Error("Could not paste into the focused field.");
}

export async function wait(ms) {
  await new Promise((r) => setTimeout(r, Math.max(0, Math.min(15000, ms))));
}

const deskChain = new Map();
export function withDeskLock(container, fn, display = "") {
  const key = `${container || "_"}:${display || ""}`;
  const prev = deskChain.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  deskChain.set(key, next.catch(() => {}));
  return next;
}

export async function ensureBotDisplay(bot) {
  const name = bot?.vm?.container;
  const n = displayNum(bot);
  if (!name || n <= 1) return { display: ":1" };
  const r = await docker(
    ["exec", "-u", "abc", "-e", "HOME=/config", name, "/usr/local/bin/desk-display", String(n)],
    { timeout: 20_000 },
  );
  if (!r.ok) throw new Error(`display :${n} failed: ${(r.out || "").slice(-400)}`);
  return { display: `:${n}`, out: r.out };
}

export function applyTeamDisplays(team, bots, basePort) {
  const ids = team?.memberIds || [];
  const byId = new Map((bots || []).map((b) => [b.id, b]));
  const chief = team?.chiefId ? byId.get(team.chiefId) : null;
  const rest = ids.map((id) => byId.get(id)).filter((b) => b && b.id !== team?.chiefId);
  const ordered = [chief, ...rest].filter(Boolean);
  let n = 1;
  for (const b of ordered) {
    if (n > DISPLAY_SLOTS) break;
    b.vm = {
      ...(b.vm || {}),
      display: `:${n}`,
      debugPort: debugPortFor(n),
    };
    if (n === 1 && basePort) b.vm.novncPort = basePort;
    n += 1;
  }
  return ordered;
}

export async function bindDisplayStreams(container, bots) {
  for (const b of bots || []) {
    const n = displayNum(b);
    const mapped = await detectMappedPort(container, 2999 + n);
    if (mapped) b.vm = { ...(b.vm || {}), novncPort: mapped };
    else if (n > 1) b.vm = { ...(b.vm || {}), novncPort: null };
  }
  return bots;
}

export async function scaleDeskMemory(container, memberCount) {
  if (!container) return;
  const mem = deskMemory(memberCount);
  await docker(["update", "--memory", mem, "--memory-swap", mem, container], { timeout: 15_000 });
}

export async function pageAgent(bot, { action = "snapshot", ref, text, url, keys, ms } = {}) {
  requireVm(bot, "browser");
  const n = displayNum(bot);
  const display = `:${n}`;
  const port = debugPortFor(n);
  await ensureBotDisplay(bot);
  if (action === "wait") {
    await wait(ms || 800);
    action = "snapshot";
  }
  if (action === "navigate" || action === "open") {
    await openChrome(bot, url || text || "");
    await wait(400);
    action = "snapshot";
  }
  const debug = `http://127.0.0.1:${port}`;
  const up = await docker(
    [
      "exec",
      "-u",
      "abc",
      bot.vm.container,
      "bash",
      "-lc",
      `curl -sf --max-time 1 ${debug}/json/version >/dev/null`,
    ],
    { timeout: 8_000 },
  );
  if (!up.ok) {
    await openChrome(bot, url || text || "https://www.google.com/");
    await wait(800);
  }
  return withDeskLock(bot.vm.container, async () => {
    const args = [action];
    if (action === "click" && ref != null) args.push(String(ref));
    if (action === "fill") {
      args.push(String(ref || ""), String(text || ""));
    }
    if (action === "press") args.push(String(keys || text || "Enter"));
    if (action === "navigate" || action === "open") {
      // already navigated; snapshot
      args.splice(0, args.length, "snapshot");
    }
    const r = await docker(
      [
        "exec",
        "-u",
        "abc",
        "-e",
        `DISPLAY=${display}`,
        "-e",
        "HOME=/config",
        "-e",
        `CHROME_DEBUG=${debug}`,
        bot.vm.container,
        "python3",
        "/usr/local/bin/page-agent",
        ...args,
      ],
      { timeout: 20_000 },
    );
    const out = String(r.out || "").trim();
    if (!r.ok) throw new Error(out.slice(-400) || "page-agent failed");
    return { text: out || "ok", display, port };
  }, display);
}

export function windowTag(bot) {
  return `Sub8:${String(bot?.id || "bot").slice(0, 8)}`;
}

export async function claimChromeWindow(bot) {
  const name = bot?.vm?.container;
  if (!name) return null;
  const tag = windowTag(bot);
  const r = await docker([
    "exec",
    "-u",
    "abc",
    name,
    "bash",
    "-lc",
    `${displayEnv(bot)}; TAG=${JSON.stringify(tag)};
tagwin() { w="$1"; [ -n "$w" ] || return 1; wmctrl -i -r "$w" -N "$TAG" 2>/dev/null || true; xdotool set_window --name "$TAG" "$w" 2>/dev/null || true; echo WINDOW=$w; }
HIT=$(wmctrl -l 2>/dev/null | awk -v t="$TAG" 'index($0,t){print $1; exit}')
if [ -n "$HIT" ]; then tagwin "$HIT"; exit 0; fi
# One computer → one Chrome, one tab. Never --new-window / --new-tab.
EXIST=$(wmctrl -lx 2>/dev/null | awk '/[Cc]hrom/{print $1; exit}')
if [ -n "$EXIST" ]; then tagwin "$EXIST"; exit 0; fi
if curl -sf --max-time 1 http://127.0.0.1:9222/json/version >/dev/null; then
  for i in 1 2 3 4 5 6; do
    EXIST=$(wmctrl -lx 2>/dev/null | awk '/[Cc]hrom/{print $1; exit}')
    if [ -n "$EXIST" ]; then tagwin "$EXIST"; exit 0; fi
    sleep 0.25
  done
  echo WINDOW=
  exit 0
fi
BEFORE=$(wmctrl -lx 2>/dev/null | awk '/[Cc]hrom/{print $1}')
if [ -x /usr/local/bin/chrome-desktop ]; then
  /usr/local/bin/chrome-desktop >/tmp/chrome-desk.log 2>&1 &
else
  CH=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)
  $CH --no-sandbox --disable-dev-shm-usage --disable-gpu --renderer-process-limit=2 --user-data-dir=/config/chrome-desk --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --no-first-run --start-maximized --window-position=0,0 --window-size=1024,768 >/tmp/chrome-desk.log 2>&1 &
fi
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 0.35
  AFTER=$(wmctrl -lx 2>/dev/null | awk '/[Cc]hrom/{print $1}')
  for w in $AFTER; do
    echo "$BEFORE" | grep -q "$w" && continue
    tagwin "$w"; exit 0
  done
done
w=$(wmctrl -lx 2>/dev/null | awk '/[Cc]hrom/{print $1; exit}')
if [ -n "$w" ]; then tagwin "$w"; exit 0; fi
echo WINDOW=
exit 1`,
  ]);
  const wid = (r.out.match(/WINDOW=(\S+)/) || [])[1] || "";
  if (!wid) return null;
  bot.vm = { ...(bot.vm || {}), windowId: wid, windowTitle: tag };
  return { windowId: wid, title: tag };
}

export async function focusOwnedWindow(bot) {
  if (!bot?.teamId || !bot?.vm?.container) return null;
  const claimed = await claimChromeWindow(bot).catch(() => null);
  const tag = windowTag(bot);
  await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; wmctrl -a ${JSON.stringify(tag)} 2>/dev/null || xdotool search --name ${JSON.stringify(tag)} windowactivate 2>/dev/null || true`,
  ]).catch(() => {});
  return claimed;
}

/** True if wmctrl/xdotool window text already shows this URL. */
export function urlLooksOpen(windowText, dest) {
  const d = String(dest || "").trim();
  if (!d) return true;
  const host = d
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/^www\./i, "")
    .split(":")[0];
  if (!host) return false;
  const t = String(windowText || "");
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(esc, "i").test(t)) return true;
  if (/mail\.google\.com/i.test(host) && /gmail/i.test(t)) return true;
  if (/wikipedia\.org/i.test(host) && /wikipedia/i.test(t)) return true;
  return false;
}

export async function openChrome(bot, url = "") {
  requireVm(bot, "open");
  await ensureBotDisplay(bot).catch(() => {});
  const port = debugPortFor(displayNum(bot));
  return withDeskLock(bot.vm.container, async () => {
  await focusOwnedWindow(bot);
  const dest = String(url || "").trim();
  const arg = dest ? JSON.stringify(dest) : "";
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; export CHROME_DEBUG=http://127.0.0.1:${port}; if curl -sf --max-time 1 "$CHROME_DEBUG/json/version" >/dev/null; then /usr/local/bin/chrome-desktop ${arg}; echo NAV=1; else nohup /usr/local/bin/chrome-desktop ${arg} >/tmp/chrome-desktop-${port}.log 2>&1 & echo OPENED:$!; sleep 1.2; fi`,
  ]);
  if (!r.ok) throw new Error(`open Chrome failed: ${r.out.slice(-400)}`);
  if (/NAV=1/.test(r.out || "")) return { text: dest ? `opened ${dest}` : "opened Chrome", out: r.out };
  if (bot.teamId && dest) {
    await key(bot, "ctrl+l");
    await wait(150);
    await typeText(bot, dest);
    await key(bot, "Return");
    await wait(400);
    return { text: `opened ${dest}`, out: r.out };
  }
  if (dest) {
    const titles = await docker([
      "exec",
      "-u",
      "abc",
      bot.vm.container,
      "bash",
      "-lc",
      `${displayEnv(bot)}; wmctrl -l 2>/dev/null; xdotool search --name . getwindowname %@ 2>/dev/null | head -40`,
    ]);
    const seen = String(titles.out || "");
    if (/chrome|chromium/i.test(seen) && !urlLooksOpen(seen, dest)) {
      await docker([
        "exec",
        "-u",
        "abc",
        bot.vm.container,
        "bash",
        "-lc",
        `${displayEnv(bot)}; wmctrl -a Chrome 2>/dev/null || wmctrl -a Chromium 2>/dev/null || xdotool search --name Chrome windowactivate 2>/dev/null || true; sleep 0.2`,
      ]);
      await key(bot, "ctrl+l");
      await wait(150);
      await typeText(bot, dest);
      await key(bot, "Return");
      await wait(400);
    }
  }
  return { text: dest ? `opened ${dest}` : "opened Chrome", out: r.out };
  }, bot.vm?.display);
}

export async function shell(bot, command) {
  requireVm(bot, "shell");
  assertVmShell(command);
  const cmd = String(command || "");
  if (/\b(google-chrome|chrome-desktop|chromium|xdg-open|firefox)\b/i.test(cmd)) {
    const url = (cmd.match(/https?:\/\/\S+/) || cmd.match(/file:\/\/\S+/) || [""])[0];
    const opened = await openChrome(bot, url.replace(/["']$/, ""));
    return { ok: true, output: opened.text };
  }
  return trace.span(bot, "inside", "shell", { command: cmd.slice(0, 180) }, async () => {
    const r = await docker([
      "exec",
      "-u",
      "abc",
      bot.vm.container,
      "bash",
      "-lc",
      `${displayEnv(bot)}; ${cmd}`,
    ]);
    return { ok: r.ok, output: r.out.slice(0, 8000) };
  });
}
