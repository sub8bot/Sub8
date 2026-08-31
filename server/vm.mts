import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { requireVm, assertVmShell } from "./isolation.mjs";
import * as trace from "@sub8/store/trace";
import { appRoot, fileRoot, dataDir } from "./paths.mjs";
import {
  DISPLAY_SLOTS,
  HARNESS_PORT,
  HARNESS_STDIO_BRIDGE,
  attachHarnessProxy,
  harnessHostPort,
  mappedHarnessPort,
  needsHarnessPublish,
  parseDisplayPorts,
  resolveStreamPort,
  streamPortForDisplay,
} from "@sub8/desk-ports";
import { deskRunArgs, limitsFromRamMb } from "@sub8/desk-runtime";

import type { ChildProcess, SpawnOptions, StdioNull, StdioOptions, StdioPipe } from "node:child_process";
import type { Server } from "node:net";
import type { HarnessRemote, PortMap } from "@sub8/desk-ports";
import type { HarnessBot } from "./desk-client.mjs";

/** Every progress line this file emits goes through one of these. */
export type LogFn = (line: string) => void;

/** What every `run`/`docker` call resolves to. `code` is null when a signal killed the child. */
export interface RunResult {
  ok: boolean;
  out: string;
  code: number | null;
}

/**
 * Options `run`/`docker` understand. Everything `run` does not destructure is
 * spread straight into `spawn`, which is why this widens SpawnOptions rather
 * than replacing it — `cwd` and friends still reach the child.
 */
export interface DockerOpts extends SpawnOptions {
  timeout?: number | undefined;
  track?: Set<ChildProcess> | undefined;
  onData?: ((chunk: string) => void) | undefined;
  /** Skip the limiter: a stop must never queue behind the command it is stopping. */
  jumpQueue?: boolean | undefined;
}

/** The `vm` record hung off a bot. Every field here is written by this file. */
export interface VmInfo {
  /**
   * No explicit `| undefined`: under exactOptionalPropertyTypes that is a wider
   * type than @sub8/store's `TraceBot.vm.container`, which `trace.span` checks
   * every computer-use bot against.
   */
  container?: string;
  volume?: string | null | undefined;
  display?: string | undefined;
  novncPort?: number | null | undefined;
  harnessPort?: number | null | undefined;
  hostHarnessPort?: number | null | undefined;
  debugPort?: number | undefined;
  deskUrl?: string | undefined;
  deskToken?: string | undefined;
  windowId?: string | undefined;
  windowTitle?: string | undefined;
  status?: string | undefined;
  setup?: SetupProgress | undefined;
  error?: string | null | undefined;
}

/**
 * As much of a bot record as this file reads. Deliberately a type alias, not an
 * interface: `trace.span` wants @sub8/store's TraceBot, whose index signature
 * only an object-literal type satisfies structurally.
 */
export type Bot = {
  id: string;
  teamId?: string | undefined;
  vm?: VmInfo | undefined;
};

/**
 * A bot at a computer-use entry point. `vm` is required: every one of these
 * either calls `requireVm` first — which throws unless `vm` carries a
 * `localbot-*` container or a cloud desk URL — or is only reached from one that
 * did (`scroll` goes through `mouseMove`, `mouseLocation` through `screenshot`).
 *
 * `container` stays optional because a cloud desk may not have one, and every
 * cloud branch returns before the `bot.vm.container!` below it. `drag`,
 * `clipboardRead` and `clipboardWrite` are the exceptions that check nothing of
 * their own and read it anyway — as they did before this file had types.
 */
export type DeskBot = {
  id: string;
  teamId?: string | undefined;
  vm: VmInfo;
};

/** `docker version` + `docker info`, as the UI reads it. */
export interface DockerStatus {
  ok: boolean;
  cli: boolean;
  daemon: boolean;
  stuck: boolean;
  recover: boolean;
  hint: string;
  engine?: string | undefined;
  daemonError?: string | undefined;
  stale?: boolean | undefined;
}

/** A DockerStatus plus the install-job fields the client polls alongside it. */
export type DecoratedDockerStatus = Partial<DockerStatus> & {
  platform: string;
  installing: boolean;
  installAction: string;
  installLog: string;
};

/** One `docker ps` row, keyed by container name. */
export interface ContainerState {
  exists: boolean;
  status: string;
  running: boolean;
  paused: boolean;
  stuck: boolean;
  novncPort?: number | null | undefined;
  harnessPort?: number | null | undefined;
  portMap?: PortMap | undefined;
}

/** The whole `docker ps` sweep: `states` is empty when docker did not answer. */
export interface LocalbotStates {
  ok: boolean;
  stuck: boolean;
  states: Map<string, ContainerState>;
}

/** What `planDockerInstall` reads about this machine. */
export interface DockerFacts {
  platform?: string | undefined;
  arch?: string | undefined;
  cli?: boolean | undefined;
  daemon?: boolean | undefined;
  brew?: boolean | undefined;
  desktop?: boolean | undefined;
  colima?: boolean | undefined;
  winget?: boolean | undefined;
}

/** What it decides to do about it. */
export interface DockerPlan {
  action: string;
  engine: string;
  packages?: string[] | undefined;
  dest?: string | undefined;
  package?: string | undefined;
}

/** The result of one install/recover attempt. */
export interface InstallResult {
  ok: boolean;
  action: string;
  log: string;
  docker: DecoratedDockerStatus;
  hint: string;
}

/** `recoverDocker`'s report: which lever it pulled and where that left docker. */
export interface RecoverResult {
  ok: boolean;
  action: string;
  killed: number;
  docker: DecoratedDockerStatus;
  log?: string | undefined;
}

/** The four-step desk setup ladder, as the UI renders it. */
export interface SetupProgress {
  step: number;
  total: number;
  label: string;
  ready: boolean;
}

/** What `startVm` hands back to be merged onto `bot.vm`. */
export interface VmStartInfo {
  container: string;
  novncPort: number | null;
  harnessPort: number | null;
  status: string;
  display: string;
  volume: string;
  setup: SetupProgress;
}

/** One PNG grabbed off a desk. */
export interface ShotResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
  buf: Buffer;
  pointer: { x: number; y: number };
}

/** The JSON a cloud desk-agent answers `POST /action` with. */
export interface RemoteDeskReply {
  ok?: boolean | undefined;
  text?: string | undefined;
  error?: string | undefined;
  log?: string | undefined;
  imageB64?: string | undefined;
  x?: unknown;
  y?: unknown;
}

function isWindows(): boolean {
  return process.platform === "win32" || process.env.OS === "Windows_NT";
}

export function sub8BinDir(home: string = os.homedir()): string {
  return path.join(home || os.homedir() || "", ".sub8", "bin");
}

// GUI-launched macOS apps inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// so a docker CLI installed by Homebrew, MacPorts, Rancher/Colima, nvm, etc. is
// invisible to us unless we ask the user's login shell where things are. A SUCCESS
// is cached forever; a FAILURE (e.g. the shell spawn times out under macOS Low
// Power Mode) is cached only briefly so we retry instead of getting stuck on a
// permanent "Docker not installed". `-lc` (login, non-interactive) picks up
// ~/.zprofile/`brew shellenv`; we avoid `-lic` since an interactive shell can hang.
const SHELL_RETRY_MS = 20_000;
let shellDirsCache: { dirs: string[]; at: number; ok: boolean } = { dirs: [], at: 0, ok: false };
function loginShellDirs(): string[] {
  const now = Date.now();
  if (shellDirsCache.ok) return shellDirsCache.dirs;
  if (shellDirsCache.at && now - shellDirsCache.at < SHELL_RETRY_MS) return shellDirsCache.dirs;
  shellDirsCache = { dirs: [], at: now, ok: false };
  if (isWindows()) return [];
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = spawnSync(shell, ["-lc", 'printf %s "$PATH"'], { timeout: 10_000, encoding: "utf8", input: "", stdio: ["pipe", "pipe", "ignore"] });
    const out = String(r.stdout || "").trim();
    if (out && out.includes("/")) {
      const dirs = out.split(":").map((s) => s.trim()).filter((s) => s && s.startsWith("/"));
      shellDirsCache = { dirs, at: now, ok: dirs.length > 0 };
    }
  } catch {
    /* best effort; failure stays uncached-for-long so we retry */
  }
  return shellDirsCache.dirs;
}

// Ask the login shell for docker's absolute path directly — more reliable than
// parsing $PATH and stat-ing dirs. Same success-forever / retry-on-failure cache.
let dockerBinCache: { path: string; at: number } = { path: "", at: 0 };
function dockerViaLoginShell(): string {
  const now = Date.now();
  if (dockerBinCache.path && fsSync.existsSync(dockerBinCache.path)) return dockerBinCache.path;
  if (dockerBinCache.at && now - dockerBinCache.at < SHELL_RETRY_MS) return dockerBinCache.path;
  dockerBinCache = { path: "", at: now };
  if (isWindows()) return "";
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = spawnSync(shell, ["-lc", "command -v docker || which docker"], { timeout: 10_000, encoding: "utf8", input: "", stdio: ["pipe", "pipe", "ignore"] });
    // split() always yields at least one element, so [0] is never undefined.
    const p = String(r.stdout || "").trim().split("\n")[0]!.trim();
    if (p && p.startsWith("/") && fsSync.existsSync(p)) dockerBinCache = { path: p, at: now };
  } catch {
    /* best effort */
  }
  return dockerBinCache.path;
}

export function hostPathDirs(home: string = os.homedir()): string[] {
  const h = home || os.homedir() || "";
  if (isWindows()) {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(pf, "Docker", "Docker", "resources", "bin"),
      path.join(h, ".docker", "bin"),
      path.join(h, ".sub8", "bin"),
    ];
  }
  // Known locations first (fast, no subprocess), then whatever the user's login
  // shell actually has on PATH — this catches non-standard docker installs.
  const known = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(h, ".docker", "bin"),
    path.join(h, ".sub8", "bin"),
    path.join(h, ".local", "bin"),
    path.join(h, ".rd", "bin"), // Rancher Desktop
    "/opt/local/bin", // MacPorts
    "/Applications/Docker.app/Contents/Resources/bin",
  ];
  const merged = [...known];
  for (const d of loginShellDirs()) if (!merged.includes(d)) merged.push(d);
  return merged;
}

export function dockerBin(): string {
  // Docker Desktop ships an extensionless `docker` sh-wrapper next to docker.exe.
  // Node's spawn on Windows can pick that file and fail to exec.
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  if (isWindows()) {
    // filter(Boolean) drops the undefined DOCKER_BIN; TypeScript cannot see that.
    const candidates = [process.env.DOCKER_BIN, ...hostPathDirs(home).map((d) => path.join(d, "docker.exe"))].filter(Boolean) as string[];
    for (const p of candidates) {
      if (fsSync.existsSync(p)) return p;
    }
    return "docker.exe";
  }
  const candidates = [
    process.env.DOCKER_BIN,
    ...hostPathDirs(home).map((d) => path.join(d, "docker")),
    "/usr/bin/docker",
    // Same as above: filter(Boolean) drops an unset DOCKER_BIN.
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p;
  }
  // Not in any known dir — ask the login shell directly (covers non-standard
  // installs, and recovers if an earlier PATH probe timed out under Low Power).
  const viaShell = dockerViaLoginShell();
  if (viaShell) return viaShell;
  return "docker";
}

export function resolveDockerHost(): string {
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
  const xdg = process.env.XDG_RUNTIME_DIR || "";
  // Prefer a socket that actually exists. Order: Colima (the engine Sub8 installs),
  // the standard /var/run symlink, Docker Desktop's own socket (~/.docker/run —
  // /var/run/docker.sock only exists when "Allow the default Docker socket" is on),
  // then rootless Linux. If none exist, return "" so the docker CLI uses its own
  // active context instead of us forcing a dead unix:///var/run/docker.sock.
  const socks = [
    home && path.join(home, ".colima", "default", "docker.sock"),
    "/var/run/docker.sock",
    home && path.join(home, ".docker", "run", "docker.sock"),
    xdg && path.join(xdg, "docker.sock"),
  ].filter(Boolean);
  for (const sock of socks) {
    if (fsSync.existsSync(sock)) return `unix://${sock}`;
  }
  return "";
}

