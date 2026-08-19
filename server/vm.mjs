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

const IMAGE = process.env.LOCALBOT_IMAGE || "linuxserver/webtop:ubuntu-xfce";
const START_PORT = 13100;

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
  if (/setup-apps|apt-get|\bapt\b/i.test(joined)) return true;
  return (opts.timeout || 0) >= 60_000;
}

export function dockerQueueStats() {
  return { short: shortDocker.stats(), long: longDocker.stats(), kids: dockerKids.size };
}

function run(cmd, args, opts = {}) {
  const { timeout, track, env, ...spawnOpts } = opts;
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
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
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

export function parseLocalbotPs(out) {
  const states = new Map();
  for (const line of String(out || "").split("\n")) {
    const [name, state, status] = line.split("\t");
    if (!name || !name.startsWith("localbot-")) continue;
    const paused = state === "paused" || /paused/i.test(status || "");
    let st = "exited";
    if (paused) st = "paused";
    else if (state === "running") st = "running";
    else if (state === "dead") st = "missing";
    else if (state === "created" || state === "exited") st = "exited";
    else if (state) st = state;
    states.set(name, { exists: true, status: st, running: st === "running", paused, stuck: false });
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
    const r = await docker(["ps", "-a", "--filter", "name=localbot-", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"], {
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
      if (await portFree(p)) return p;
    }
    throw new Error("No free noVNC port");
  });
  portLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

export async function ensureImage(onLog = () => {}) {
  const inspect = await docker(["image", "inspect", IMAGE], { timeout: 8_000 });
  if (inspect.ok) return;
  onLog(`Pulling desktop image ${IMAGE}…`);
  const pull = await docker(["pull", "--platform", dockerPlatform(), IMAGE], { timeout: 600_000 });
  if (!pull.ok) throw new Error(`docker pull failed: ${pull.out.slice(-800)}`);
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
    const port = bot.vm?.novncPort || (await detectMappedPort(name));
    const chrome = await chromeReady(name);
    finishDesktopSetup(name, onLog).catch((err) => onLog(String(err.message || err)));
    return {
      container: name,
      novncPort: port,
      status: chrome ? "running" : "starting",
      display: ":1",
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
  const runr = await docker([
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
  ], { timeout: 60_000 });
  if (!runr.ok) throw new Error(`docker run failed: ${runr.out.slice(-800)}`);
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
    display: ":1",
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
      ["exec", name, "bash", "-lc", "command -v google-chrome-stable || command -v google-chrome"],
      { timeout: 12_000 },
    );
    const ok = r.ok && /chrome/i.test(r.out || "");
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

export async function detectMappedPort(name) {
  const r = await docker(["port", name, "3000/tcp"], { timeout: 8_000 });
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
  const check = await docker(["exec", "-u", "root", name, "bash", "-lc", "command -v xdotool && command -v scrot"], {
    timeout: 20_000,
  });
  if (check.ok) return;
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
      await installOctoVault(name);
      await installAgentsMd(name, "");
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
  // Docker hands out a new host port whenever it restarts a container, so the
  // port we stored can point at nothing. Ask Docker again rather than deciding
  // a healthy desk is down.
  let port = bot.vm?.novncPort;
  let http = await probe(port);
  if (running && name && http !== 200 && http !== 401) {
    const fresh = await detectMappedPort(name);
    if (fresh && fresh !== port) {
      const status = await probe(fresh);
      if (status === 200 || status === 401) {
        port = fresh;
        http = status;
      }
    }
  }
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
        "xset q >/dev/null 2>&1 && echo X_OK",
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
      `export DISPLAY=:1 HOME=/config; mkdir -p /tmp; scrot -p -o ${dest} 2>/tmp/scrot.err || import -window root ${dest}`,
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
  const dest = String(url || "").trim();
  const arg = dest ? JSON.stringify(dest) : "";
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container,
    "bash",
    "-lc",
    `${displayEnv(bot)}; nohup /usr/local/bin/chrome-desktop ${arg} >/tmp/chrome-desktop.log 2>&1 & echo OPENED:$!; sleep 0.8`,
  ]);
  if (!r.ok) throw new Error(`open Chrome failed: ${r.out.slice(-400)}`);
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
