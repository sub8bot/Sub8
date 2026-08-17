const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sub8Desktop", {
  checkUpdate: () => ipcRenderer.invoke("update-check"),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
});
