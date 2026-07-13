import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { resolve } from "node:path";
import { BackendSupervisor, createBackendChildFactory } from "./backendSupervisor";
import { toDesktopAgentEvent } from "./agentBoundary";
import type { BackendRuntime } from "./backendSupervisor";
import { createRendererProtocolHandler, RAILGUN_RENDERER_URL } from "./rendererProtocol";
import {
  assertAuthorizedIpcSender,
  installSessionGuards,
  installWebContentsGuards,
  isAllowedWebContentsCreation,
  rendererCsp,
  rendererOrigin,
} from "./security";
import { getMockScenario, listMockScenarios } from "../mock/scenarios";
import {
  BackendSnapshotSchema,
  MockScenarioIdSchema,
  MockScenarioListSchema,
  PromptTextSchema,
} from "../shared/schemas";
import { DESKTOP_IPC } from "../shared/types";
import type { BackendMode, BackendSnapshot, DesktopAgentEvent } from "../shared/types";

protocol.registerSchemesAsPrivileged([{
  scheme: "railgun",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}]);

const developmentUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const expectedRendererOrigin = rendererOrigin(developmentUrl);
const railgunWindows = new Set<BrowserWindow>();
let expectingRailgunWindow = false;

app.on("web-contents-created", (_event, contents) => {
  installWebContentsGuards(contents);
  if (!isAllowedWebContentsCreation(contents.getType(), expectingRailgunWindow, !app.isPackaged)) {
    queueMicrotask(() => {
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    });
  }
});

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

const senderContext = {
  windows: railgunWindows,
  expectedOrigin: expectedRendererOrigin,
  fromWebContents: BrowserWindow.fromWebContents,
};

interface RendererPushPayloads {
  [DESKTOP_IPC.backendSnapshot]: BackendSnapshot;
  [DESKTOP_IPC.agentEvent]: DesktopAgentEvent;
}

const sendToRailgunWindows = <Channel extends keyof RendererPushPayloads>(
  channel: Channel,
  payload: RendererPushPayloads[Channel],
): void => {
  for (const window of railgunWindows) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
};

const broadcastSnapshot = (snapshot: BackendSnapshot): void => {
  sendToRailgunWindows(DESKTOP_IPC.backendSnapshot, BackendSnapshotSchema.parse(snapshot));
};

const registerIpc = (): void => {
  ipcMain.handle(DESKTOP_IPC.getBackendSnapshot, (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return BackendSnapshotSchema.parse(supervisor.getSnapshot());
  });
  ipcMain.handle(DESKTOP_IPC.restartBackend, (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return BackendSnapshotSchema.parse(supervisor.restartBackend());
  });
  ipcMain.handle(DESKTOP_IPC.listMockScenarios, (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return MockScenarioListSchema.parse(backendMode === "mock" ? listMockScenarios() : []);
  });
  ipcMain.handle(DESKTOP_IPC.selectMockScenario, (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    if (backendMode !== "mock") throw new Error("Mock scenarios are unavailable in real backend mode");
    const id = MockScenarioIdSchema.parse(value);
    getMockScenario(id);
    return BackendSnapshotSchema.parse(supervisor.restartWithScenario(id));
  });
  ipcMain.handle(DESKTOP_IPC.sendPrompt, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    await supervisor.call({ type: "prompt", message: PromptTextSchema.parse(value) });
  });
  ipcMain.handle(DESKTOP_IPC.abortPrompt, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    await supervisor.call({ type: "abort" });
  });
  ipcMain.handle(DESKTOP_IPC.startNewChat, (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return BackendSnapshotSchema.parse(supervisor.start());
  });
};

const createWindow = (): BrowserWindow => {
  expectingRailgunWindow = true;
  let window: BrowserWindow;
  try {
    window = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 760,
      minHeight: 520,
      title: "Railgun",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      backgroundColor: "#101613",
      webPreferences: {
        preload: resolve(__dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
      },
    });
  } finally {
    expectingRailgunWindow = false;
  }

  railgunWindows.add(window);
  window.once("closed", () => railgunWindows.delete(window));
  if (developmentUrl !== undefined) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadURL(RAILGUN_RENDERER_URL);
  }
  return window;
};

registerIpc();
supervisor.subscribe(broadcastSnapshot);
supervisor.subscribeBackendEvents((value) => {
  const event = toDesktopAgentEvent(value);
  if (event === undefined) return;
  sendToRailgunWindows(DESKTOP_IPC.agentEvent, event);
});

void app.whenReady().then(() => {
  installSessionGuards(session.defaultSession, rendererCsp(developmentUrl));
  if (developmentUrl === undefined) {
    const rendererRoot = resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
    void protocol.handle("railgun", createRendererProtocolHandler(rendererRoot));
  }
  supervisor.start();
  createWindow();
  app.on("activate", () => {
    if (railgunWindows.size === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => supervisor.shutdown());
