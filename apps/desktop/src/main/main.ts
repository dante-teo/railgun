import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from "electron";
import { resolve } from "node:path";
import { BackendSupervisor, createBackendChildFactory } from "./backendSupervisor";
import { createInteractionBroker } from "./interactionBroker";
import { toDesktopAgentEvent } from "./agentBoundary";
import type { BackendRuntime } from "./backendSupervisor";
import { createRendererProtocolHandler, RAILGUN_RENDERER_URL } from "./rendererProtocol";
import { buildApplicationMenuTemplate, installContextMenu } from "./nativeMenus";
import { dispatchAppCommand } from "./appCommandDispatcher";
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
  AppCommandSchema,
  AgentControlUpdateSchema,
  BackendSnapshotSchema,
  ChatModelIdSchema,
  ClarificationAnswerSchema,
  InteractionCorrelationIdSchema,
  MockScenarioIdSchema,
  MockScenarioListSchema,
  ModelPersistenceModeSchema,
  PromptTextSchema,
  SessionIdSchema,
  SessionSnapshotSchema,
  SessionSummaryListSchema,
} from "../shared/schemas";
import { DESKTOP_IPC } from "../shared/types";
import type { AppCommand, BackendMode, BackendSnapshot, DesktopAgentEvent, SessionSnapshot } from "../shared/types";
import { openExternalFromRenderer } from "./externalLinks";
import { createChatControlsService } from "./chatControls";
import { createSessionService } from "./sessionService";

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
const chatControls = createChatControlsService(supervisor);
const sessionService = createSessionService((command, validate) => supervisor.call(command, validate));

const senderContext = {
  windows: railgunWindows,
  expectedOrigin: expectedRendererOrigin,
  fromWebContents: BrowserWindow.fromWebContents,
};

interface RendererPushPayloads {
  [DESKTOP_IPC.backendSnapshot]: BackendSnapshot;
  [DESKTOP_IPC.agentEvent]: DesktopAgentEvent;
  [DESKTOP_IPC.interactionRequest]: import("../shared/types").DesktopInteractionRequest;
  [DESKTOP_IPC.sessionSnapshot]: SessionSnapshot;
}

const sendToRailgunWindows = <Channel extends keyof RendererPushPayloads>(
  channel: Channel,
  payload: RendererPushPayloads[Channel],
): void => {
  for (const window of railgunWindows) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
};

const interactionBroker = createInteractionBroker({
  call: (command, validate) => supervisor.call(command, validate),
  emit: request => sendToRailgunWindows(DESKTOP_IPC.interactionRequest, request),
});

const broadcastSnapshot = (snapshot: BackendSnapshot): void => {
  if (snapshot.phase !== "ready") interactionBroker.settle();
  sendToRailgunWindows(DESKTOP_IPC.backendSnapshot, BackendSnapshotSchema.parse(snapshot));
};

const broadcastSessionSnapshot = (snapshot: SessionSnapshot): void => {
  sendToRailgunWindows(DESKTOP_IPC.sessionSnapshot, SessionSnapshotSchema.parse(snapshot));
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
    broadcastSessionSnapshot(await sessionService.snapshot());
  });
  ipcMain.handle(DESKTOP_IPC.steerPrompt, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    await supervisor.call({ type: "steer", message: PromptTextSchema.parse(value) });
  });
  ipcMain.handle(DESKTOP_IPC.followUpPrompt, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    await supervisor.call({ type: "follow_up", message: PromptTextSchema.parse(value) });
  });
  ipcMain.handle(DESKTOP_IPC.abortPrompt, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    await supervisor.call({ type: "abort" });
  });
  ipcMain.handle(DESKTOP_IPC.respondToApproval, async (event, id: unknown, approved: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    const validId = InteractionCorrelationIdSchema.parse(id);
    if (typeof approved !== "boolean") throw new Error("Approval response must be a boolean");
    await interactionBroker.respondToApproval(validId, approved);
  });
  ipcMain.handle(DESKTOP_IPC.respondToClarification, async (event, id: unknown, answer: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    const validId = InteractionCorrelationIdSchema.parse(id);
    await interactionBroker.respondToClarification(validId, ClarificationAnswerSchema.parse(answer));
  });
  ipcMain.handle(DESKTOP_IPC.openExternal, async (event, value: unknown) => {
    await openExternalFromRenderer(event, value, senderContext, url => shell.openExternal(url));
  });
  ipcMain.handle(DESKTOP_IPC.startNewChat, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    const result = await sessionService.create();
    broadcastSessionSnapshot(result);
    return SessionSnapshotSchema.parse(result);
  });
  ipcMain.handle(DESKTOP_IPC.listSessions, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return SessionSummaryListSchema.parse(await sessionService.list());
  });
  ipcMain.handle(DESKTOP_IPC.resumeSession, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    const result = await sessionService.resume(SessionIdSchema.parse(value));
    broadcastSessionSnapshot(result);
    return SessionSnapshotSchema.parse(result);
  });
  ipcMain.handle(DESKTOP_IPC.getChatControls, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return chatControls.get();
  });
  ipcMain.handle(DESKTOP_IPC.setChatModel, async (event, modelId: unknown, persistence: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    const result = await chatControls.setModel(ChatModelIdSchema.parse(modelId), ModelPersistenceModeSchema.parse(persistence));
    broadcastSessionSnapshot(await sessionService.snapshot());
    return result;
  });
  ipcMain.handle(DESKTOP_IPC.updateAgentControls, async (event, update: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return chatControls.update(AgentControlUpdateSchema.parse(update));
  });
  ipcMain.handle(DESKTOP_IPC.compactContext, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return chatControls.compact();
  });
};

const createWindow = (initialCommand?: AppCommand): BrowserWindow => {
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
      // Keep the Y position in sync with --traffic-light-top in renderer/styles.css.
      trafficLightPosition: { x: 24, y: 20 },
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
  installContextMenu(window);
  if (initialCommand !== undefined) {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.appCommand, initialCommand);
    });
  }
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
  interactionBroker.receiveBackendEvent(value);
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(
    !app.isPackaged,
    (command) => {
      dispatchAppCommand(AppCommandSchema.parse(command), {
        getFocusedWindow: BrowserWindow.getFocusedWindow,
        windows: railgunWindows,
        createWindow,
      });
    },
  )));
  createWindow();
  app.on("activate", () => {
    if (railgunWindows.size === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  interactionBroker.settle();
  supervisor.shutdown();
});
