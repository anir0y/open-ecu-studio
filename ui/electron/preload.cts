import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openEcuDesktop", {
  platform: process.platform,
  version: process.argv.find(arg => arg.startsWith("--ecu-version="))?.slice("--ecu-version=".length),
  ...(process.argv.includes("--ecu-private-backend") ? {receiverRun: {
    read: () => ipcRenderer.sendSync("receiver-run", "read"),
    write: (value: string | null) => ipcRenderer.sendSync("receiver-run", "write", value),
  }} : {}),
});
