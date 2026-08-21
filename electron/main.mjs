import { app, BrowserWindow, session, shell, nativeImage, ipcMain } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let PORT = process.env.PORT || "8787";
let URL = process.env.LOCALBOT_URL || `http://127.0.0.1:${PORT}`;

function extraPath() {
  const extras = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".docker", "bin")];
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

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function resolvePort() {
  try {
    const r = await fetch("http://127.0.0.1:8787/api/health", { signal: AbortSignal.timeout(500) });
    if (r.ok) return { port: 8787, already: true };
  } catch {
    /* free or not ours */
  }
  for (const p of [8787, 8791, 8792, 8793]) {
    if (await portFree(p)) return { port: p, already: false };
  }
  return { port: 8787, already: false };
}

app.setName("Sub8");
app.setAboutPanelOptions({
  applicationName: "Sub8",
  applicationVersion: app.getVersion(),
  copyright: "Copyright © 2026 Daniel Farina",
});
if (!app.isPackaged) app.commandLine.appendSwitch("disable-http-cache");

function migrateLegacyUserData() {
  const dest = path.join(app.getPath("userData"), "data");
  if (fs.existsSync(path.join(dest, "bots.json"))) return;
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library", "Application Support", "Sub8Bot", "data"),
    path.join(home, "Library", "Application Support", "OctoBot", "data"),
    path.join(home, "Library", "Application Support", "octobot", "data"),
  ];
  for (const src of candidates) {
    if (!fs.existsSync(path.join(src, "bots.json"))) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
}

function packagedRoot() {
  return app.getAppPath();
}

function unpackRoot() {
  if (!app.isPackaged) return path.resolve(here, "..");
  return process.resourcesPath;
}

function startServer() {
  if (!app.isPackaged) return null;
  if (process.env.LOCALBOT_URL) return null;
  const root = packagedRoot();
  migrateLegacyUserData();
  const data = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(data, { recursive: true });
  const files = root.endsWith(".asar") ? root.replace(/\.asar$/, ".asar.unpacked") : root;
  const serverPath = path.join(root, "server", "index.mjs");
  const log = fs.openSync(path.join(app.getPath("userData"), "server.log"), "a");
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
      SUB8_CLOUD: process.env.SUB8_CLOUD || "",
      SUB8_CLOUD_URL: process.env.SUB8_CLOUD_URL || "",
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
  child.on("exit", (code) => {
    if (code && code !== 0) console.error("Sub8 server exited", code);
  });
  return child;
}

let serverProc = null;

async function waitForServer(tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function iconPath() {
  const candidates = [
    path.join(unpackRoot(), "build", "icon.png"),
    path.join(packagedRoot(), "build", "icon.png"),
    path.join(here, "..", "build", "icon.png"),
  ];
  return candidates.find((p) => fs.existsSync(p));
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
    icon: icon || undefined,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: path.join(here, "preload.cjs"),
    },
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "microphone" || permission === "audioCapture");
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
  waitForServer().finally(() => {
    const load = () => {
      if (!win.isDestroyed()) win.loadURL(URL);
    };
    // Don't wait on clearCache — it can hang under sandbox and leave a white window.
    if (!app.isPackaged) win.webContents.session.clearCache().catch(() => {});
    load();
  });
  let fails = 0;
  win.webContents.on("did-fail-load", (_e, code) => {
    if (code === -3 || fails >= 3) return;
    fails += 1;
    setTimeout(() => {
      if (!win.isDestroyed()) win.loadURL(URL);
    }, 600);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function focusMainWindow() {
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
  let autoUpdater;
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
        new Promise((_, reject) => setTimeout(() => reject(new Error("Update check timed out")), 12_000)),
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
      return { ok: false, error: String(err?.message || err), currentVersion: app.getVersion() };
    }
  });
  ipcMain.handle("update-download", async () => {
    try {
      await Promise.race([
        autoUpdater.downloadUpdate(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Download timed out")), 20_000)),
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
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
  let quitting = false;
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
    fetch(`${URL}/api/computers/pause-all`, { method: "POST", signal: AbortSignal.timeout(12_000) })
      .catch(() => {})
      .finally(finish);
  });
}