export function dockerPlatform(): string {
  return process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

export const SLIM_IMAGE = "sub8-desk:trixie";
export const FALLBACK_IMAGE = "linuxserver/webtop:ubuntu-xfce";
const START_PORT = 13100;

/** Baked into the slim image. Runtime docker-cp (mcp-desk) is not in this list. */
export const SLIM_SOURCE_FILES = [
  "Dockerfile",
  "desk-init.sh",
  "desk-harness.py",
  "desk-display.sh",
  "chrome-desktop.sh",
];

export function shouldRebuildSlim(imageCreatedMs: unknown, sourceMtimes: readonly unknown[] = []): boolean {
  const created = Number(imageCreatedMs);
  if (!Number.isFinite(created) || created <= 0) return true;
  return (sourceMtimes || []).some((t) => Number(t) > created);
}

export function slimSourceMtimes(root: string = path.resolve(fileRoot, "vm")): number[] {
  return SLIM_SOURCE_FILES.map((name) => {
    try {
      return fsSync.statSync(path.join(root, name)).mtimeMs;
    } catch {
      return 0;
    }
  });
}

let resolvedImage = process.env.LOCALBOT_IMAGE || SLIM_IMAGE;

export function deskImage(): string {
  return resolvedImage;
}

const harnessProxies = new Map<string, { port: number; server: Server }>();

function spawnDeskNc(container: string): ChildProcess {
  const child = spawn(
    dockerBin(),
    ["exec", "-i", "-u", "abc", container, "python3", "-u", "-c", HARNESS_STDIO_BRIDGE],
    // The tuple annotation picks spawn's stdio-tuple overload, which is what
    // makes stdin/stdout below non-null.
    { stdio: ["pipe", "pipe", "ignore"] as [StdioPipe, StdioPipe, StdioNull] },
  );
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  return child;
}

export async function ensureHostHarnessProxy(
  container: string,
  preferredPort?: number | null | undefined,
  onLog: LogFn = () => {},
): Promise<number> {
  const hit = harnessProxies.get(container);
  if (hit?.port && hit.server?.listening) return hit.port;
  const port = Number(preferredPort) > 0 ? Number(preferredPort) : await allocateHarnessPort();
  const server = net.createServer();
  // @sub8/desk-ports models `kill` as taking a plain string; node types it
  // NodeJS.Signals | number, which is narrower, so the child needs the cast.
  attachHarnessProxy(server, () => spawnDeskNc(container) as HarnessRemote);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  harnessProxies.set(container, { port, server });
  onLog(`Desk brain proxied on 127.0.0.1:${port}`);
  return port;
}

export async function publishHarnessWithoutRecreate(
  container: string | null | undefined,
  novncPort?: number | null | undefined,
  onLog: LogFn = () => {},
): Promise<number | null> {
  if (!container) return null;
  const mapped = await detectMappedPort(container, HARNESS_PORT);
  if (mapped) return mapped;
  onLog("Starting desk brain inside the computer (no recreate)…");
  await installDeskHarness(container);
  const hport = await allocateHarnessPort(harnessHostPort(novncPort));
  return ensureHostHarnessProxy(container, hport, onLog);
}

/**
 * Boot: rebuild slim image in the background if stale, and publish :3011 for
 * THIS app's running desks only (never stranger localbot-* on the host).
 */
export async function warmLocalDesks({
  listStates = listLocalbotStates,
  publish = publishHarnessWithoutRecreate,
  ensure = ensureImage,
  bots = [],
  upsertBot,
  onLog = () => {},
}: {
  listStates?: ((opts?: { force?: boolean | undefined }) => Promise<LocalbotStates>) | undefined;
  publish?:
    | ((container: string, novncPort?: number | null | undefined, onLog?: LogFn) => Promise<number | null>)
    | undefined;
  ensure?: ((onLog?: LogFn) => Promise<void>) | undefined;
  bots?: readonly Bot[] | undefined;
  upsertBot?: ((bot: Bot) => unknown) | undefined;
  onLog?: LogFn | undefined;
} = {}): Promise<{ warmed: Array<{ name: string; harnessPort: number; botId: string }> }> {
  const wanted = new Map<string, Bot>();
  for (const bot of bots || []) {
    const name = bot?.vm?.container;
    if (name) wanted.set(name, bot);
  }
  const warmed: Array<{ name: string; harnessPort: number; botId: string }> = [];
  if (!wanted.size) return { warmed };
  if (typeof ensure === "function") ensure(onLog).catch(() => {});
  const listed = await listStates({ force: true });
  if (!listed?.ok) return { warmed };
  for (const [name, bot] of wanted) {
    const st = listed.states?.get(name);
    if (!st?.running) continue;
    if (!needsHarnessPublish(st.portMap) && (mappedHarnessPort(st.portMap) || bot.vm?.harnessPort)) continue;
    const port = await publish(name, st.novncPort || bot.vm?.novncPort, onLog).catch((err) => {
      onLog(`desk brain warm skipped ${name}: ${err.message || err}`);
      return null;
    });
    if (!port) continue;
    bot.vm = { ...(bot.vm || {}), harnessPort: port };
    if (typeof upsertBot === "function") await upsertBot(bot);
    warmed.push({ name, harnessPort: port, botId: bot.id });
  }
  return { warmed };
}

export function displayNum(bot: Bot | null | undefined): number {
  const n = Number(String(bot?.vm?.display || ":1").replace(":", "").split(".")[0]);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(DISPLAY_SLOTS, Math.max(1, n));
}

export function debugPortFor(n: number = 1): number {
  return 9221 + Number(n || 1);
}

export function deskMemory(memberCount?: unknown): string {
  if (process.env.LOCALBOT_MEMORY) return process.env.LOCALBOT_MEMORY;
  const n = Number(memberCount);
  if (!Number.isFinite(n) || n <= 1) return "2g";
  return `${Math.min(6, 2 + (n - 1))}g`;
}

export function deskShm(): string {
  return process.env.LOCALBOT_SHM || "256m";
}

export function parseDockerProgress(text: unknown): number | null {
  const s = String(text || "");
  const pcts = [...s.matchAll(/(\d+)\s*%/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 100);
  if (pcts.length) return Math.max(...pcts);
  return null;
}

export function deskCreateArgs({
  name,
  volume,
  port,
  image,
  harnessPort,
}: {
  // `name` and `port` are required in practice — they are optional only because
  // the whole argument is, so a bare deskCreateArgs() cannot throw. The two
  // non-null assertions below are that.
  name?: string | undefined;
  volume?: string | undefined;
  port?: number | undefined;
  image?: string | undefined;
  harnessPort?: number | null | undefined;
} = {}): string[] {
  const img = image || resolvedImage || SLIM_IMAGE;
  const mem = deskMemory();
  // Map known deskMemory() strings onto rungs; unknown LOCALBOT_MEMORY overlays
  // memory/memorySwap onto the 2 GB rung (no second memory parser).
  const ramMb =
    mem === "1g" ? 1024 :
    mem === "2g" ? 2048 :
    mem === "3g" ? 3072 :
    mem === "4g" ? 4096 :
    mem === "5g" ? 5120 :
    mem === "6g" ? 6144 :
    2048;
  const limits = { ...limitsFromRamMb(ramMb), memory: mem, memorySwap: mem, shm: deskShm() };
  // Callers pass a real port; harnessHostPort(port) is null only when port is missing.
  const hport = (harnessPort || harnessHostPort(port))!;
  return deskRunArgs({
    name: name!,
    volume: volume!,
    image: img,
    platform: dockerPlatform(),
    hostname: "computer",
    limits,
    // Bind to loopback. Published with no address, Docker Desktop listens on
    // 0.0.0.0, and the container's websockify (desk-init.sh) also binds all
    // interfaces with no auth in front of it -- x11vnc runs -nopw and is
    // loopback-only INSIDE the container, but websockify is the network-facing
    // service and is what this line exposes. That handed anyone on the Mac's
    // LAN full click-and-type control of every desk, including its logged-in
    // Chrome profile and grok credentials. Nothing legitimate needs these off
    // this machine: the viewer builds http://127.0.0.1:<novncPort> (web/app.ts)
    // and harnessUrlFor is 127.0.0.1 too.
    publish: { kind: "loopback", novncPort: port!, harnessPort: hport },
    env: [
      "PUID=1000",
      "PGID=1000",
      "TZ=America/New_York",
      "TITLE=My Computer",
      "SELKIES_MANUAL_WIDTH=1024",
      "SELKIES_MANUAL_HEIGHT=768",
      "DESK_HARNESS=1",
    ],
    extraArgs: [
      "--dns", "8.8.8.8",
      "--dns", "1.1.1.1",
      "--add-host", "host.docker.internal:host-gateway",
      "--label", `${INSTALL_LABEL}=${installId()}`,
    ],
  });
}

/**
 * Which install a container belongs to. Containers and volumes live in ONE
 * global Docker namespace, but the app has more than one data dir — the repo's
 * `data/` and the packaged `~/Library/Application Support/Sub8/data` — and each
 * keeps its own registry. Keying on the resolved data dir makes "mine" exact.
 */
const INSTALL_LABEL = "sub8.install";

function installId(): string {
  return createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const home = env.HOME || env.USERPROFILE || os.homedir() || "";
  if (isWindows()) {
    if (/colima|unix:\/\//i.test(env.DOCKER_HOST || "")) delete env.DOCKER_HOST;
  } else {
    const host = resolveDockerHost();
    if (host) env.DOCKER_HOST = host;
  }
  const extras = hostPathDirs(home);
  const prefix = extras.filter((p) => fsSync.existsSync(p)).join(path.delimiter);
  if (prefix) env.PATH = `${prefix}${path.delimiter}${env.PATH || "/usr/bin:/bin"}`;
  return env;
}

const dockerKids = new Set<ChildProcess>();

function makeLimiter(n: number) {
  let active = 0;
  const q: Array<(value?: unknown) => void> = [];
  return {
    async acquire() {
      if (active < n) {
        active += 1;
        return;
      }
      await new Promise((resolve) => q.push(resolve));
    },
    release() {
      // Guarded by q.length, so shift() cannot be undefined here.
      if (q.length) q.shift()!();
      else active = Math.max(0, active - 1);
    },
    stats() {
      return { active, waiting: q.length };
    },
  };
}

const shortDocker = makeLimiter(2);
const longDocker = makeLimiter(1);

export function isLongDocker(args: readonly string[] = [], opts: DockerOpts = {}): boolean {
  const joined = (Array.isArray(args) ? args : []).join(" ");
  if (/setup-apps|apt-get|\bapt\b|^build\b|^pull\b/i.test(joined)) return true;
  return (opts.timeout || 0) >= 60_000;
}

export function dockerQueueStats() {
  return { short: shortDocker.stats(), long: longDocker.stats(), kids: dockerKids.size };
}

function run(cmd: string, args: readonly string[], opts: DockerOpts = {}): Promise<RunResult> {
  const { timeout, track, env, onData, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: env || dockerEnv(),
      // An array literal widens to string[]; StdioOptions is the union spawn wants.
      stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
      windowsHide: true,
      ...spawnOpts,
    });
    if (track) track.add(child);
    let out = "";
    let done = false;
    const finish = (result: RunResult) => {
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
    const take = (d: Buffer) => {
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

export async function docker(args: readonly string[], opts: DockerOpts = {}): Promise<RunResult> {
  // A stop must never queue behind the command it is stopping: the desk allows
  // two concurrent short docker calls, and a long `shell` turn holds one of
  // them for as long as it runs.
  if (opts.jumpQueue) return run(dockerBin(), args, { ...opts, track: dockerKids });
  const lim = isLongDocker(args, opts) ? longDocker : shortDocker;
  await lim.acquire();
  try {
    return await run(dockerBin(), args, { ...opts, track: dockerKids });
  } finally {
    lim.release();
  }
}

export function killHungDockerClients(): number {
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

let dockerStatusCache: { at: number; value: DockerStatus | null } = { at: 0, value: null };
let lastGoodDocker: { at: number; value: DockerStatus | null } = { at: 0, value: null };
let dockerFailStreak = 0;

function dockerInstallHint(): string {
  if (process.platform === "darwin") {
    return "Click Install Docker. Sub8 will install Colima (not Docker Desktop) so each Bot can have a computer.";
  }
  if (process.platform === "win32") {
    return "Click Install Docker. Sub8 will install Docker Desktop so each Bot can have a computer.";
  }
  return "Click Install Docker. Sub8 will install Docker Engine so each Bot can have a computer.";
}

function dockerDaemonHint(): string {
  if (process.platform === "darwin") {
    return "Docker is installed but not running. Start Colima (colima start) or open Docker Desktop.";
  }
  if (process.platform === "win32") {
    return "Docker is installed but not running. Open Docker Desktop and wait until it is ready.";
  }
  return "Docker is installed but the daemon is not running. Try: sudo systemctl start docker";
}

function dockerStuckHint(): string {
  if (process.platform === "darwin") {
    return "Docker stopped answering. Desks are probably still running inside Colima. Recover unsticks it without wiping files.";
  }
  return "Docker stopped answering. Desks are probably still running. Recover will retry and restart the engine if needed.";
}

function timedOut(r: RunResult | null | undefined): boolean {
  return Boolean(r && (r.code === 124 || /timeout/i.test(r.out || "")));
}

function hostBin(name: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  const exe = isWindows() && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  for (const dir of hostPathDirs(home)) {
    const p = path.join(dir, exe);
    if (fsSync.existsSync(p)) return p;
  }
  return name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function invalidateDockerCache(): void {
  dockerStatusCache = { at: 0, value: null };
  containerListCache = { at: 0, value: null };
  dockerFailStreak = 0;
}

let dockerStatusInflight: Promise<DockerStatus> | null = null;

async function dockerStatusFresh(): Promise<DockerStatus> {
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
  const probe = await probeDaemon();
  const value = probe.ok
    ? { ok: true, cli: true, daemon: true, stuck: false, recover: false, hint: "", engine: probe.engine }
    : {
        ok: false,
        cli: true,
        daemon: false,
        stuck: probe.stuck,
        recover: true,
        hint: probe.stuck
          ? dockerStuckHint()
          : probe.error
            ? `${dockerDaemonHint()} (${probe.error})`
            : dockerDaemonHint(),
        // Surface the real reason so a stuck user (and we) can see WHY, not just "not running".
        daemonError: probe.error || "",
      };
  return settleDockerStatus(value);
}

/**
 * Ask the daemon for its version across every plausible endpoint. GUI-launched
 * apps don't inherit the shell, and Docker Desktop / Colima / native each expose
 * the socket at a different path — so instead of guessing one DOCKER_HOST we try:
 * the CLI's own active context, the endpoint the context actually declares
 * (authoritative), then each known socket path. First success wins.
 */
async function probeDaemon(): Promise<
  { ok: true; engine: string; host: string } | { ok: false; stuck: boolean; error: string }
> {
  const home = process.env.HOME || os.homedir() || "";
  const attempts: Array<string | undefined> = [];
  const seen = new Set<string>();
  const add = (host: string | undefined) => {
    const key = host === undefined ? "<ctx>" : String(host);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(host);
  };
  // 1) Let the CLI use its own active context (DOCKER_HOST unset).
  add(undefined);
  // 2) Whatever we currently resolve (may be set by a running Colima etc).
  if (!isWindows()) {
    const resolved = resolveDockerHost();
    if (resolved) add(resolved);
  }
  // 3) The endpoint the current context authoritatively declares.
  try {
    const ctxEnv = { ...dockerEnv() };
    delete ctxEnv.DOCKER_HOST;
    const insp = await docker(
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { timeout: 6_000, env: ctxEnv },
    );
    const ep = (insp.out || "").trim();
    if (insp.ok && ep && /^[a-z]+:\/\//i.test(ep)) add(ep);
  } catch {
    /* context inspect is best-effort */
  }
  // 4) Known socket locations, newest Docker Desktop layout first.
  if (!isWindows()) {
    for (const p of [
      home && `${home}/.docker/run/docker.sock`,
      "/var/run/docker.sock",
      home && `${home}/.colima/default/docker.sock`,
      home && `${home}/Library/Containers/com.docker.docker/Data/docker.raw.sock`,
      process.env.XDG_RUNTIME_DIR && `${process.env.XDG_RUNTIME_DIR}/docker.sock`,
    ]) {
      if (p && fsSync.existsSync(p)) add(`unix://${p}`);
    }
  }

  let anyTimeout = false;
  let lastError = "";
  for (const host of attempts) {
    const env = { ...dockerEnv() };
    if (host === undefined) delete env.DOCKER_HOST;
    else env.DOCKER_HOST = host;
    const r = await docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 8_000, env });
    if (r.ok) return { ok: true, engine: (r.out || "").trim(), host: host || "context" };
    if (timedOut(r)) anyTimeout = true;
    lastError = (r.out || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || lastError;
  }
  // Only call it "stuck" if every attempt timed out (daemon wedged); a fast
  // "cannot connect" across the board means it's genuinely not running.
  return { ok: false, stuck: anyTimeout && !lastError, error: lastError };
}

function settleDockerStatus(value: DockerStatus): DockerStatus {
  if (value.ok) {
    dockerFailStreak = 0;
    lastGoodDocker = { at: Date.now(), value };
    dockerStatusCache = { at: Date.now(), value };
    return value;
  }
  dockerFailStreak += 1;
  const recentlyOk = lastGoodDocker.value && Date.now() - lastGoodDocker.at < 120_000;
  if (value.stuck && dockerFailStreak < 2 && recentlyOk) {
    // recentlyOk is only truthy when lastGoodDocker.value is set; the narrowing
    // does not survive the && chain because it lives on a mutable module object.
    const keep = { ...lastGoodDocker.value!, stale: true };
    dockerStatusCache = { at: Date.now(), value: keep };
    return keep;
  }
  dockerStatusCache = { at: Date.now(), value };
  return value;
}

export const BREW_DOCKER_PACKAGES = ["colima", "docker"];

export function brewPath(): string {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (fsSync.existsSync(p)) return p;
  }
  return "";
}

export function dockerDesktopPath(platform: string = process.platform): string {
  if (platform === "win32") {
    return path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
  }
  if (platform === "darwin") return "/Applications/Docker.app";
  return "";
}

export function dockerDocsUrl(platform: string = process.platform): string {
  if (platform === "win32") return "https://docs.docker.com/desktop/setup/install/windows-install/";
  if (platform === "linux") return "https://docs.docker.com/engine/install/";
  return "https://docs.docker.com/desktop/setup/install/mac-install/";
}

export function dockerDesktopInstallerUrl(platform: string = "win32", arch: string = "x64"): string {
  if (platform !== "win32") return "";
  const a = arch === "arm64" ? "arm64" : "amd64";
  return `https://desktop.docker.com/win/main/${a}/Docker%20Desktop%20Installer.exe`;
}

export function dockerStaticArch(arch: string = process.arch): string {
  return arch === "arm64" || arch === "aarch64" ? "aarch64" : "x86_64";
}

export function dockerCliIndexUrl(platform: string = "darwin", arch: string = process.arch): string {
  const osDir = platform === "darwin" ? "mac" : "linux";
  return `https://download.docker.com/${osDir}/static/stable/${dockerStaticArch(arch)}/`;
}

export function colimaBinaryName(platform: string = "darwin", arch: string = process.arch): string {
  const osName = platform === "darwin" ? "Darwin" : platform === "linux" ? "Linux" : "Windows";
  const a = arch === "arm64" || arch === "aarch64" ? "arm64" : "x86_64";
  return `colima-${osName}-${a}`;
}

export function limaArchiveName(version: unknown, platform: string = "darwin", arch: string = process.arch): string {
  const ver = String(version || "").replace(/^v/i, "");
  const osName = platform === "darwin" ? "Darwin" : "Linux";
  const a = arch === "arm64" || arch === "aarch64" ? "arm64" : "x86_64";
  return `lima-${ver}-${osName}-${a}.tar.gz`;
}

export function pickLatestDockerTarball(listing: string = ""): string {
  const found: Array<{ file: string; version: string }> = [];
  for (const m of String(listing).matchAll(/docker-(\d+\.\d+\.\d+)\.tgz/gi)) {
    if (/rootless/i.test(m[0])) continue;
    // Group 1 is not optional in the pattern, so a match always carries it.
    found.push({ file: `docker-${m[1]}.tgz`, version: m[1]! });
  }
  if (!found.length) return "";
  found.sort((a, b) => {
    const as = a.version.split(".").map((n) => Number(n) || 0);
    const bs = b.version.split(".").map((n) => Number(n) || 0);
    for (let i = 0; i < 3; i++) {
      const d = (as[i] || 0) - (bs[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  // found.length was checked above, so the last element is there.
  return found.at(-1)!.file;
}

export function colimaStartArgs({
  cpus,
  totalMemBytes,
}: { cpus?: unknown; totalMemBytes?: unknown } = {}): { cpu: number; memory: number } {
  const ncpu = Number(cpus) > 0 ? Number(cpus) : os.cpus()?.length || 4;
  const gb = (Number(totalMemBytes) > 0 ? Number(totalMemBytes) : os.totalmem()) / 1024 ** 3;
  const cpu = Math.max(2, Math.min(4, Math.floor(ncpu / 2) || 2));
  const memory = gb >= 24 ? 8 : gb >= 12 ? 4 : 2;
  return { cpu, memory };
}

export function planDockerInstall(facts: DockerFacts = {}): DockerPlan {
  const platform = facts.platform || "darwin";
  if (facts.daemon) return { action: "noop", engine: "existing" };
  // A CLI is present. Recover (start what's already there) only when there IS an
  // engine to start:
  //  - Linux: the engine is a local system service (moby). A docker CLI with a
  //    stopped daemon just needs `systemctl start docker` — recoverDocker() does
  //    exactly that. Never reinstall via get.docker.com over a working install.
  //  - Any platform: Colima or Docker Desktop present means recoverDocker() has
  //    something concrete to boot.
  // A BARE docker CLI on macOS/Windows with no engine (e.g. `brew install docker`
  // and nothing else — no whale icon, no daemon, nothing for recover to start)
  // would spin forever; fall through to actually INSTALL an engine below.
  if (facts.cli && platform === "linux") return { action: "recover", engine: "moby" };
  if (facts.cli && (facts.colima || facts.desktop)) {
    return { action: "recover", engine: facts.colima ? "colima" : "desktop" };
  }
  if (platform === "darwin") {
    if (facts.desktop) return { action: "start-desktop", engine: "desktop" };
    if (facts.brew) return { action: "brew-colima", engine: "colima", packages: [...BREW_DOCKER_PACKAGES] };
    return { action: "static-colima", engine: "colima", dest: "sub8-bin" };
  }
  if (platform === "linux") return { action: "engine-get-docker", engine: "moby" };
  if (platform === "win32") {
    if (facts.desktop) return { action: "start-desktop", engine: "desktop" };
    if (facts.winget) return { action: "winget-desktop", engine: "desktop", package: "Docker.DockerDesktop" };
    return { action: "download-desktop", engine: "desktop" };
  }
  return { action: "unsupported", engine: "" };
}

const installJob = { busy: false, action: "", log: "" };
let installInflight: Promise<InstallResult> | null = null;

export function dockerInstallProgress(): { installing: boolean; action: string; log: string } {
  return { installing: installJob.busy, action: installJob.action, log: installJob.log };
}

function decorateDocker(value: DockerStatus | null | undefined): DecoratedDockerStatus {
  const p = dockerInstallProgress();
  return {
    ...(value || {}),
    platform: process.platform,
    installing: p.installing,
    installAction: p.action || "",
    installLog: p.log || "",
  };
}

export async function dockerStatus(): Promise<DecoratedDockerStatus> {
  const now = Date.now();
  let value: DockerStatus | null;
  if (dockerStatusCache.value && now - dockerStatusCache.at < 4000) {
    value = dockerStatusCache.value;
  } else if (dockerStatusInflight) {
    value = await dockerStatusInflight;
  } else {
    dockerStatusInflight = dockerStatusFresh().finally(() => {
      dockerStatusInflight = null;
    });
    value = await dockerStatusInflight;
  }
  return decorateDocker(value);
}

export function parseLocalbotPs(out: string | null | undefined): Map<string, ContainerState> {
  const states = new Map<string, ContainerState>();
  for (const line of String(out || "").split("\n")) {
    const [name, state, status, ports] = line.split("\t");
    if (!name || !name.startsWith("localbot-")) continue;
    // docker ps already knows the host port; reading it here keeps a remembered
    // port from outliving the mapping it came from.
    const portMap = parseDisplayPorts(ports);
    const novncPort = portMap[3000] || null;
    const harnessPort = mappedHarnessPort(portMap);
    const paused = state === "paused" || /paused/i.test(status || "");
    let st = "exited";
    if (paused) st = "paused";
    else if (state === "running") st = "running";
    else if (state === "dead") st = "missing";
    else if (state === "created" || state === "exited") st = "exited";
    else if (state) st = state;
    states.set(name, {
      exists: true,
      status: st,
      running: st === "running",
      paused,
      stuck: false,
      novncPort,
      harnessPort,
      portMap,
    });
  }
  return states;
}

let containerListCache: { at: number; value: LocalbotStates | null } = { at: 0, value: null };
let containerListInflight: Promise<LocalbotStates> | null = null;

export async function listLocalbotStates({
  force = false,
}: { force?: boolean | undefined } = {}): Promise<LocalbotStates> {
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

export async function recoverDocker(): Promise<RecoverResult> {
  invalidateDockerCache();
  const killed = killHungDockerClients();
  let docker = await dockerStatusFresh();
  if (docker.ok) return { ok: true, action: "retry", killed, docker: decorateDocker(docker) };

  if (process.platform === "darwin") {
    const colima = hostBin("colima");
    const listed = await run(colima, ["list"], { timeout: 12_000, env: dockerEnv() });
    const missingColima = /enoent|not found|cannot find/i.test(listed.out || "");
    if (!missingColima) {
      const running = /\bRunning\b/i.test(listed.out || "");
      if (!running) {
        const start = await run(colima, ["start"], { timeout: 180_000, env: dockerEnv() });
        invalidateDockerCache();
        docker = await dockerStatusFresh();
        if (docker.ok) {
          return { ok: true, action: "colima-start", killed, docker: decorateDocker(docker), log: (start.out || "").slice(-500) };
        }
      } else {
        const rst = await run(colima, ["ssh", "--", "sudo", "service", "docker", "restart"], {
          timeout: 60_000,
          env: dockerEnv(),
        });
        await sleep(2500);
        invalidateDockerCache();
        docker = await dockerStatusFresh();
        if (docker.ok) return { ok: true, action: "docker-restart", killed, docker: decorateDocker(docker), log: (rst.out || "").slice(-500) };
        const cr = await run(colima, ["restart"], { timeout: 180_000, env: dockerEnv() });
        invalidateDockerCache();
        docker = await dockerStatusFresh();
        if (docker.ok) return { ok: true, action: "colima-restart", killed, docker: decorateDocker(docker), log: (cr.out || "").slice(-500) };
      }
    }
    const desktop = dockerDesktopPath("darwin");
    if (desktop && fsSync.existsSync(desktop)) {
      const opened = await startDockerDesktop("darwin");
      invalidateDockerCache();
      docker = await dockerStatusFresh();
      return { ok: docker.ok, action: "docker-desktop", killed, docker: decorateDocker(docker), log: (opened.log || "").slice(-500) };
    }
    return { ok: false, action: missingColima ? "retry" : "colima-start", killed, docker: decorateDocker(docker) };
  }

  if (isWindows()) {
    const exe = dockerDesktopPath("win32");
    if (exe && fsSync.existsSync(exe)) {
      await startDockerDesktop("win32");
      invalidateDockerCache();
      docker = await dockerStatusFresh();
      return { ok: docker.ok, action: "docker-desktop", killed, docker: decorateDocker(docker) };
    }
  }

  if (process.platform === "linux") {
    const started = await linuxStartDocker();
    invalidateDockerCache();
    docker = await dockerStatusFresh();
    if (started.ok || docker.ok) {
      return { ok: docker.ok, action: "systemctl-start", killed, docker: decorateDocker(docker), log: (started.out || "").slice(-500) };
    }
  }

  return { ok: false, action: "retry", killed, docker: decorateDocker(docker) };
}

function sayInstall(line: unknown): void {
  const s = String(line || "").replace(/\r/g, "").trim();
  if (!s) return;
  const prev = installJob.log ? `${installJob.log}\n` : "";
  installJob.log = `${prev}${s}`.slice(-12_000);
}

function sayInstallChunk(chunk: unknown): void {
  const lines = String(chunk || "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(-8)) sayInstall(line);
}

function binExists(name: string): boolean {
  const p = hostBin(name);
  return Boolean(p && p !== name && fsSync.existsSync(p));
}

function wingetBin(): string {
  const home = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(home, "Microsoft", "WindowsApps", "winget.exe"),
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "winget.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "WindowsApps", "winget.exe"),
  ];
  for (const p of candidates) {
    if (p && fsSync.existsSync(p)) return p;
  }
  return "";
}

function probeDockerInstallFacts(docker: Partial<DockerStatus> = {}): DockerFacts {
  const platform = process.platform;
  const desktop = dockerDesktopPath(platform);
  return {
    platform,
    arch: process.arch,
    cli: Boolean(docker.cli),
    daemon: Boolean(docker.ok || docker.daemon),
    brew: Boolean(brewPath()),
    desktop: Boolean(desktop && fsSync.existsSync(desktop)),
    colima: binExists("colima"),
    winget: platform === "win32" && Boolean(wingetBin()),
  };
}

async function fetchText(url: string, { timeout = 60_000 }: { timeout?: number | undefined } = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Sub8", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function downloadToFile(
  url: string,
  dest: string,
  { timeout = 300_000 }: { timeout?: number | undefined } = {},
): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Sub8" },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return dest;
}

async function latestGithubAsset(repo: string, match: RegExp): Promise<{ tag: string; name: string; url: string }> {
  const data = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/releases/latest`, { timeout: 45_000 }));
  const assets: Array<{ name?: string | undefined; browser_download_url?: string | undefined }> = data.assets || [];
  const asset = assets.find((a) => match.test(String(a.name || "")));
  if (!asset?.browser_download_url) throw new Error(`No ${repo} asset matching ${match}`);
  // find() only accepted an asset whose name the caller's pattern matched, and
  // none of those patterns match the empty string a nameless asset would give.
  return { tag: data.tag_name, name: asset.name!, url: asset.browser_download_url };
}

async function startDockerDesktop(platform: string = process.platform): Promise<{ ok: boolean; log: string }> {
  if (platform === "win32") {
    const exe = dockerDesktopPath("win32");
    if (!exe || !fsSync.existsSync(exe)) return { ok: false, log: "Docker Desktop is not installed." };
    try {
      spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (err) {
      return { ok: false, log: String((err as Error).message || err) };
    }
    await sleep(8000);
    return { ok: true, log: "Started Docker Desktop." };
  }
  if (platform === "darwin") {
    const opened = await run("open", ["-a", "Docker"], { timeout: 20_000, env: dockerEnv() });
    await sleep(8000);
    return { ok: opened.ok, log: opened.out || "Started Docker Desktop." };
  }
  return { ok: false, log: "" };
}

function privilegeBin(): string {
  for (const p of ["/usr/bin/pkexec", "/usr/bin/sudo"]) {
    if (fsSync.existsSync(p)) return p;
  }
  return "";
}

async function linuxPrivilege(
  script: string,
  { timeout = 300_000 }: { timeout?: number | undefined } = {},
): Promise<RunResult> {
  const bin = privilegeBin();
  if (!bin) return { ok: false, out: "Need pkexec or sudo to install Docker Engine.", code: 1 };
  const args = bin.endsWith("sudo") ? ["-n", "sh", "-c", script] : ["sh", "-c", script];
  return run(bin, args, { timeout, env: dockerEnv(), onData: sayInstallChunk });
}

async function linuxStartDocker(): Promise<RunResult> {
  const script = "systemctl enable --now docker || service docker start || true";
  const bin = privilegeBin();
  if (!bin) {
    const r = await run("systemctl", ["start", "docker"], { timeout: 30_000, env: dockerEnv() });
    return r;
  }
  return linuxPrivilege(script, { timeout: 60_000 });
}

async function startColimaEngine(): Promise<{ ok: boolean; out: string }> {
  const colima = hostBin("colima");
  const { cpu, memory } = colimaStartArgs();
  sayInstall(`Starting Colima (${cpu} CPUs, ${memory} GB RAM)… First start can take a few minutes.`);
  const listed = await run(colima, ["list"], { timeout: 20_000, env: dockerEnv() });
  if (/\bRunning\b/i.test(listed.out || "")) {
    sayInstall("Colima is already running.");
    return { ok: true, out: listed.out };
  }
  const hasProfile = /\bdefault\b/i.test(listed.out || "") && !/enoent|not found/i.test(listed.out || "");
  const args = hasProfile ? ["start"] : ["start", "--cpu", String(cpu), "--memory", String(memory), "--save-config"];
  const start = await run(colima, args, { timeout: 600_000, env: dockerEnv(), onData: sayInstallChunk });
  if (!start.ok) sayInstall((start.out || "colima start failed").slice(-800));
  return start;
}

async function brewInstallColima(): Promise<{ ok: boolean; out: string }> {
  const brew = brewPath();
  if (!brew) return { ok: false, out: "Homebrew not found." };
  sayInstall("Installing Colima and the Docker CLI with Homebrew…");
  const r = await run(brew, ["install", ...BREW_DOCKER_PACKAGES], {
    timeout: 420_000,
    env: { ...dockerEnv(), HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1" },
    onData: sayInstallChunk,
  });
  if (!r.ok) sayInstall((r.out || "brew install failed").slice(-800));
  return r;
}

async function installStaticColima(): Promise<{ ok: boolean }> {
  const destDir = sub8BinDir();
  const root = path.dirname(destDir);
  const platform = "darwin";
  const arch = process.arch;
  await fs.mkdir(destDir, { recursive: true });
  sayInstall("Downloading Docker CLI, Colima, and Lima into ~/.sub8/bin…");

  const indexUrl = dockerCliIndexUrl(platform, arch);
  const listing = await fetchText(indexUrl, { timeout: 45_000 });
  const tarball = pickLatestDockerTarball(listing);
  if (!tarball) throw new Error("Could not find a Docker CLI build on download.docker.com");
  const dockerTmp = path.join(os.tmpdir(), `sub8-${tarball}`);
  sayInstall(`Docker CLI ${tarball}`);
  await downloadToFile(indexUrl + tarball, dockerTmp);
  const extractDir = path.join(os.tmpdir(), `sub8-docker-cli-${process.pid}`);
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  const tarDocker = await run("tar", ["-xzf", dockerTmp, "-C", extractDir], { timeout: 60_000 });
  if (!tarDocker.ok) throw new Error(tarDocker.out || "Could not extract Docker CLI");
  const dockerSrc = path.join(extractDir, "docker", "docker");
  if (!fsSync.existsSync(dockerSrc)) throw new Error("Docker CLI tarball did not contain docker/docker");
  await fs.copyFile(dockerSrc, path.join(destDir, "docker"));
  await fs.chmod(path.join(destDir, "docker"), 0o755);
  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});

  const colimaName = colimaBinaryName(platform, arch);
  const colimaUrl = `https://github.com/abiosoft/colima/releases/latest/download/${colimaName}`;
  sayInstall(`Colima ${colimaName}`);
  const colimaDest = path.join(destDir, "colima");
  await downloadToFile(colimaUrl, `${colimaDest}.tmp`);
  await fs.rename(`${colimaDest}.tmp`, colimaDest);
  await fs.chmod(colimaDest, 0o755);

  const limaArch = arch === "arm64" ? "arm64" : "x86_64";
  const lima = await latestGithubAsset("lima-vm/lima", new RegExp(`^lima-\\d[\\w.+-]*-Darwin-${limaArch}\\.tar\\.gz$`));
  sayInstall(`Lima ${lima.name}`);
  const limaTmp = path.join(os.tmpdir(), lima.name);
  await downloadToFile(lima.url, limaTmp);
  const tarLima = await run("tar", ["-xzf", limaTmp, "-C", root], { timeout: 60_000 });
  if (!tarLima.ok) throw new Error(tarLima.out || "Could not extract Lima");
  for (const name of ["limactl", "lima"]) {
    const p = path.join(destDir, name);
    if (fsSync.existsSync(p)) await fs.chmod(p, 0o755).catch(() => {});
  }
  sayInstall(`Installed engine tools in ${destDir}`);
  return { ok: true };
}

async function installLinuxEngine(): Promise<{ ok: boolean; out?: string | undefined }> {
  sayInstall("Installing Docker Engine (needs an admin prompt)…");
  const first = await linuxPrivilege("curl -fsSL https://get.docker.com | sh", { timeout: 420_000 });
  if (!first.ok) {
    sayInstall("Official installer failed; trying the distro package…");
    let pkg = { ok: false, out: first.out || "" };
    if (fsSync.existsSync("/usr/bin/apt-get")) {
      pkg = await linuxPrivilege(
        "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io",
        { timeout: 420_000 },
      );
    } else if (fsSync.existsSync("/usr/bin/dnf")) {
      pkg = await linuxPrivilege("dnf install -y docker", { timeout: 420_000 });
    } else if (fsSync.existsSync("/usr/bin/pacman")) {
      pkg = await linuxPrivilege("pacman -S --noconfirm docker", { timeout: 420_000 });
    }
    if (!pkg.ok) {
      return { ok: false, out: pkg.out || first.out || "Could not install Docker Engine." };
    }
  }
  const user = os.userInfo().username || process.env.USER || "";
  if (user) {
    sayInstall(`Adding ${user} to the docker group…`);
    await linuxPrivilege(`usermod -aG docker '${String(user).replace(/'/g, "")}'`, { timeout: 30_000 });
  }
  sayInstall("Starting the Docker service…");
  await linuxStartDocker();
  await sleep(2000);
  return { ok: true };
}

async function wingetInstallDesktop(): Promise<RunResult> {
  const winget = wingetBin() || "winget";
  sayInstall("Installing Docker Desktop with winget…");
  const r = await run(
    winget,
    [
      "install",
      "-e",
      "--id",
      "Docker.DockerDesktop",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    { timeout: 600_000, env: dockerEnv(), onData: sayInstallChunk },
  );
  return r;
}

async function downloadAndRunDesktopInstaller(): Promise<RunResult> {
  const url = dockerDesktopInstallerUrl("win32", process.arch);
  const dest = path.join(os.tmpdir(), "DockerDesktopInstaller.exe");
  sayInstall("Downloading Docker Desktop installer…");
  await downloadToFile(url, dest, { timeout: 300_000 });
  sayInstall("Launching Docker Desktop installer…");
  const quiet = await run(dest, ["install", "--quiet", "--accept-license"], { timeout: 600_000, onData: sayInstallChunk });
  if (quiet.ok) return quiet;
  sayInstall("Quiet install didn’t finish; opening the installer…");
  return run(dest, ["install"], { timeout: 600_000, onData: sayInstallChunk });
}

async function finishInstall(action: string, extraHint: string = ""): Promise<InstallResult> {
  invalidateDockerCache();
  await sleep(1500);
  const status = await dockerStatusFresh();
  let hint = "";
  if (!status.ok) {
    hint = extraHint || status.hint || `Docker is not ready yet. ${dockerDocsUrl()}`;
    if (process.platform === "linux") {
      const info = await docker(["info"], { timeout: 8_000 });
      if (/permission denied|dial unix/i.test(info.out || "")) {
        hint = "Docker Engine is installed. Log out and back in so your account can use it, then click Start Docker.";
      }
    }
  }
  if (hint) sayInstall(hint);
  else sayInstall("Docker is ready.");
  return { ok: status.ok, action, log: installJob.log.slice(-8000), docker: decorateDocker(status), hint };
}

async function installDockerInner(): Promise<InstallResult> {
  invalidateDockerCache();
  let docker = await dockerStatusFresh();
  if (docker.ok) {
    sayInstall("Docker is already running.");
    return { ok: true, action: "noop", log: installJob.log, docker: decorateDocker(docker), hint: "" };
  }

  const facts = probeDockerInstallFacts(docker);
  const plan = planDockerInstall(facts);
  installJob.action = plan.action;
  sayInstall(`Using ${plan.action}.`);

  if (plan.action === "noop") {
    return { ok: true, action: "noop", log: installJob.log, docker: decorateDocker(docker), hint: "" };
  }

  if (plan.action === "recover") {
    const r = await recoverDocker();
    if (r.log) sayInstall(r.log);
    return {
      ok: r.ok,
      action: r.action || "recover",
      log: installJob.log.slice(-8000),
      docker: r.docker || decorateDocker(await dockerStatusFresh()),
      hint: r.ok ? "" : r.docker?.hint || docker.hint || "",
    };
  }

  if (plan.action === "start-desktop") {
    sayInstall("Starting Docker Desktop…");
    const started = await startDockerDesktop(facts.platform);
    if (started.log) sayInstall(started.log);
    return finishInstall("start-desktop");
  }

  if (plan.action === "brew-colima") {
    const brew = await brewInstallColima();
    if (!brew.ok) {
      sayInstall("Homebrew install failed; trying standalone binaries…");
      await installStaticColima();
    }
    const start = await startColimaEngine();
    return finishInstall(start.ok ? "brew-colima" : "colima-start", start.ok ? "" : (start.out || "").slice(-400));
  }

  if (plan.action === "static-colima") {
    await installStaticColima();
    const start = await startColimaEngine();
    return finishInstall(start.ok ? "static-colima" : "colima-start", start.ok ? "" : (start.out || "").slice(-400));
  }

  if (plan.action === "engine-get-docker") {
    const eng = await installLinuxEngine();
    if (!eng.ok) {
      const hint = `Could not install Docker Engine. ${dockerDocsUrl("linux")}`;
      sayInstall(hint);
      invalidateDockerCache();
      docker = await dockerStatusFresh();
      return { ok: false, action: "engine-get-docker", log: installJob.log.slice(-8000), docker: decorateDocker(docker), hint };
    }
    return finishInstall("engine-get-docker");
  }

  if (plan.action === "winget-desktop") {
    const wg = await wingetInstallDesktop();
    if (!wg.ok) {
      sayInstall("winget failed; downloading the official installer…");
      const dl = await downloadAndRunDesktopInstaller();
      if (!dl.ok) sayInstall((dl.out || "installer failed").slice(-400));
    }
    const desktop = dockerDesktopPath("win32");
    if (desktop && fsSync.existsSync(desktop)) await startDockerDesktop("win32");
    return finishInstall(wg.ok ? "winget-desktop" : "download-desktop");
  }

  if (plan.action === "download-desktop") {
    const dl = await downloadAndRunDesktopInstaller();
    if (!dl.ok) {
      const hint = `Could not run the Docker Desktop installer. ${dockerDocsUrl("win32")}`;
      sayInstall(hint);
      invalidateDockerCache();
      docker = await dockerStatusFresh();
      return { ok: false, action: "download-desktop", log: installJob.log.slice(-8000), docker: decorateDocker(docker), hint };
    }
    const desktop = dockerDesktopPath("win32");
    if (desktop && fsSync.existsSync(desktop)) await startDockerDesktop("win32");
    return finishInstall("download-desktop");
  }

  const hint = `This system is not supported for in-app Docker install. ${dockerDocsUrl()}`;
  sayInstall(hint);
  return { ok: false, action: plan.action || "unsupported", log: installJob.log, docker: decorateDocker(docker), hint };
}

export async function installDocker(): Promise<InstallResult> {
  if (installInflight) return installInflight;
  installJob.busy = true;
  installJob.action = "install";
  installJob.log = "";
  installInflight = (async () => {
    try {
      return await installDockerInner();
    } catch (err) {
      sayInstall(String((err as Error).message || err));
      invalidateDockerCache();
      const docker = await dockerStatusFresh();
      const hint = `${(err as Error).message || "Install failed"}. ${dockerDocsUrl()}`;
      return { ok: false, action: installJob.action || "install", log: installJob.log.slice(-8000), docker: decorateDocker(docker), hint };
    } finally {
      installJob.busy = false;
      installInflight = null;
    }
  })();
  return installInflight;
}

export async function startExistingContainer(
  name: string | null | undefined,
): Promise<{ ok: boolean; out?: string | undefined }> {
  if (!name) return { ok: false };
  const r = await docker(["start", name], { timeout: 30_000 });
  invalidateDockerCache();
  return { ok: r.ok, out: r.out };
}

export function containerName(botId: string): string {
  return `localbot-${botId.slice(0, 8)}`;
}

const grokLoginJobs = new Map<string, GrokLoginJob>();
let hostLoginChild: ChildProcess | null = null;

/** One in-flight `grok login --oauth` inside a desk. */
interface GrokLoginJob {
  url: string;
  done: boolean;
  ok: boolean;
  out: string;
  child: ChildProcess | null;
}

export function dockerSpawn(args: readonly string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(dockerBin(), args, {
    env: dockerEnv(),
    stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
    windowsHide: true,
    ...opts,
  });
}

export function hostGrokAuthPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  return path.join(home, ".grok", "auth.json");
}

export async function hostHasGrokAuth(): Promise<boolean> {
  try {
    const raw = await fs.readFile(hostGrokAuthPath(), "utf8");
    const data = JSON.parse(raw);
    return Boolean(data && typeof data === "object" && Object.keys(data).length);
  } catch {
    return false;
  }
}

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcffaedfe, 0xcefaedfe, 0xbebafeca,
]);

export function looksLikeElf(buf: unknown): boolean {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(ELF_MAGIC);
}

export function looksLikeMachO(buf: unknown): boolean {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  return MACHO_MAGICS.has(buf.readUInt32BE(0));
}

/** Only copy a host grok into Linux webtop when the host binary is ELF. */
export function shouldCopyHostGrok(headerBuf: unknown): boolean {
  return looksLikeElf(headerBuf);
}

export function linuxGrokArtifactUrl({
  arch = "aarch64",
  version = "",
}: { arch?: string | undefined; version?: string | undefined } = {}): string {
  const a = arch === "arm64" || arch === "aarch64" ? "aarch64" : "x86_64";
  const v = String(version || "").trim();
  return v ? `https://x.ai/cli/grok-${v}-linux-${a}` : `https://x.ai/cli/grok-linux-${a}`;
}

function readMagic(filePath: string): Buffer {
  try {
    const fd = fsSync.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    const n = fsSync.readSync(fd, buf, 0, 4, 0);
    fsSync.closeSync(fd);
    return n >= 4 ? buf : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

async function deskGrokIsLinux(container: string): Promise<boolean> {
  const r = await docker(
    [
      "exec",
      container,
      "python3",
      "-c",
      "import pathlib,sys; p=pathlib.Path('/usr/local/bin/grok'); sys.exit(0 if p.is_file() and p.read_bytes()[:4]==b'\\x7fELF' else 1)",
    ],
    { timeout: 8_000 },
  );
  return Boolean(r.ok);
}

export async function pushHostGrokBin(container: string | null | undefined): Promise<{
  ok: boolean;
  already?: boolean | undefined;
  copied?: boolean | undefined;
  installed?: boolean | undefined;
  error?: string | undefined;
}> {
  if (!container) return { ok: false };
  if (await deskGrokIsLinux(container)) return { ok: true, already: true };
  const { grokBin } = await import("./host-cli.mjs");
  const bin = grokBin();
  if (bin && fsSync.existsSync(bin) && shouldCopyHostGrok(readMagic(bin))) {
    const cp = await docker(["cp", bin, `${container}:/usr/local/bin/grok`], { timeout: 30_000 });
    if (cp.ok) {
      await docker(["exec", "-u", "root", container, "bash", "-lc", "chmod 755 /usr/local/bin/grok"]);
      return { ok: true, copied: true };
    }
  }
  const inst = await docker(
    [
      "exec",
      "-u",
      "abc",
      "-e",
      "HOME=/config",
      container,
      "bash",
      "-lc",
      "curl -fsSL https://x.ai/cli/install.sh | bash",
    ],
    { timeout: 180_000 },
  );
  if (!inst.ok) return { ok: false, error: inst.out || "linux grok install failed" };
  const link = await docker(
    [
      "exec",
      "-u",
      "root",
      container,
      "bash",
      "-lc",
      "src=$(readlink -f /config/.grok/bin/grok 2>/dev/null || echo /config/.grok/bin/grok); install -m 755 \"$src\" /usr/local/bin/grok",
    ],
    { timeout: 15_000 },
  );
  if (!link.ok) return { ok: false, error: link.out || "place grok failed" };
  await docker([
    "exec",
    "-u",
    "root",
    container,
    "bash",
    "-lc",
    "chown -R abc:abc /config/.grok && chmod 600 /config/.grok/auth.json 2>/dev/null || true",
  ]);
  return { ok: true, installed: true };
}

export async function pushHostGrokAuth(
  container: string,
): Promise<{ ok: boolean; error?: string | undefined; out?: string | undefined }> {
  const src = hostGrokAuthPath();
  if (!(await hostHasGrokAuth())) return { ok: false, error: "No Grok session on this Mac yet." };
  await docker(["exec", container, "bash", "-lc", "mkdir -p /config/.grok && chown abc:abc /config/.grok"]);
  const cp = await docker(["cp", src, `${container}:/config/.grok/auth.json`]);
  if (!cp.ok) return { ok: false, error: cp.out || "copy failed" };
  await pushHostGrokBin(container).catch(() => {});
  await docker([
    "exec",
    container,
    "bash",
    "-lc",
    "chown -R abc:abc /config/.grok && chmod 600 /config/.grok/auth.json 2>/dev/null || true",
  ]);
  return grokSignedIn(container);
}

export async function pushHostGrokAuthAll(): Promise<Array<{ name: string; ok: boolean }>> {
  const listed = await docker(["ps", "--format", "{{.Names}}", "--filter", "name=localbot-"], { timeout: 8_000 });
  const names = (listed.out || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.startsWith("localbot-"));
  const results = [];
  for (const name of names) results.push({ name, ...(await pushHostGrokAuth(name)) });
  return results;
}

export function startHostGrokOAuth(): { started: boolean } {
  if (hostLoginChild && !hostLoginChild.killed) return { started: true };
  hostLoginChild = spawn("grok", ["login", "--oauth"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
  });
  hostLoginChild.on("close", () => {
    hostLoginChild = null;
    pushHostGrokAuthAll().catch(() => {});
  });
  return { started: true };
}

export function grokVmArgs(container: string, grokArgs: readonly string[]): string[] {
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

export async function grokSignedIn(container: string): Promise<{ ok: boolean; out: string }> {
  await docker(["exec", container, "bash", "-lc", "chown -R abc:abc /config/.grok 2>/dev/null || true"]);
  const r = await docker(grokVmArgs(container, ["models"]), { timeout: 25_000 });
  const t = (r.out || "").toLowerCase();
  if (/not signed in|not logged in|please log in|run `?grok login/i.test(t)) return { ok: false, out: r.out };
  if (r.ok && !/not signed in/i.test(t)) return { ok: true, out: r.out };
  return { ok: false, out: r.out };
}

export function startGrokOAuth(container: string): GrokLoginJob {
  const prev = grokLoginJobs.get(container);
  if (prev?.child && !prev.done) {
    return prev;
  }
  const job: GrokLoginJob = { url: "", done: false, ok: false, out: "", child: null };
  grokLoginJobs.set(container, job);
  docker(["exec", container, "bash", "-lc", "chown -R abc:abc /config/.grok 2>/dev/null || true"]).catch(() => {});
  const child = dockerSpawn(grokVmArgs(container, ["login", "--oauth"]));
  job.child = child;
  const grabUrl = (chunk: string) => {
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
  // dockerSpawn pipes both streams unless a caller overrides stdio; this one does not.
  child.stdout!.on("data", (d: Buffer) => grabUrl(d.toString()));
  child.stderr!.on("data", (d: Buffer) => grabUrl(d.toString()));
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

export function grokOAuthStatus(
  container: string,
): { started: boolean; url: string; done: boolean; ok: boolean; out?: string | undefined } {
  const job = grokLoginJobs.get(container);
  if (!job) return { started: false, url: "", done: false, ok: false };
  return { started: true, url: job.url, done: job.done, ok: job.ok, out: (job.out || "").slice(-400) };
}

async function portFree(port: number): Promise<boolean> {
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

export async function allocatePort(): Promise<number> {
  const run = portLock.then(async () => {
    for (let p = START_PORT; p < START_PORT + 80; p++) {
      let ok = true;
      for (let i = 0; i < DISPLAY_SLOTS + 1; i++) {
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

/** One host port for container 3011. Prefer novnc+8 when free; else a port that is not a neighbor desk's noVNC. */
export async function allocateHarnessPort(preferred?: unknown): Promise<number> {
  const run = portLock.then(async () => {
    const want = Number(preferred);
    if (Number.isFinite(want) && want > 0 && (await portFree(want))) return want;
    for (let p = START_PORT + 80; p < START_PORT + 180; p++) {
      if (await portFree(p)) return p;
    }
    throw new Error("No free desk-harness port");
  });
  portLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

function progressLogger(onLog: LogFn, prefix: string): (chunk: unknown) => void {
  let last = 0;
  let lastPct = -1;
  return (chunk: unknown) => {
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

export async function ensureImage(onLog: LogFn = () => {}): Promise<void> {
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

  const haveSlim = await docker(["image", "inspect", "-f", "{{.Created}}", SLIM_IMAGE], { timeout: 8_000 });
  const created = haveSlim.ok ? Date.parse(String(haveSlim.out || "").trim()) || 0 : 0;
  if (haveSlim.ok) {
    resolvedImage = SLIM_IMAGE;
    if (shouldRebuildSlim(created, slimSourceMtimes())) scheduleSlimRebuild(onLog);
    return;
  }

  await buildSlimImage(onLog, { first: true });
}

let slimRebuild: Promise<boolean> | null = null;

function scheduleSlimRebuild(onLog: LogFn): Promise<boolean> {
  if (slimRebuild) return slimRebuild;
  onLog("Computer image is out of date; rebuilding in the background. Existing desks keep running.");
  slimRebuild = buildSlimImage(onLog, { first: false }).finally(() => {
    slimRebuild = null;
  });
  return slimRebuild;
}

async function buildSlimImage(onLog: LogFn, { first }: { first?: boolean | undefined } = {}): Promise<boolean> {
  const ctx = path.resolve(fileRoot, "vm");
  if (first) onLog("Building the computer image (Debian 13, one-time). Later computers reuse it.");
  const built = await docker(["build", "--platform", dockerPlatform(), "-t", SLIM_IMAGE, "-f", "Dockerfile", "."], {
    timeout: 600_000,
    cwd: ctx,
    onData: progressLogger(onLog, "Building"),
  });
  if (built.ok) {
    resolvedImage = SLIM_IMAGE;
    onLog("Computer image is ready.");
    return true;
  }
  if (!first) {
    onLog("Rebuild failed; keeping the current computer image.");
    resolvedImage = SLIM_IMAGE;
    return false;
  }
  onLog(`Slim image build failed, falling back to ${FALLBACK_IMAGE}…`);
  const pull = await docker(["pull", "--platform", dockerPlatform(), FALLBACK_IMAGE], {
    timeout: 600_000,
    onData: progressLogger(onLog, "Downloading"),
  });
  if (!pull.ok) throw new Error(`docker pull failed: ${pull.out.slice(-800)}`);
  resolvedImage = FALLBACK_IMAGE;
  return false;
}

export function configVolume(bot: Bot): string {
  return bot.vm?.volume || `localbot-config-${String(bot.id || "bot").slice(0, 8)}`;
}

export function vmNames(
  bot: Bot,
  computer?: { container?: string | null | undefined; volume?: string | null | undefined } | null | undefined,
): { name: string | null; volume: string | null } {
  const name = computer?.container || bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  const volume = computer?.volume || bot.vm?.volume || (bot.id ? configVolume(bot) : null);
  return { name, volume };
}

export async function inspectState(
  name: string | null | undefined,
  { force = false }: { force?: boolean | undefined } = {},
): Promise<ContainerState> {
  if (!name) return { exists: false, status: "missing", running: false, paused: false, stuck: false };
  const list = await listLocalbotStates({ force });
  if (list.stuck) return { exists: false, status: "unknown", running: false, paused: false, stuck: true };
  return list.states.get(name) || { exists: false, status: "missing", running: false, paused: false, stuck: false };
}

export function isContainerNameConflict(out: unknown): boolean {
  return /already in use by container|name .* is already in use/i.test(String(out || ""));
}

export async function pauseContainer(
  name: string | null | undefined,
): Promise<{ ok: boolean; error?: string | undefined; status: string }> {
  const st = await inspectState(name);
  if (st.stuck) return { ok: false, error: "docker stuck", status: "unknown" };
  if (!st.exists) return { ok: false, error: "missing", status: "missing" };
  if (st.paused) return { ok: true, status: "paused" };
  if (!st.running) return { ok: false, error: "not running", status: st.status };
  // inspectState() answers `exists: false` for a missing name, so getting past
  // the guard above proves there is one. Same in resumeContainer below.
  const r = await docker(["pause", name!], { timeout: 15_000 });
  if (!r.ok) return { ok: false, error: r.out || "pause failed", status: st.status };
  invalidateDockerCache();
  return { ok: true, status: "paused" };
}

export async function resumeContainer(
  name: string | null | undefined,
): Promise<{ ok: boolean; error?: string | undefined; status: string }> {
  // Force a fresh inspect. listLocalbotStates caches `docker ps` for 2s, and a
  // desk paused out of band (Docker Desktop, `docker pause`, the other Sub8
  // process) still read as running through that cache — so `docker unpause`
  // never ran, resume reported ok, and the caller waited forever on a container
  // that was still frozen.
  const st = await inspectState(name, { force: true });
  if (st.stuck) return { ok: false, error: "docker stuck", status: "unknown" };
  if (!st.exists) return { ok: false, error: "missing", status: "missing" };
  if (!st.paused) return { ok: true, status: st.running ? "running" : st.status };
  const r = await docker(["unpause", name!], { timeout: 15_000 });
  if (!r.ok) return { ok: false, error: r.out || "unpause failed", status: st.status };
  invalidateDockerCache();
  return { ok: true, status: "running" };
}

export async function rebootContainer(name: string | null | undefined): Promise<{
  ok: boolean;
  error?: string | undefined;
  status: string;
  novncPort?: number | null | undefined;
}> {
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
      return {
        ok: false,
        error: (err as Error).message || "desktop did not come back",
        status: "starting",
        novncPort: port,
      };
    }
  }
  return { ok: true, status: "running", novncPort: port };
}

export async function stopContainer(
  name: string | null | undefined,
): Promise<{ ok: boolean; error?: string | undefined; status: string }> {
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

function memToBytes(raw: unknown): number {
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

export async function containerStats(names: readonly string[] = []): Promise<
  Record<
    string,
    { mem: string; memLimit: string; memBytes: number; limitBytes: number; memPct: number; cpu: string }
  >
> {
  const want = new Set(names.filter(Boolean));
  if (!want.size) return {};
  const r = await docker(
    ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}", ...want],
    { timeout: 8_000 },
  );
  const out: Record<
    string,
    { mem: string; memLimit: string; memBytes: number; limitBytes: number; memPct: number; cpu: string }
  > = {};
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

export async function startVm(
  bot: Bot,
  onLog: LogFn = () => {},
  shouldAbort: () => boolean | Promise<boolean> = async () => false,
): Promise<VmStartInfo> {
  const dock = await dockerStatus();
  if (!dock.ok) throw new Error(dock.hint);
  const name = bot.vm?.container || containerName(bot.id);
  const volume = bot.vm?.volume || configVolume(bot);
  const abortIfGone = async () => {
    if (!(await shouldAbort())) return;
    await docker(["rm", "-f", name], { timeout: 20_000 });
    throw new Error("bot deleted");
  };
  const existing = await inspectState(name, { force: true });
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
  const live = await inspectState(name, { force: true });
  if (live.exists && (live.running || live.paused)) {
    await abortIfGone();
    const mapped = live.novncPort || (await detectMappedPort(name));
    const port = resolveStreamPort(bot.vm?.novncPort, mapped);
    let published = mappedHarnessPort(live.portMap) || (await detectMappedPort(name, HARNESS_PORT));
    if (port && !published) {
      if (live.paused) await resumeContainer(name);
      published = await publishHarnessWithoutRecreate(name, port, onLog).catch((err) => {
        onLog(`desk brain proxy skipped: ${err.message || err}`);
        return null;
      });
    }
    const chrome = await chromeReady(name);
    finishDesktopSetup(name, onLog).catch((err) => onLog(String(err.message || err)));
    const info = {
      container: name,
      novncPort: port,
      harnessPort: published || null,
      status: chrome ? "running" : "starting",
      display: bot.vm?.display || ":1",
      volume,
      setup: setupProgress(name),
    };
    await writeDeskMcpConfig(name, { botId: bot.id, display: info.display }).catch(() => {});
    return info;
  }
  if (live.exists) await docker(["rm", "-f", name], { timeout: 20_000 });

  await ensureImage(onLog);
  await abortIfGone();
  await docker(["volume", "create", volume], { timeout: 20_000 });
  const port = await allocatePort();
  const hport = await allocateHarnessPort(harnessHostPort(port));
  onLog(`Starting computer on port ${port}…`);
  const runr = await docker(deskCreateArgs({ name, volume, port, image: resolvedImage, harnessPort: hport }), { timeout: 60_000 });
  if (!runr.ok) {
    if (isContainerNameConflict(runr.out)) {
      invalidateDockerCache();
      const again = await inspectState(name, { force: true });
      if (again.exists && !again.running && !again.paused) await startExistingContainer(name);
      const reuse = await inspectState(name, { force: true });
      if (reuse.exists && (reuse.running || reuse.paused)) {
        onLog("Computer is already running.");
        const mapped = reuse.novncPort || (await detectMappedPort(name));
        const bound = resolveStreamPort(bot.vm?.novncPort, mapped);
        const harnessPort = mappedHarnessPort(reuse.portMap) || (await detectMappedPort(name, HARNESS_PORT));
        const chrome = await chromeReady(name);
        finishDesktopSetup(name, onLog).catch((err) => onLog(String(err.message || err)));
        const reused = {
          container: name,
          novncPort: bound,
          harnessPort: harnessPort || null,
          status: chrome ? "running" : "starting",
          display: bot.vm?.display || ":1",
          volume,
          setup: setupProgress(name),
        };
        await writeDeskMcpConfig(name, { botId: bot.id, display: reused.display }).catch(() => {});
        return reused;
      }
    }
    throw new Error(`docker run failed: ${runr.out.slice(-800)}`);
  }
  invalidateDockerCache();
  await abortIfGone();

  await waitHttp(`http://127.0.0.1:${port}/`, 90_000, onLog, shouldAbort);
  await abortIfGone();
  setSetup(name, 1, "Starting desktop");
  onLog(setupLine(setupProgress(name)));
  finishDesktopSetup(name, onLog).catch((err) => onLog(String(err.message || err)));
  const chrome = await chromeReady(name);
  const started = {
    container: name,
    novncPort: port,
    harnessPort: hport,
    status: chrome ? "running" : "starting",
    display: bot.vm?.display || ":1",
    volume,
    setup: setupProgress(name),
  };
  await writeDeskMcpConfig(name, { botId: bot.id, display: started.display }).catch(() => {});
  return started;
}

const SETUP_TOTAL = 4;

/** Per-container setup bookkeeping: the ladder position and the in-flight run. */
interface SetupJob {
  progress?: SetupProgress | undefined;
  ready?: boolean | undefined;
  running?: Promise<void> | null | undefined;
}

const setupJobs = new Map<string, SetupJob>();

function setSetup(name: string, step: number, label: string, ready = false): SetupProgress {
  const job: SetupJob = setupJobs.get(name) || {};
  if (job.progress?.ready && !ready) return job.progress;
  const progress = { step, total: SETUP_TOTAL, label, ready };
  job.progress = progress;
  job.ready = ready;
  setupJobs.set(name, job);
  return progress;
}

export function setupProgress(name: string): SetupProgress {
  return setupJobs.get(name)?.progress || { step: 0, total: SETUP_TOTAL, label: "", ready: false };
}

const chromeCache = new Map<string, { at: number; value: boolean; inflight: Promise<boolean> | null }>();
const CHROME_TTL_MS = 12_000;

export async function chromeReady(name: string | null | undefined): Promise<boolean> {
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

function setupLine(p: SetupProgress | null | undefined): string {
  if (!p) return "Setting up the computer…";
  if (p.ready) return "Computer is ready.";
  return `Setting up the computer (${p.step}/${p.total}): ${p.label}`;
}

async function markReadyIfChrome(name: string, onLog: LogFn): Promise<boolean> {
  if (setupProgress(name).ready) return true;
  if (!(await chromeReady(name))) return false;
  setSetup(name, SETUP_TOTAL, "Ready", true);
  onLog("Computer is ready.");
  return true;
}

async function finishDesktopSetup(name: string, onLog: LogFn): Promise<void> {
  const job: SetupJob = setupJobs.get(name) || {};
  if (job.running) return job.running;
  const say = (step: number, label: string) => {
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
        setSetup(name, setupProgress(name).step || 3, (err as Error).message || "setup failed", false);
      }
      throw err;
    } finally {
      job.running = null;
    }
  })();
  setupJobs.set(name, job);
  return job.running;
}

export async function detectMappedPort(name: string, containerPort: number = 3000): Promise<number | null> {
  const r = await docker(["port", name, `${containerPort}/tcp`], { timeout: 8_000 });
  const m = r.out.match(/:(\d+)/);
  return m ? Number(m[1]) : null;
}

export function cachedMappedPort(name: string | null | undefined): number | null {
  if (!name || !containerListCache.value?.states) return null;
  return containerListCache.value.states.get(name)?.novncPort || null;
}

export function cachedHarnessPort(name: string | null | undefined): number | null {
  if (!name || !containerListCache.value?.states) return null;
  return containerListCache.value.states.get(name)?.harnessPort || null;
}

export function cachedPortMap(name: string | null | undefined): PortMap | null {
  if (!name || !containerListCache.value?.states) return null;
  return containerListCache.value.states.get(name)?.portMap || null;
}

async function waitHttp(
  url: string,
  timeoutMs: number,
  onLog: LogFn,
  shouldAbort?: (() => boolean | Promise<boolean>) | undefined,
): Promise<void> {
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
function withSetupLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = setupLock.then(fn, fn);
  setupLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function ensureTools(name: string, onLog: LogFn): Promise<void> {
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

async function appsReady(name: string): Promise<boolean> {
  return chromeReady(name);
}

async function ensureApps(name: string, onLog: LogFn): Promise<void> {
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
      await installDeskFonts(name);
      await installChromeDesk(name);
      await installDeskDoctor(name);
      await installDeskHarness(name);
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

export const ENSURE_NODE_CMD =
  "command -v node >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nodejs)";

export async function ensureNodeInDesk(
  container: string | null | undefined,
): Promise<{ ok: boolean; out?: string | undefined }> {
  if (!container) return { ok: false };
  const r = await docker(["exec", "-u", "root", container, "bash", "-lc", ENSURE_NODE_CMD], { timeout: 180_000 });
  return { ok: r.ok, out: r.out };
}

export async function installDeskHarness(container: string): Promise<{ ok: boolean }> {
  const host = path.resolve(fileRoot, "vm", "desk-harness.py");
  const cp = await docker(["cp", host, `${container}:/usr/local/bin/desk-harness`], { timeout: 15_000 });
  if (!cp.ok) return { ok: false };
  await docker(["exec", "-u", "root", container, "bash", "-lc", "chmod 755 /usr/local/bin/desk-harness"]);
  await pushHostGrokBin(container).catch(() => {});
  const mcp = path.resolve(fileRoot, "server", "mcp-desk.mjs");
  const iso = path.resolve(fileRoot, "server", "isolation.mjs");
  await docker(["exec", "-u", "root", container, "bash", "-lc", "mkdir -p /usr/local/lib/sub8"]);
  await docker(["cp", mcp, `${container}:/usr/local/lib/sub8/mcp-desk.mjs`]);
  await docker(["cp", iso, `${container}:/usr/local/lib/sub8/isolation.mjs`]);
  await ensureNodeInDesk(container).catch(() => {});
  await docker([
    "exec",
    "-u",
    "abc",
    container,
    "bash",
    "-lc",
    `mkdir -p /config/.grok && cat > /config/.grok/config.toml << 'EOF'
[mcp_servers.sub8]
command = "node"
args = ["/usr/local/lib/sub8/mcp-desk.mjs"]
EOF
command -v node >/dev/null || true`,
  ]);
  // `-d`, not a trailing `&`: docker tears the exec's children down with the
  // exec, so the backgrounded form left the desk with no harness at all — and
  // no harness means no POST /stop when the user presses Stop.
  const running = await docker(["exec", "-u", "abc", container, "bash", "-lc", "pgrep -f '/usr/local/bin/desk-harness' >/dev/null"]);
  if (!running.ok) {
    await docker([
      "exec",
      "-d",
      "-u",
      "abc",
      container,
      "bash",
      "-lc",
      "python3 /usr/local/bin/desk-harness >/tmp/desk-harness.log 2>&1",
    ]);
  }
  return { ok: true };
}

export async function installOctoVault(container: string): Promise<void> {
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

export async function installDeskFonts(container: string | null | undefined): Promise<void> {
  if (!container) return;
  await docker(
    [
      "exec",
      "-u",
      "root",
      container,
      "bash",
      "-lc",
      "if fc-list :lang=th 2>/dev/null | grep -q .; then echo FONTS_OK; exit 0; fi; apt-get update -qq && apt-get install -y --no-install-recommends fonts-noto-core && fc-cache -f && echo FONTS_OK",
    ],
    { timeout: 180_000 },
  );
}

export async function installOctoClick(container: string): Promise<void> {
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

export async function installChromeDesk(container: string): Promise<void> {
  const deskHost = path.resolve(fileRoot, "vm", "chrome-desktop.sh");
  const oneTabHost = path.resolve(fileRoot, "vm", "chrome-one-tab.py");
  const desk = await docker(["cp", deskHost, `${container}:/tmp/chrome-desktop.sh`]);
  const one = await docker(["cp", oneTabHost, `${container}:/tmp/chrome-one-tab.py`]);
  const parts: string[] = [];
  if (desk.ok) parts.push("install -m 755 /tmp/chrome-desktop.sh /usr/local/bin/chrome-desktop");
  if (one.ok) parts.push("install -m 755 /tmp/chrome-one-tab.py /usr/local/bin/chrome-one-tab");
  const disp = await docker(["cp", path.resolve(fileRoot, "vm", "desk-display.sh"), `${container}:/tmp/desk-display.sh`]);
  const page = await docker(["cp", path.resolve(fileRoot, "vm", "page-agent.py"), `${container}:/tmp/page-agent.py`]);
  if (disp.ok) parts.push("install -m 755 /tmp/desk-display.sh /usr/local/bin/desk-display");
  if (page.ok) parts.push("install -m 755 /tmp/page-agent.py /usr/local/bin/page-agent");
  if (!parts.length) return;
  parts.push("ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/chrome");
  parts.push("ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/box-chrome");
  parts.push("mkdir -p /config/chrome-desk /config/workspace");
  parts.push("chown -R abc:abc /config/chrome-desk /config/workspace");
  parts.push("chown -R abc:abc /config/chrome-desk-* 2>/dev/null || true");
  await docker(["exec", "-u", "root", container, "bash", "-lc", parts.join(" && ")]);
  await docker([
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
    "ps -eo pid= -o args= | awk '/--type=/ {next} /crashpad/ {next} /user-data-dir=/ {next} /chrome-desktop|chrome-one-tab|box-chrome/ {next} /google-chrome|chromium|\\/chrome\\/chrome/ {print $1}' | while read -r pid; do kill \"$pid\" 2>/dev/null || true; done",
  ]).catch(() => {});
}

export async function installDeskDoctor(container: string): Promise<void> {
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

export async function writeDeskMcpConfig(
  container: string | null | undefined,
  {
    botId,
    display,
    internalUrl,
    internalToken,
  }: {
    botId?: string | undefined;
    display?: string | undefined;
    internalUrl?: string | undefined;
    internalToken?: string | undefined;
  } = {},
): Promise<{ ok: boolean }> {
  if (!container) return { ok: false };
  const { grokMcpToml } = await import("./mcp-desk.mjs");
  const url =
    internalUrl ||
    process.env.SUB8_DESK_HOST_URL ||
    `http://host.docker.internal:${process.env.PORT || 8787}`;
  const token = internalToken || process.env.SUB8_INTERNAL_TOKEN || "";
  const toml = grokMcpToml({
    env: {
      SUB8BOT_BOT_ID: botId || "",
      SUB8_INTERNAL_URL: url,
      SUB8_INTERNAL_TOKEN: token,
      SUB8_DISPLAY: String(display || ":1").replace(":", "") || "1",
    },
  });
  await mkdirpInContainer(container, "/config/.grok").catch(() => {});
  await writeFileToContainer(container, "/config/.grok/config.toml", toml);
  // 0600: this is the host API credential, and teammates added to a team copy
  // the chief's container (teams.addMember), so co-tenants shared it at 0644.
  if (token) await writeFileToContainer(container, "/config/.desk-token", token, { mode: "600" });
  return { ok: true };
}

export async function writeFileToContainer(
  container: string,
  dest: string,
  text: unknown,
  { mode }: { mode?: string | undefined } = {},
): Promise<void> {
  const tmp = path.join(os.tmpdir(), `sub8-vm-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fs.writeFile(tmp, String(text ?? ""), "utf8");
  try {
    const cp = await docker(["cp", tmp, `${container}:${dest}`]);
    if (!cp.ok) throw new Error(cp.out || `copy ${dest} failed`);
    // exec the binary directly -- no `bash -lc`. JSON.stringify escapes `"` and
    // `\` but NOT `$` or a backtick, and both expand inside double quotes, so a
    // model-chosen path like `note_$(...).md` used to run as ROOT in the box --
    // from `memory`/`update_state`, whose own shell tool is deliberately pinned
    // to the unprivileged `abc` user. docker() takes an argv array and never
    // spawns with shell:true, so the path stays a literal argument.
    // The old `2>/dev/null || true` only suppressed noise: the result is
    // already ignored, so a failed chown stays non-fatal.
    await docker(["exec", "-u", "root", container, "chown", "abc:abc", dest]);
    // `docker cp` carries the temp file's mode, which fs.writeFile leaves at
    // 0644. Fine for config, wrong for a credential in a container several
    // bots share.
    if (mode) await docker(["exec", "-u", "root", container, "chmod", mode, dest]);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function mkdirpInContainer(container: string, dir: unknown): Promise<void> {
  const d = String(dir || "");
  if (!d.startsWith("/config")) throw new Error("mkdir must be under /config");
  // argv, not `bash -lc`. JSON.stringify only adds double quotes, which do
  // NOT stop $(...) or backticks in bash -- and `dir` comes from a
  // model-chosen path (memory write/append, update_state target=memory). The
  // "/config" prefix check above is a path guard; it says nothing about shell
  // metacharacters, and this call never passes through assertVmShell.
  await docker(["exec", "-u", "abc", "-e", "HOME=/config", container, "mkdir", "-p", d]);
}

export async function readFileFromContainer(container: string, dest: string): Promise<string> {
  // argv, not `bash -lc` -- same reason as mkdirpInContainer above: `dest` is
  // a model-chosen path. The old `if [ -f ]` test only existed to return ""
  // for a missing file; a bare `cat` fails instead, and `r.ok` is false, which
  // reaches the same answer.
  const r = await docker(["exec", "-u", "abc", container, "cat", dest]);
  return r.ok ? String(r.out || "") : "";
}

export async function installAgentsMd(container: string, extra: string = ""): Promise<void> {
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

export async function stopVm(bot: Bot, { wipe = false }: { wipe?: boolean | undefined } = {}): Promise<void> {
  const name = bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  if (name) await docker(["rm", "-f", name]);
  if (wipe) {
    const volume = bot.vm?.volume || (bot?.id ? configVolume(bot) : null);
    if (volume) await docker(["volume", "rm", "-f", volume]);
  }
}

/**
 * Remove this install's localbot-* containers and config volumes that no longer
 * belong to a known bot.
 *
 * Scoped to THIS install, because containers share one global Docker namespace
 * while each data dir keeps its own registry. Sweeping on the bare `localbot-`
 * prefix meant starting one build force-removed the OTHER build's running
 * desks and wiped their config volumes — Chrome profile, grok auth, workspace,
 * everything — because they are absent from this registry by definition. The
 * `keep.size === 0` guard below did not cover it: it only fires when this
 * registry is completely empty, and one bot here is enough to arm the sweep.
 *
 * Containers created before the label existed carry none, so they are never
 * swept. That is deliberate: leaving a stranger's container alone costs disk,
 * removing it costs the user their desk.
 */
export async function sweepOrphans(
  keepNames: readonly string[] = [],
  keepVolumes: readonly string[] = [],
): Promise<string[]> {
  const keep = new Set(keepNames.filter(Boolean));
  const keepVol = new Set(keepVolumes.filter(Boolean));
  // Empty bot list = new data dir. Never delete every computer.
  if (keep.size === 0 && keepVol.size === 0) return [];
  const removed: string[] = [];
  if (keep.size) {
    const inspect = await docker([
      "ps",
      "-a",
      "--filter",
      `label=${INSTALL_LABEL}=${installId()}`,
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
      // No -f. Docker refuses to drop a volume any container still references,
      // running or stopped, which is what keeps another install's desk data
      // safe: we no longer remove their container, so their volume stays held.
      // A genuinely orphaned volume has no referrer and still goes.
      const drop = await docker(["volume", "rm", name]);
      if (drop.ok) removed.push(name);
    }
  }
  return removed;
}

export async function streamHealth(bot: Bot): Promise<{
  ok: boolean;
  container: string | null;
  running: boolean;
  novncPort: number | null;
  http: number;
  grok: boolean;
  chrome: boolean;
  x11: boolean;
  display: string;
}> {
  const name = bot.vm?.container || (bot.id ? containerName(bot.id) : null);
  const inspect = name ? await docker(["inspect", "-f", "{{.State.Running}}", name]) : { ok: false, out: "" };
  const running = inspect.ok && inspect.out.trim() === "true";
  const probe = async (p: number | null | undefined) => {
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
  let mapped: number | null = null;
  let portMap: PortMap | null = null;
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

export async function waitForDesktop(
  bot: Bot,
  {
    timeoutMs = 90_000,
    onLog = () => {},
    shouldAbort,
  }: {
    timeoutMs?: number | undefined;
    onLog?: LogFn | undefined;
    shouldAbort?: (() => boolean | Promise<boolean>) | undefined;
  } = {},
): Promise<{
  ok: boolean;
  reason?: string | undefined;
  health?: { ok: boolean; chrome: boolean } | undefined;
  setup?: SetupProgress | undefined;
}> {
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
      const again = await docker(["inspect", "-f", "{{.State.Running}} {{.State.Paused}}", name], { timeout: 8_000 });
      const [run, paused] = String(again.out || "").trim().split(/\s+/);
      if (again.ok && run === "true" && paused !== "true") {
        alive = true;
        break;
      }
      // Running=true is not enough: a PAUSED container reports Running=true and
      // every exec into it hangs, so this loop used to declare a frozen desk
      // alive and then wait out the whole timeout on it. Wake it instead.
      if (again.ok && paused === "true") {
        onLog("Waking the computer…");
        await resumeContainer(name);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (alive) {
    const st = await inspectState(name, { force: true });
    if (needsHarnessPublish(st.portMap)) {
      const hport = await publishHarnessWithoutRecreate(name, st.novncPort || bot.vm?.novncPort, onLog).catch((err) => {
        onLog(`desk brain proxy skipped: ${err.message || err}`);
        return null;
      });
      if (hport) bot.vm = { ...(bot.vm || {}), harnessPort: hport };
    }
  }
  if (!alive) {
    try {
      const info = await startVm(bot, onLog, shouldAbort);
      bot.vm = { ...bot.vm, ...info, error: null };
    } catch (err) {
      return { ok: false, reason: (err as Error).message || "Could not start the computer." };
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

export async function resetVm(bot: Bot, onLog: LogFn): Promise<VmStartInfo> {
  await stopVm(bot);
  // Blanking the container is how resetVm asks startVm for a fresh one. `null`
  // is the spelling the on-disk record uses; VmInfo only models the live shape.
  return startVm({ ...bot, vm: { ...bot.vm, container: null } } as unknown as Bot, onLog);
}

function displayEnv(bot: { vm?: { display?: string | undefined } | undefined }): string {
  return `export DISPLAY=${bot.vm?.display || ":1"}; export XAUTHORITY=/config/.Xauthority; export HOME=/config`;
}

const SCREEN_W = 1024;
const SCREEN_H = 768;

export function clampPoint(x: unknown, y: unknown): { x: number; y: number } {
  const cx = Math.round(Number(x));
  const cy = Math.round(Number(y));
  return {
    x: Number.isFinite(cx) ? Math.max(0, Math.min(SCREEN_W - 1, cx)) : 0,
    y: Number.isFinite(cy) ? Math.max(0, Math.min(SCREEN_H - 1, cy)) : 0,
  };
}

/** Keep the desktop at 1024x768 so click coords stay 1:1 with screenshots. */
export async function ensureDisplay(bot: Bot): Promise<void> {
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

function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf[0] !== 0x89) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function annotateShot(hostPath: string, x: number, y: number): Promise<Buffer | null> {
  const script = path.resolve(appRoot, "scripts", "annotate-shot.py");
  const tmp = `${hostPath}.ann.png`;
  const r = await new Promise<{ ok: boolean; out: string }>((resolve) => {
    const child = spawn("python3", [script, hostPath, tmp, String(Math.round(x)), String(Math.round(y))], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d));
    child.stderr?.on("data", (d: Buffer) => (out += d));
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

export function screenshotCmd(dest: string): string {
  return [
    `ffmpeg -y -nostdin -loglevel error -f x11grab -video_size ${SCREEN_W}x${SCREEN_H} -i "\${DISPLAY}.0" -frames:v 1 -update 1 ${dest}`,
    `scrot -o ${dest}`,
    `import -window root ${dest}`,
    `xwd -root -silent | convert xwd:- png:${dest}`,
  ].join(" || ");
}

async function takeScreenshotPng(bot: Bot, name: string, dest: string): Promise<RunResult> {
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

function missingShotTool(out: string = ""): boolean {
  return /not found|No such file|Unrecognized option|Invalid argument/i.test(out) && /ffmpeg|scrot|import|xwd|convert/i.test(out);
}

export function computerPreviewPath(id: string): string {
  return path.resolve(dataDir, "screens", `computer-${id}.png`);
}

/** Cloud desk: same computer tools, docker exec happens on the droplet via desk-agent. */
export function isRemoteDesk(bot: Bot | null | undefined): boolean {
  return Boolean(bot?.vm?.deskUrl && bot?.vm?.deskToken);
}

export async function remoteDesk(bot: Bot, body?: Record<string, unknown> | null | undefined): Promise<RemoteDeskReply> {
  const base = String(bot?.vm?.deskUrl || "").replace(/\/+$/, "");
  if (!base || !bot?.vm?.deskToken) throw new Error("no remote desk");
  const res = await fetch(`${base}/action`, {
    method: "POST",
    headers: {
      // The guard above threw unless vm and deskToken are both set.
      Authorization: `Bearer ${bot.vm!.deskToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...(body || {}), display: displayNum(bot) }),
    signal: AbortSignal.timeout(55_000),
  });
  const data = await res.json().catch(() => ({})) as RemoteDeskReply;
  if (!res.ok || data.ok === false) throw new Error(data.text || data.error || `desk ${res.status}`);
  return data;
}

async function remoteShot(bot: DeskBot): Promise<ShotResult> {
  const data = await remoteDesk(bot, { action: "screenshot", display: displayNum(bot) });
  if (!data.imageB64) throw new Error(data.text || "screenshot empty");
  const buf = Buffer.from(data.imageB64, "base64");
  const hostPath = path.resolve(dataDir, "screens", `${bot.id}.png`);
  await fs.mkdir(path.dirname(hostPath), { recursive: true });
  await fs.writeFile(hostPath, buf);
  return { path: hostPath, ...pngSize(buf), bytes: buf.length, buf, pointer: { x: -1, y: -1 } };
}

/**
 * Every process a desk runs FOR a bot carries this, so Stop can find that bot's
 * work — and only that bot's work. A desk is shared: CycleProbe, Scout and
 * Writer live in one container, so "kill everything that looks busy" would stop
 * a teammate mid-turn. Children inherit the environment through fork, exec and
 * setsid, which is what makes this survive grok detaching its shell tool.
 */
export const WORK_ENV = "SUB8_WORK";

/** `docker exec` args that mark in-container work as this bot's. */
export function workEnvArgs(botId: unknown): string[] {
  const id = workMark(botId);
  return id ? ["-e", `${WORK_ENV}=${id}`] : [];
}

function workMark(botId: unknown): string {
  return String(botId || "").replace(/[^A-Za-z0-9._-]/g, "");
}

/**
 * Kill this bot's work inside the desk.
 *
 * The marker sweep is the general case: it reaches a `bash -lc` from vm.shell,
 * a grok the in-desk harness started, and the shell children grok re-parents to
 * pid 1 — none of which the old grok-only pattern matched, which is how a
 * `sleep 300` outlived a Stop that reported {ok:true,stopped:true}.
 *
 * Chrome is left alone on purpose: Stop stops running commands, it does not
 * close the browser window the desk is showing.
 */
export function deskKillScript(
  botId: unknown,
  { grokFallback = true }: { grokFallback?: boolean | undefined } = {},
): string {
  const mark = workMark(botId);
  const sweep = mark
    ? `for e in /proc/[0-9]*/environ; do
  d=\${e%/environ}; pid=\${d#/proc/}
  grep -qz "${WORK_ENV}=${mark}" "$e" 2>/dev/null || continue
  c=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null)
  case "$c" in *chrome*|*chromium*) continue;; esac
  kill -$1 "$pid" 2>/dev/null && echo "$pid"
done`
    : "true";
  const script = `set +e
sweep() {
${sweep}
}
n=$(sweep TERM | wc -l | tr -d ' ')
sleep 0.3
sweep KILL >/dev/null
if [ "$n" = "0" ] && [ "${grokFallback ? 1 : 0}" = "1" ]; then
  g=$(ps -eo pid,cmd | awk '/\\/usr\\/local\\/bin\\/grok / {print $1}')
  [ -n "$g" ] && echo "$g" | xargs -r kill -TERM
  sleep 0.2
  ps -eo pid,cmd | awk '/\\/usr\\/local\\/bin\\/grok / {print $1}' | xargs -r kill -KILL
  n=$(echo -n "$g" | grep -c . )
fi
echo "sub8-killed=$n"`;
  return script;
}

export async function killDeskWork(
  container: string | null | undefined,
  botId: unknown,
  { grokFallback = true }: { grokFallback?: boolean | undefined } = {},
): Promise<{ ok: boolean; killed: number }> {
  if (!container) return { ok: false, killed: 0 };
  const script = deskKillScript(botId, { grokFallback });
  // As `abc`, not root: the desk drops CAP_SYS_PTRACE, so only a process with the
  // same uid as the desk's work can read /proc/<pid>/environ to see the marker.
  const r = await docker(["exec", "-u", "abc", container, "bash", "-lc", script], { timeout: 12_000, jumpQueue: true });
  const killed = Number((String(r.out || "").match(/sub8-killed=(\d+)/) || [])[1] || 0);
  return { ok: r.ok, killed };
}

/** Back-compat name: a grok-only stop is now the fallback inside killDeskWork. */
export async function killDeskGrok(container: string | null | undefined): Promise<{ ok: boolean; killed: number }> {
  return killDeskWork(container, "");
}

/**
 * Stop everything this bot has running on its desk, whatever harness it is on.
 *
 * Mirrors the cloud shape (cloud/src/harness-client.mjs harnessStop ->
 * desk-harness POST /stop): ask the in-desk harness to abort its turn first, so
 * the /turn stream ends instead of running to completion, then sweep the
 * container for anything still carrying this bot's work marker.
 */
export async function stopDeskWork(
  bot: Bot | null | undefined,
  { token = "" }: { token?: string | undefined } = {},
): Promise<{ ok: boolean; stopped: number; killed: number }> {
  const container = bot?.vm?.container || "";
  if (!container) return { ok: false, stopped: 0, killed: 0 };
  let stopped = 0;
  try {
    const deskClient = await import("./desk-client.mjs");
    // A desk that never got a harness port records null, which desk-client's
    // `number | string` port does not spell but its Number() coercion accepts.
    const url = deskClient.harnessUrlFor(bot as HarnessBot);
    if (url) {
      const out = await deskClient.harnessStop({
        url,
        token: token || bot?.vm?.deskToken || process.env.SUB8_INTERNAL_TOKEN || "",
        // `container` was read off bot.vm, so bot is not null past that guard.
        botId: bot!.id,
      });
      stopped = Number(out?.stopped) || 0;
    }
  } catch {
    /* the harness may be old, gone, or unreachable — the sweep still runs */
  }
  const swept = await killDeskWork(container, bot!.id, { grokFallback: stopped === 0 }).catch(() => ({ ok: false, killed: 0 }));
  return { ok: swept.ok, stopped, killed: swept.killed };
}

export async function screenshotContainer(
  name: string | null | undefined,
  hostPath: string,
): Promise<{ ok: boolean; error?: string | undefined; path?: string | undefined }> {
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

export async function screenshot(bot: DeskBot): Promise<ShotResult> {
  if (isRemoteDesk(bot)) {
    requireVm(bot, "screenshot");
    return remoteShot(bot);
  }
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

export async function mouseMove(bot: DeskBot, x: unknown, y: unknown): Promise<void> {
  requireVm(bot, "mouse");
  const p = clampPoint(x, y);
  if (isRemoteDesk(bot)) {
    await remoteDesk(bot, { action: "mouse_move", x: p.x, y: p.y });
    return;
  }
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input move ${p.x} ${p.y}; else unset WINDOW; xdotool mousemove --screen 0 ${p.x} ${p.y}; fi`,
  ]);
  if (!r.ok) throw new Error(`mousemove failed: ${r.out.slice(-400)}`);
}

export async function mouseLocation(bot: DeskBot): Promise<{ x: number; y: number; raw: string }> {
  if (isRemoteDesk(bot)) {
    try {
      const data = await remoteDesk(bot, { action: "location" });
      const x = Number(data.x);
      const y = Number(data.y);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, raw: data.text || "" };
    } catch {
      /* older desk-agent has no location */
    }
    return { x: -1, y: -1, raw: "" };
  }
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
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

function pointerScript(x: number, y: number): string {
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

export async function click(bot: DeskBot, x: unknown, y: unknown, button: number = 1, count: number = 1): Promise<void> {
  requireVm(bot, "click");
  const p = clampPoint(x, y);
  if (isRemoteDesk(bot)) {
    const n = Math.max(1, Math.min(5, Math.round(count)));
    const action = button === 3 ? "right_click" : n > 1 ? "double_click" : "left_click";
    await remoteDesk(bot, { action, x: p.x, y: p.y });
    await wait(160);
    return;
  }
  await ensureBotDisplay(bot).catch(() => {});
  return withDeskLock(bot.vm.container, () => trace.span(bot, "outside", "click", { x: p.x, y: p.y, button, count }, async () => {
    await focusOwnedWindow(bot);
    const n = Math.max(1, Math.min(5, Math.round(count)));
    const r = await docker([
      "exec",
      "-u",
      "abc",
      bot.vm.container!,
      "bash",
      "-lc",
      `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input click ${p.x} ${p.y} ${button} ${n}; elif [ -x /usr/local/bin/octo-click ]; then /usr/local/bin/octo-click ${p.x} ${p.y} ${button} ${n}; else ${pointerScript(p.x, p.y)}; xdotool click --clearmodifiers --repeat ${n} --delay 40 ${button}; eval "$(xdotool getmouselocation --shell)"; echo POINTER=$X,$Y; fi`,
    ]);
    if (!r.ok) throw new Error(`click failed: ${r.out.slice(-400)}`);
    await wait(160);
  }), bot.vm?.display);
}

export async function drag(bot: DeskBot, x1: unknown, y1: unknown, x2: unknown, y2: unknown): Promise<void> {
  requireVm(bot, "drag");
  const a = clampPoint(x1, y1);
  const b = clampPoint(x2, y2);
  if (isRemoteDesk(bot)) {
    await remoteDesk(bot, { action: "left_click_drag", x: a.x, y: a.y, x2: b.x, y2: b.y });
    return;
  }
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input move ${a.x} ${a.y}; /usr/local/bin/box-input down 1; /usr/local/bin/box-input move ${b.x} ${b.y}; /usr/local/bin/box-input up 1; else ${pointerScript(a.x, a.y)}; xdotool mousedown 1; xdotool mousemove --screen 0 ${b.x} ${b.y}; xdotool mouseup 1; fi`,
  ]);
  if (!r.ok) throw new Error(`drag failed: ${r.out.slice(-400)}`);
}

export function looksLikeTypedText(keys: unknown): boolean {
  const seq = String(keys || "").trim();
  if (!seq) return false;
  if (/^(ctrl|control|alt|shift|super|cmd|meta|win)(\+|_|-)/i.test(seq)) return false;
  if (/^(return|enter|escape|esc|tab|space|backspace|delete|home|end|left|right|up|down|pageup|pagedown|f\d{1,2})$/i.test(seq)) {
    return false;
  }
  if (seq.length > 24) return true;
  if (/https?:|www\./i.test(seq)) return true;
  if (/[\/:?&=.#]/.test(seq)) return true;
  if (/\s/.test(seq)) return true;
  return false;
}

export async function typeText(bot: DeskBot, text: string): Promise<void> {
  if (!text) return;
  requireVm(bot, "type");
  if (isRemoteDesk(bot)) {
    await remoteDesk(bot, { action: "type", text: String(text) });
    return;
  }
  await focusOwnedWindow(bot);
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input type-b64 ${b64}; else echo '${b64}' | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v; fi`,
  ]);
  if (!r.ok) throw new Error(`type failed: ${r.out.slice(-400)}`);
}

export async function key(bot: DeskBot, keys: unknown): Promise<void> {
  const seq = String(keys || "").trim();
  if (!seq) return;
  // The one computer-use verb that never called this. Every neighbour does
  // (click, drag, type, mouse, screenshot), and test/vm-guards.mjs states the
  // invariant outright -- "every computer-use verb must refuse a bot that has no
  // computer, at the isolation guard, not later at `docker exec undefined`" --
  // but its verb list never included `key`. Without it a bot with no container
  // reached the daemon and failed there instead, which is exactly the bypass
  // isolation.mts exists to prevent. Guarded BEFORE the remote branch, as
  // typeText does, since requireVm accepts a remote desk too.
  requireVm(bot, "key");
  if (looksLikeTypedText(seq)) {
    await typeText(bot, seq);
    return;
  }
  if (isRemoteDesk(bot)) {
    await remoteDesk(bot, { action: "key", keys: seq });
    return;
  }
  await focusOwnedWindow(bot);
  const safe = seq.replace(/[^A-Za-z0-9+_]/g, "");
  if (!safe) return;
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input key ${safe}; else xdotool key --clearmodifiers ${safe}; fi`,
  ]);
  if (!r.ok) throw new Error(`key failed: ${r.out.slice(-400)}`);
}

export async function scroll(bot: DeskBot, x: unknown, y: unknown, dy: number, dx: number = 0): Promise<void> {
  if (isRemoteDesk(bot)) {
    const p = clampPoint(x, y);
    await remoteDesk(bot, { action: "scroll", x: p.x, y: p.y, dy: Number(dy) || 0, dx: Number(dx) || 0 });
    return;
  }
  await mouseMove(bot, x, y);
  const vbtn = dy < 0 ? 4 : dy > 0 ? 5 : 0;
  const hbtn = dx < 0 ? 6 : dx > 0 ? 7 : 0;
  const vn = Math.min(16, Math.max(vbtn ? 1 : 0, Math.abs(Math.round(dy / 40)) || 0));
  const hn = Math.min(16, Math.max(hbtn ? 1 : 0, Math.abs(Math.round(dx / 40)) || 0));
  const clicker = (btn: number, n: number) =>
    n && btn
      ? `for i in $(seq 1 ${n}); do if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input down ${btn}; /usr/local/bin/box-input up ${btn}; else xdotool click ${btn}; fi; done;`
      : "";
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; ${clicker(vbtn, vn)} ${clicker(hbtn, hn)} true`,
  ]);
  if (!r.ok) throw new Error(`scroll failed: ${r.out.slice(-400)}`);
}

export async function clipboardRead(bot: DeskBot): Promise<string> {
  requireVm(bot, "clipboard");
  if (isRemoteDesk(bot)) {
    const data = await remoteDesk(bot, { action: "clipboard_read" }).catch(() => ({ text: "" }));
    return data.text || "";
  }
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; xclip -selection clipboard -o 2>/dev/null || true`,
  ]);
  return r.out;
}

export async function clipboardWrite(bot: DeskBot, text: string): Promise<void> {
  requireVm(bot, "clipboard");
  if (isRemoteDesk(bot)) {
    await remoteDesk(bot, { action: "clipboard_write", text: String(text || "") });
    return;
  }
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; echo '${b64}' | base64 -d | xclip -selection clipboard`,
  ]);
  if (!r.ok) throw new Error(`clipboard write failed: ${r.out.slice(-400)}`);
}

/** Paste a secret into the focused field, then wipe the clipboard. Never logs the value. */
export async function pasteSecret(bot: DeskBot, text: string): Promise<void> {
  requireVm(bot, "paste");
  await clipboardWrite(bot, text);
  const r = await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; wid=$(xdotool getwindowfocus); xdotool windowactivate "$wid" 2>/dev/null || true; xdotool key --clearmodifiers ctrl+v`,
  ]);
  await clipboardWrite(bot, "").catch(() => {});
  if (!r.ok) throw new Error("Could not paste into the focused field.");
}

export async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, Math.max(0, Math.min(15000, ms))));
}

const deskChain = new Map<string, Promise<unknown>>();
export function withDeskLock<T>(
  container: string | null | undefined,
  fn: () => T | Promise<T>,
  display: string | undefined = "",
): Promise<T> {
  const key = `${container || "_"}:${display || ""}`;
  const prev = deskChain.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  deskChain.set(key, next.catch(() => {}));
  return next;
}

export async function ensureBotDisplay(bot: Bot): Promise<{ display: string; out?: string | undefined }> {
  if (isRemoteDesk(bot)) return { display: bot.vm?.display || ":1" };
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

export function applyTeamDisplays(
  team: { memberIds?: readonly string[] | undefined; chiefId?: string | undefined } | null | undefined,
  bots: readonly Bot[] | null | undefined,
  basePort?: number | null | undefined,
): Bot[] {
  const ids = team?.memberIds || [];
  const byId = new Map((bots || []).map((b) => [b.id, b] as const));
  const chief = team?.chiefId ? byId.get(team.chiefId) : null;
  const rest = ids.map((id) => byId.get(id)).filter((b) => b && b.id !== team?.chiefId);
  // filter(Boolean) provably drops the chief-missing and unknown-member holes.
  const ordered = [chief, ...rest].filter(Boolean) as Bot[];
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

export async function bindDisplayStreams(
  container: string,
  bots: readonly Bot[] | null | undefined,
): Promise<readonly Bot[] | null | undefined> {
  for (const b of bots || []) {
    const n = displayNum(b);
    const mapped = await detectMappedPort(container, 2999 + n);
    if (mapped) b.vm = { ...(b.vm || {}), novncPort: mapped };
    else if (n > 1) b.vm = { ...(b.vm || {}), novncPort: null };
  }
  return bots;
}

export async function scaleDeskMemory(container: string | null | undefined, memberCount?: unknown): Promise<void> {
  if (!container) return;
  const mem = deskMemory(memberCount);
  await docker(["update", "--memory", mem, "--memory-swap", mem, container], { timeout: 15_000 });
}

export async function pageAgent(
  bot: DeskBot,
  {
    action = "snapshot",
    ref,
    text,
    url,
    keys,
    ms,
  }: {
    action?: string | undefined;
    ref?: unknown;
    text?: string | undefined;
    url?: string | undefined;
    keys?: string | undefined;
    ms?: number | undefined;
  } = {},
): Promise<{ text: string; display?: string | undefined; port?: number | undefined }> {
  requireVm(bot, "browser");
  if (isRemoteDesk(bot)) {
    if (action === "wait") await wait(ms || 800);
    if (action === "navigate" || action === "open") {
      const opened = await openChrome(bot, url || text || "");
      return { text: opened.text || "opened" };
    }
    return { text: "Cloud desk: use computer screenshot (no DOM snapshot over VNC)." };
  }
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
      bot.vm.container!,
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
    if (action === "select") args.push(String(ref || ""), String(text || ""));
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
        bot.vm.container!,
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

export function windowTag(bot: Bot | null | undefined): string {
  return `Sub8:${String(bot?.id || "bot").slice(0, 8)}`;
}

export async function claimChromeWindow(bot: Bot): Promise<{ windowId: string; title: string } | null> {
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

export async function focusOwnedWindow(bot: Bot): Promise<{ windowId: string; title: string } | null> {
  if (isRemoteDesk(bot)) return null;
  if (!bot?.teamId || !bot?.vm?.container) return null;
  const claimed = await claimChromeWindow(bot).catch(() => null);
  const tag = windowTag(bot);
  await docker([
    "exec",
    "-u",
    "abc",
    bot.vm.container!,
    "bash",
    "-lc",
    `${displayEnv(bot)}; wmctrl -a ${JSON.stringify(tag)} 2>/dev/null || xdotool search --name ${JSON.stringify(tag)} windowactivate 2>/dev/null || true`,
  ]).catch(() => {});
  return claimed;
}

/** True if wmctrl/xdotool window text already shows this URL. */
export function urlLooksOpen(windowText: unknown, dest: unknown): boolean {
  const d = String(dest || "").trim();
  if (!d) return true;
  const host = d
    .replace(/^https?:\/\//i, "")
    // split() always yields at least one element.
    .split("/")[0]!
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

export async function openChrome(
  bot: DeskBot,
  url: string = "",
): Promise<{ text: string; out?: string | undefined }> {
  requireVm(bot, "open");
  if (isRemoteDesk(bot)) {
    const dest = String(url || "").trim();
    const data = await remoteDesk(bot, { action: "open", text: dest });
    return { text: data.text || (dest ? `opened ${dest}` : "opened Chrome"), out: data.log || "" };
  }
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
    bot.vm.container!,
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
      bot.vm.container!,
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
        bot.vm.container!,
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

export async function shell(bot: DeskBot, command: unknown): Promise<{ ok: boolean; output: string }> {
  requireVm(bot, "shell");
  assertVmShell(command);
  const cmd = String(command || "");
  if (isRemoteDesk(bot)) {
    if (/\b(google-chrome|chrome-desktop|chromium|xdg-open|firefox)\b/i.test(cmd)) {
      const url = (cmd.match(/https?:\/\/\S+/) || cmd.match(/file:\/\/\S+/) || [""])[0];
      const opened = await openChrome(bot, url.replace(/["']$/, ""));
      return { ok: true, output: opened.text };
    }
    try {
      const data = await remoteDesk(bot, { action: "shell", text: cmd });
      return { ok: true, output: String(data.text || "").slice(0, 8000) };
    } catch (err) {
      return { ok: false, output: (err as Error).message || "shell failed" };
    }
  }
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
      ...workEnvArgs(bot.id),
      bot.vm.container!,
      "bash",
      "-lc",
      `${displayEnv(bot)}; ${cmd}`,
    ]);
    return { ok: r.ok, output: r.out.slice(0, 8000) };
  });
}
