const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sub8Desktop", {
  version: () => ipcRenderer.invoke("app-version"),
  checkUpdate: () => ipcRenderer.invoke("update-check"),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
});
