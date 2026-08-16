import { app, BrowserWindow, shell } from "electron";

const URL = process.env.LOCALBOT_URL || "http://127.0.0.1:8787";

app.setName("Local Bot");
// Always pull fresh HTML/JS from the local server (overlay/settings fixes).
app.commandLine.appendSwitch("disable-http-cache");

async function waitForServer(tries = 8) {
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

function create() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "Local Bot",
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { sandbox: true },
  });
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 3000);
  waitForServer().finally(() => {
    win.webContents.session.clearCache().finally(() => {
      if (!win.isDestroyed()) win.loadURL(URL);
    });
  });
  let fails = 0;
  win.webContents.on("did-fail-load", (_e, code) => {
    if (code === -3 || fails >= 3) return; // aborted
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
  app.whenReady().then(create);
  app.on("activate", () => focusMainWindow());
  app.on("window-all-closed", () => app.quit());
}
