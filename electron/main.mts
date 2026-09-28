import { app, BrowserWindow, session, shell, nativeImage, ipcMain } from "electron";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/electron/main";
import { migrateUserData } from "@sub8/store";

const here = path.dirname(fileURLToPath(import.meta.url));
let PORT = process.env.PORT || "8787";
let URL = process.env.LOCALBOT_URL || `http://127.0.0.1:${PORT}`;
// Module scope, not inside the `before-quit` closure: `activate`/`second-instance`
// can arrive during the pause-all drain, and a window built then is destroyed
// moments later by the same quit that is already in flight.
let quitting = false;

function extraPath() {
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".docker", "bin"),
    path.join(os.homedir(), ".sub8", "bin"),
  ];
  return extras.filter((p) => fs.existsSync(p)).join(path.delimiter);
}

function dockerHost() {
  const env = String(process.env.DOCKER_HOST || "").trim();
  // Let Docker Desktop pick its own named pipe / WSL context.
  if (process.platform === "win32") return "";
  if (env && !/colima/i.test(env) && !/^unix:\/\/[A-Za-z]:/.test(env)) return env;
  const socks = [path.join(os.homedir(), ".colima", "default", "docker.sock"), "/var/run/docker.sock"];
  for (const sock of socks) {
    if (fs.existsSync(sock)) return `unix://${sock}`;
  }
  return "";
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

/**
 * True only for a Sub8 server that serves the data dir this build expects.
 * `{ ok: true }` alone is not enough: any dev server (a wrangler worker, say)
 * can answer that on 8787, and adopting it loads a foreign site into the
 * window. Sub8's /api/health also reports `docker` and `dataDir`.
 */
function isOurHealth(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { ok?: unknown; dataDir?: unknown; docker?: unknown };
  if (b.ok !== true) return false;
  const theirs = typeof b.dataDir === "string" ? b.dataDir : "";
  if (!theirs) return !app.isPackaged && "docker" in b;
  if (!app.isPackaged) return true;
  return path.resolve(theirs) === path.resolve(path.join(app.getPath("userData"), "data"));
}

async function probeHealth(url: string, timeoutMs: number): Promise<"ours" | "foreign" | "down"> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.json().catch(() => null);
    return r.ok && isOurHealth(body) ? "ours" : "foreign";
  } catch {
    return "down";
  }
}

const PORTS = [8787, 8791, 8792, 8793, 8794];

async function resolvePort(): Promise<{ port: number; already: boolean }> {
  // A healthy answer is not proof it is OUR server. An orphaned dev server
  // (the repo's data/, left holding the port after a Force Quit) or an
  // unrelated project would otherwise be adopted. /api/health names the dir
  // it serves, so compare before attaching.
  for (const p of PORTS) {
    if ((await probeHealth(`http://127.0.0.1:${p}`, 500)) === "ours") return { port: p, already: true };
  }
  for (const p of PORTS) {
    if (await portFree(p)) return { port: p, already: false };
  }
  return { port: 8787, already: false };
}

// Distinct userData per build. Both builds called themselves "Sub8", so both
// resolved app.getPath("userData") to ~/Library/Application Support/Sub8 and
// shared one single-instance lock: launching the installed app while a dev
// build ran just focused the dev window. Dev keeps only Chromium cache and
// that lock there (its data dir is the repo), so a separate path costs nothing.
app.setName(app.isPackaged ? "Sub8" : "Sub8 Dev");
app.setAboutPanelOptions({
  applicationName: "Sub8",
  applicationVersion: app.getVersion(),
  copyright: "Copyright © 2026 Daniel Farina",
});
app.commandLine.appendSwitch("disable-http-cache");
Sentry.init({
  dsn: "https://f953dc5ff8f15b4b67ba3fd967ae779e@o4512007301169152.ingest.us.sentry.io/4512007318339584",
  release: `sub8@${app.getVersion()}`,
  environment: app.isPackaged ? "production" : "development",
  tracesSampleRate: app.isPackaged ? 0.2 : 1.0,
  integrations: [Sentry.startupTracingIntegration()],
});

function migrateLegacyUserData() {
  const dest = path.join(app.getPath("userData"), "data");
  migrateUserData(dest, { extraSources: [path.join(unpackRoot(), "data")] });
}

