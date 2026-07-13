import { app, BrowserWindow, ipcMain } from "electron";
import { resolve } from "node:path";
import { BackendSupervisor, createBackendChildFactory } from "./backendSupervisor";
import type { BackendRuntime } from "./backendSupervisor";
import { getMockScenario, listMockScenarios } from "../mock/scenarios";
import { DESKTOP_IPC } from "../shared/types";
import type { BackendMode, BackendSnapshot } from "../shared/types";

const backendMode: BackendMode = process.env.RAILGUN_DESKTOP_BACKEND_MODE === "mock" ? "mock" : "real";
const backendRuntime: BackendRuntime = app.isPackaged
  ? {
    kind: "packaged",
    resourcesPath: process.resourcesPath,
    executablePath: process.execPath,
    workingDirectory: app.getPath("home"),
  }
  : {
    kind: "development",
    repositoryRoot: resolve(app.getAppPath(), "../.."),
  };
const supervisor = new BackendSupervisor({
  mode: backendMode,
  spawnChild: createBackendChildFactory(backendRuntime),
  ...(backendMode === "mock" ? { initialScenarioId: "ready-idle" } : {}),
});

const broadcastSnapshot = (snapshot: BackendSnapshot): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(DESKTOP_IPC.backendSnapshot, snapshot);
  }
};

const registerIpc = (): void => {
  ipcMain.handle(DESKTOP_IPC.getBackendSnapshot, () => supervisor.getSnapshot());
  ipcMain.handle(DESKTOP_IPC.listMockScenarios, () => backendMode === "mock" ? listMockScenarios() : []);
  ipcMain.handle(DESKTOP_IPC.selectMockScenario, (_event, id: unknown) => {
    if (backendMode !== "mock") throw new Error("Mock scenarios are unavailable in real backend mode");
    if (typeof id !== "string") throw new TypeError("Mock scenario id must be a string");
    getMockScenario(id);
    return supervisor.restartWithScenario(id);
  });
};

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 680,
    minHeight: 480,
    title: "Railgun",
    webPreferences: {
      preload: resolve(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  return window;
};

registerIpc();
supervisor.subscribe(broadcastSnapshot);

void app.whenReady().then(() => {
  supervisor.start();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => supervisor.shutdown());
