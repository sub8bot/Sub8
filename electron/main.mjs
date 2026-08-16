import { app, BrowserWindow, shell, nativeImage } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || "8787";
const URL = process.env.LOCALBOT_URL || `http://127.0.0.1:${PORT}`;

app.setName("OctoBot");
app.setAboutPanelOptions({
  applicationName: "OctoBot",
  applicationVersion: app.getVersion(),
  copyright: "Copyright © 2026 Daniel Farina",
});
if (!app.isPackaged) app.commandLine.appendSwitch("disable-http-cache");

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
  const data = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(data, { recursive: true });
  const serverPath = path.join(root, "server", "index.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: app.isPackaged ? app.getPath("userData") : path.resolve(here, ".."),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT,
      OCTOBOT_ROOT: root,
      OCTOBOT_FILES: root.endsWith(".asar") ? root.replace(/\.asar$/, ".asar.unpacked") : root,
      OCTOBOT_DATA: data,
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error("OctoBot server exited", code);
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
    show: false,
    title: "OctoBot",
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    icon: icon || undefined,
    webPreferences: { sandbox: true },
  });
  if (icon && process.platform === "darwin") {
    app.dock?.setIcon(nativeImage.createFromPath(icon));
  }
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 3000);
  waitForServer().finally(() => {
    const load = () => {
      if (!win.isDestroyed()) win.loadURL(URL);
    };
    if (app.isPackaged) load();
    else win.webContents.session.clearCache().finally(load);
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());
  app.whenReady().then(() => {
    serverProc = startServer();
    create();
  });
  app.on("activate", () => focusMainWindow());
  app.on("window-all-closed", () => {
    if (serverProc && !serverProc.killed) serverProc.kill();
    app.quit();
  });
  app.on("before-quit", () => {
    if (serverProc && !serverProc.killed) serverProc.kill();
  });
}
