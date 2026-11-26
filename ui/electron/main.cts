import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import { app, BrowserWindow, Menu, screen, shell } from "electron";

let backendProcess: ChildProcess | null = null;
let backendStartup: Promise<string> | undefined;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("Unable to allocate a local backend port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForBackend(url: string, expectedChannel?: string): Promise<void> {
  let lastError = "backend did not respond";
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (expectedChannel && !backendProcess) throw new Error("Desktop backend stopped during startup");
    try {
      const response = await fetch(`${url}/api/status`, {signal: AbortSignal.timeout(1000), redirect: "error"});
      if (response.ok && (!expectedChannel || (await response.json()).channel === expectedChannel)) return;
      lastError = response.ok ? "unexpected backend channel" : `backend returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Open ECU backend failed to start: ${lastError}`);
}

async function startBackend(): Promise<string> {
  const suppliedUrl = process.env.ECU_CAN_BACKEND_URL;
  if (suppliedUrl) {
    const url = new URL(suppliedUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("The desktop backend must use a local HTTP origin");
    }
    await waitForBackend(url.origin);
    return url.origin;
  }

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const channel = `open-ecu-desktop-${randomUUID()}`;
  const commonArgs = [
    "--interface", "virtual",
    "--channel", channel,
    "--host", "127.0.0.1",
    "--port", String(port),
  ];

  if (app.isPackaged) {
    const backend = path.join(
      process.resourcesPath,
      "backend",
      "open-ecu-backend",
    );
    if (!existsSync(backend)) throw new Error(`Bundled backend is missing: ${backend}`);
    backendProcess = spawn(backend, commonArgs, { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    const projectRoot = path.resolve(app.getAppPath(), "..");
    const venvBackend = path.join(projectRoot, "work", "venv", "bin", "ecu-can-ui");
    if (existsSync(venvBackend)) {
      backendProcess = spawn(venvBackend, commonArgs, { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] });
    } else {
      backendProcess = spawn(
        "python3",
        ["-m", "ecu_lab.server", ...commonArgs],
        { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
      );
    }
  }

  backendProcess.stderr?.on("data", (data) => console.error(`[backend] ${String(data).trim()}`));
  backendProcess.once("error", (error) => {
    console.error("Open ECU backend failed to launch", error);
    backendProcess = null;
    backendStartup = undefined;
  });
  backendProcess.once("exit", (code) => {
    if (code && code !== 0) console.error(`Open ECU backend exited with code ${code}`);
    backendProcess = null;
    backendStartup = undefined;
  });
  await waitForBackend(url, channel);
  return url;
}

function enableRunStorage(window: BrowserWindow, origin: string): void {
  const savedFile = path.join(app.getPath("userData"), "receiver-run.json");
  const contents = window.webContents;
  contents.ipc.on("receiver-run", (event, operation: unknown, value: unknown) => {
    let result: string | boolean | null = false;
    try {
      if (event.senderFrame !== contents.mainFrame || new URL(contents.mainFrame.url).origin !== origin) return;
      if (operation === "read") {
        result = existsSync(savedFile) ? readFileSync(savedFile, "utf8") : null;
      } else if (operation === "write" && value === null) {
        rmSync(savedFile, {force: true});
        result = true;
      } else if (operation === "write" && typeof value === "string" && Buffer.byteLength(value) <= 5 * 1024 * 1024) {
        const temporary = savedFile + "." + process.pid + ".tmp";
        writeFileSync(temporary, value, {mode: 0o600});
        renameSync(temporary, savedFile);
        result = true;
      }
    } catch (error) {
      console.error("Desktop run storage error", error);
    } finally {
      event.returnValue = result;
    }
  });
}

function enableControlsWindow(studio: BrowserWindow, origin: string): void {
  let controls: BrowserWindow | undefined;
  let previous: Electron.Rectangle | undefined;
  let arranged: Electron.Rectangle | undefined;

  studio.webContents.setWindowOpenHandler(({url, frameName}) => {
    if (url !== "about:blank" || frameName !== "open-ecu-studio-controls" ||
        new URL(studio.webContents.getURL()).origin !== origin) {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return {action: "deny"};
    }
    if (controls && !controls.isDestroyed()) {
      controls.focus();
      return {action: "deny"};
    }

    const bounds = studio.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const gap = 8;
    const [minimum] = studio.getMinimumSize();
    const width = Math.min(area.width, 430, Math.max(320, area.width - minimum - gap));
    const height = Math.min(area.height, 740);
    const rightEdge = area.x + area.width;
    let x = bounds.x + bounds.width + gap;
    if (x + width > rightEdge) {
      if (bounds.x - gap - width >= area.x) {
        x = bounds.x - gap - width;
      } else {
        x = rightEdge - width;
        const mainWidth = Math.min(bounds.width, x - gap - area.x);
        if (mainWidth >= minimum && !studio.isFullScreen() && !studio.isMaximized()) {
          previous = bounds;
          studio.setBounds({...bounds, x: x - gap - mainWidth, width: mainWidth});
          arranged = studio.getBounds();
        }
      }
    }
    return {
      action: "allow",
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        x: Math.max(area.x, x), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
        width, height, minWidth: Math.min(320, width), minHeight: Math.min(400, height),
        title: "Open ECU Studio Controls", titleBarStyle: "default", titleBarOverlay: false,
        backgroundColor: "#0d1419", show: true, fullscreenable: false, autoHideMenuBar: true,
        webPreferences: {sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true},
      },
    };
  });
  studio.webContents.on("did-create-window", child => {
    controls = child;
    child.webContents.setWindowOpenHandler(() => ({action: "deny"}));
    child.webContents.on("will-navigate", event => event.preventDefault());
    child.webContents.on("will-redirect", event => event.preventDefault());
    child.once("closed", () => {
      controls = undefined;
      if (previous && arranged && !studio.isDestroyed()) {
        const current = studio.getBounds();
        if (current.x === arranged.x && current.y === arranged.y &&
            current.width === arranged.width && current.height === arranged.height) studio.setBounds(previous);
      }
      previous = undefined;
      arranged = undefined;
    });
  });
}

async function createWindow(): Promise<void> {
  backendStartup ??= startBackend();
  const backendUrl = await backendStartup;
  const privateBackend = !process.env.ECU_CAN_BACKEND_URL;
  const primary = screen.getPrimaryDisplay();
  const second = screen.getAllDisplays().find(display => display.id !== primary.id);
  const area = (second ?? primary).workArea;
  const width = Math.min(1500, area.width);
  const height = Math.min(980, area.height);
  const window = new BrowserWindow({
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
    minWidth: Math.min(1024, width),
    minHeight: Math.min(720, height),
    show: false,
    backgroundColor: "#080b0e",
    title: "Open ECU Studio",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: process.platform === "darwin" ? true : {
      color: "#080b0e",
      symbolColor: "#e7f1f5",
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [`--ecu-version=${app.getVersion()}`, ...(privateBackend ? ["--ecu-private-backend"] : [])],
    },
  });

  enableControlsWindow(window, backendUrl);
  if (privateBackend) enableRunStorage(window, backendUrl);
  const restrictNavigation = (event: Electron.Event, destination: string) => {
    if (new URL(destination).origin !== backendUrl) event.preventDefault();
  };
  window.webContents.on("will-navigate", restrictNavigation);
  window.webContents.on("will-redirect", restrictNavigation);
  window.once("ready-to-show", () => window.show());
  await window.loadURL(`${backendUrl}/?desktop=1`);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  backendProcess?.kill("SIGTERM");
  backendProcess = null;
});