function packagedRoot() {
  return app.getAppPath();
}

function unpackRoot() {
  if (!app.isPackaged) return path.resolve(here, "..");
  return process.resourcesPath;
}

function startServer(): ChildProcess | null {
  if (!app.isPackaged) return null;
  if (process.env.LOCALBOT_URL) return null;
  const root = packagedRoot();
  migrateLegacyUserData();
  const data = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(data, { recursive: true });
  const files = root.endsWith(".asar") ? root.replace(/\.asar$/, ".asar.unpacked") : root;
  const serverPath = path.join(root, "server", "index.mjs");
  const logPath = path.join(app.getPath("userData"), "server.log");
  try {
    // Appended forever otherwise; keep one previous generation for support.
    if (fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* no log yet */
  }
  const log = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [serverPath], {
    cwd: app.getPath("userData"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      PATH: [extraPath(), process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"].filter(Boolean).join(path.delimiter),
      DOCKER_HOST: dockerHost() || process.env.DOCKER_HOST || "",
      SUB8BOT_ROOT: root,
      SUB8BOT_FILES: files,
      SUB8BOT_DATA: data,
      SUB8_PACKAGED: app.isPackaged ? "1" : "",
      SUB8_CLOUD: process.env.SUB8_CLOUD || (app.isPackaged ? "0" : ""),
      SUB8_CLOUD_URL: process.env.SUB8_CLOUD_URL || "https://sub8.bot",
      SUB8_ACCOUNT: process.env.SUB8_ACCOUNT || "",
      SUB8_REQUIRE_ACCOUNT: process.env.SUB8_REQUIRE_ACCOUNT || "",
      SUB8_MOCK_AUTH: process.env.SUB8_MOCK_AUTH || "",
      OCTOBOT_ROOT: root,
      OCTOBOT_FILES: files,
      OCTOBOT_DATA: data,
      HOME: os.homedir(),
    },
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  child.on("error", (err) => {
    console.error("Sub8 server failed to spawn", err);
    Sentry.captureException(err);
  });
  child.on("exit", (code, signal) => {
    if (serverProc === child) serverProc = null;
    if (quitting) return;
    // Any exit while the app is open is unexpected: a crash, an OOM kill
    // (signal, no code), or a clean exit after an error. The window would
    // otherwise sit on a dead page forever.
    console.error("Sub8 server exited", code, signal);
    Sentry.captureException(new Error(`Sub8 server exited ${code ?? signal}`));
    scheduleServerRestart();
  });
  return child;
}

let serverProc: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let restartTimes: number[] = [];

function mainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

function scheduleServerRestart() {
  if (quitting || restartTimer || !app.isPackaged || process.env.LOCALBOT_URL) return;
  const now = Date.now();
  restartTimes = restartTimes.filter((t) => now - t < 5 * 60_000);
  restartTimes.push(now);
  // 1s, 2s, 4s ... capped at 30s while it keeps dying.
  const delay = Math.min(30_000, 1000 * 2 ** (restartTimes.length - 1));
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (quitting) return;
    // The port may have been taken while we were down (another project's dev
    // server, say). Re-resolve rather than fail to bind the old one.
    const resolved = await resolvePort();
    const next = `http://127.0.0.1:${resolved.port}`;
    const moved = next !== URL;
    PORT = String(resolved.port);
    URL = next;
    if (!resolved.already) serverProc = startServer();
    const up = await waitForServer(40);
    const win = mainWindow();
    if (!win) return;
    if (up) {
      // Reload either way: the old page's sockets point at a dead server.
      win.loadURL(URL);
    } else {
      showStartupError(win, moved);
    }
  }, delay);
}

async function waitForServer(tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await probeHealth(URL, 800)) === "ours") return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function iconPath(): string | undefined {
  const candidates = [
    path.join(unpackRoot(), "build", "icon.png"),
    path.join(packagedRoot(), "build", "icon.png"),
    path.join(here, "..", "build", "icon.png"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

let recovering = false;

/** Error page for when the server is not answering; keeps polling and reloads once it is. */
function showStartupError(win: BrowserWindow, moved: boolean, reason = "") {
  if (win.isDestroyed()) return;
  const esc = (v: string) => v.replace(/[<>&"]/g, "");
  const log = path.join(app.getPath("userData"), "server.log");
  const why = reason || `The local server is not answering on ${URL}${moved ? " (it moved to a new port)" : ""}.`;
  const html = `<!doctype html><meta charset="utf-8"><title>Sub8</title>
<body style="font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:56px 32px;color:#1d1d1f;background:#fff">
<div style="max-width:34em;margin:0 auto">
<h2 style="margin:0 0 8px;font-size:20px">Sub8 is reconnecting…</h2>
<p style="margin:0">${esc(why)}</p>
<p style="margin:12px 0 0;color:#6e6e73">Sub8 retries on its own and reloads when the server is back. If this stays, quit and reopen Sub8. The last error is in <code>${esc(log)}</code>.</p>
</div></body>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  if (recovering) return;
  recovering = true;
  (async () => {
    while (!quitting && !win.isDestroyed()) {
      if (!serverProc && !restartTimer && app.isPackaged && !process.env.LOCALBOT_URL) scheduleServerRestart();
      if (await waitForServer(5)) {
        if (!win.isDestroyed()) win.loadURL(URL);
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    recovering = false;
  })();
}

function create() {
  const icon = iconPath();
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    show: true,
    title: "Sub8",
    backgroundColor: "#ffffff",
    // hiddenInset is macOS-only. On Windows it removes the title bar, so a
    // restored window has no chrome and can sit unseen at the top of the screen.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } }
      : { frame: true, autoHideMenuBar: true }),
    // exactOptionalPropertyTypes: the option is `string | NativeImage`, so an
    // absent icon has to be an absent key rather than an explicit undefined.
    ...(icon ? { icon } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(here, "preload.cjs"),
    },
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // Electron's union has no "microphone"/"audioCapture" member; Chromium has
    // sent both. Compare as a string so the runtime test stays what it was.
    const asked: string = permission;
    callback(asked === "media" || asked === "microphone" || asked === "audioCapture");
  });
  // Packaged Mac uses the icns (system rounding). setDockIcon(square PNG) makes a square tile.
  if (!app.isPackaged && process.platform === "darwin") {
    const rounded = path.join(here, "..", "docs", "brand", "octobot-icon-rounded.png");
    if (fs.existsSync(rounded)) app.dock?.setIcon(nativeImage.createFromPath(rounded));
  }
  if (process.platform === "win32") {
    win.unmaximize();
    win.center();
    win.setAlwaysOnTop(true);
  }
  win.show();
  win.focus();
  if (process.platform === "win32") {
    setTimeout(() => {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 2000);
  }
  waitForServer().then((up) => {
    // Don't wait on clearCache — it can hang under sandbox and leave a white window.
    win.webContents.session.clearCache().catch(() => {});
    if (win.isDestroyed()) return;
    if (up) {
      win.loadURL(URL);
      return;
    }
    showStartupError(win, false);
    Sentry.captureException(new Error(`Sub8 server did not start at ${URL}`));
  });
  let fails = 0;
  win.webContents.on("did-finish-load", () => {
    if (win.webContents.getURL().startsWith(URL)) fails = 0;
  });
  win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    // A failed subframe (the desk's VNC iframe) must not reload the whole app.
    if (!isMainFrame || code === -3) return;
    if (fails >= 3) {
      showStartupError(win, false);
      return;
    }
    fails += 1;
    setTimeout(() => {
      if (!win.isDestroyed()) win.loadURL(URL);
    }, 600 * fails);
  });
  // A dead renderer leaves the window white with nothing to click. Reload it,
  // unless it keeps dying, then say so instead of looping.
  let crashes: number[] = [];
  win.webContents.on("render-process-gone", (_e, details) => {
    if (quitting || win.isDestroyed()) return;
    Sentry.captureException(new Error(`Sub8 renderer gone: ${details.reason} (${details.exitCode})`));
    if (details.reason === "clean-exit") return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60_000);
    crashes.push(now);
    if (crashes.length > 3) {
      showStartupError(win, false, `The window crashed ${crashes.length} times in a minute (${details.reason}).`);
      return;
    }
    setTimeout(() => {
      if (!win.isDestroyed()) win.loadURL(URL);
    }, 500);
  });
  let hung: NodeJS.Timeout | null = null;
  win.on("unresponsive", () => {
    if (hung) return;
    hung = setTimeout(() => {
      hung = null;
      if (win.isDestroyed()) return;
      Sentry.captureException(new Error("Sub8 renderer unresponsive for 20s"));
      win.webContents.forcefullyCrashRenderer();
    }, 20_000);
  });
  win.on("responsive", () => {
    if (hung) clearTimeout(hung);
    hung = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only http(s) leaves the app. A data:/blob: URL handed to macOS gets
    // "There is no application set to open the URL data:image/png;base64,…".
    if (!/^https?:/i.test(url)) return { action: "deny" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  // Electron injects the preload — and the auto-granting permission handler
  // above — into every page this webContents loads, whatever the origin. A
  // same-frame navigation (an anchor with no target, a dropped file) would
  // hand that bridge to a foreign page, and there is no nav chrome to get
  // back. Keep the window on our own origin; send anything else to the browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (url === URL || url.startsWith(`${URL}/`)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

function focusMainWindow() {
  if (quitting) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    if (app.isReady()) create();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
  if (process.platform === "darwin") {
    app.dock?.show();
    app.show();
    app.focus({ steal: true });
  }
}

/** `String(err?.message || err)`, but reached through `unknown` instead of past it. */
function errorText(err: unknown): string {
  const message = typeof err === "object" && err !== null && "message" in err ? err.message : undefined;
  return String(message || err);
}

async function setupAutoUpdate() {
  ipcMain.handle("app-version", () => app.getVersion());
  if (!app.isPackaged) {
    ipcMain.handle("update-check", async () => ({
      ok: true,
      packaged: false,
      updateAvailable: false,
      currentVersion: app.getVersion(),
    }));
    return;
  }
  let autoUpdater: (typeof import("electron-updater"))["autoUpdater"];
  try {
    ({ autoUpdater } = await import("electron-updater"));
  } catch {
    ipcMain.handle("update-check", async () => ({
      ok: false,
      error: "Updater unavailable",
      currentVersion: app.getVersion(),
    }));
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  ipcMain.handle("update-check", async () => {
    try {
      const result = await Promise.race([
        autoUpdater.checkForUpdates(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Update check timed out")), 12_000)),
      ]);
      const info = result?.updateInfo;
      const latest = String(info?.version || "").replace(/^v/i, "");
      const current = app.getVersion();
      return {
        ok: true,
        packaged: true,
        updateAvailable: Boolean(latest && latest !== current),
        latestVersion: latest || null,
        currentVersion: current,
      };
    } catch (err) {
      return { ok: false, error: errorText(err), currentVersion: app.getVersion() };
    }
  });
  ipcMain.handle("update-download", async () => {
    try {
      await Promise.race([
        autoUpdater.downloadUpdate(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Download timed out")), 20_000)),
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  });
  ipcMain.handle("update-install", () => {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());
  app.whenReady().then(async () => {
    const resolved = await resolvePort();
    PORT = String(resolved.port);
    URL = process.env.LOCALBOT_URL || `http://127.0.0.1:${PORT}`;
    if (!resolved.already) serverProc = startServer();
    setupAutoUpdate().catch(() => {});
    create();
  });
  app.on("activate", () => focusMainWindow());
  app.on("window-all-closed", () => {
    app.quit();
  });
  app.on("before-quit", (e) => {
    if (quitting) {
      if (serverProc && !serverProc.killed) serverProc.kill();
      return;
    }
    e.preventDefault();
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) win.webContents.send("computers-pausing");
    const finish = () => {
      quitting = true;
      if (serverProc && !serverProc.killed) serverProc.kill();
      app.quit();
    };
    if (restartTimer) clearTimeout(restartTimer);
    // Only POST to a server we know is ours: after a crash the port can belong
    // to another project by now.
    probeHealth(URL, 1500)
      .then((who) =>
        who === "ours"
          ? fetch(`${URL}/api/computers/pause-all`, { method: "POST", signal: AbortSignal.timeout(12_000) })
          : null,
      )
      .catch(() => {})
      .finally(finish);
  });
}
