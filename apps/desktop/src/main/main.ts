import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, shell } from "electron";
import { resolve } from "node:path";
import { userInfo } from "node:os";
import { BackendSupervisor, createBackendChildFactory } from "./backendSupervisor";
import { createInteractionBroker } from "./interactionBroker";
import { toDesktopAgentEvent } from "./agentBoundary";
import type { BackendRuntime } from "./backendSupervisor";
import { createRendererProtocolHandler, RAILGUN_RENDERER_URL } from "./rendererProtocol";
import { buildApplicationMenuTemplate, buildSessionContextMenu, installContextMenu } from "./nativeMenus";
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
  SessionContextMenuResultSchema,
  PersistenceMessageIdSchema,
  SessionSummaryListSchema,
  ArchivedSessionSummaryListSchema,
  DirectoryListingSchema,
  FilePathSegmentsSchema,
  FilePreviewSchema,
  SettingsSnapshotSchema,
  SettingsUpdateSchema,
  CronJobIdSchema,
  CronJobInputSchema,
  CronJobListSchema,
  CronJobSchema,
  SkillNameSchema,
  SkillSummaryListSchema,
  SkillDetailSchema,
  McpServerNameSchema,
  McpServerListSchema,
  McpServerUpsertSchema,
  MemoryIdSchema, MemoryMutationSchema, MemoryListSchema, MemorySchema, KnowledgeQuerySchema,
  NoteImportResultSchema, NoteResultListSchema, NoteSearchModeSchema, DreamSummarySchema, DreamProgressSchema,
  InstructionFileIdSchema, InstructionFileListSchema, InstructionFileSchema, InstructionContentSchema,
  BackgroundAutomationStatusSchema,
} from "../shared/schemas";
import { DESKTOP_IPC } from "../shared/types";
import type { AppCommand, BackendMode, BackendSnapshot, DesktopAgentEvent, SessionSnapshot } from "../shared/types";
import { openExternalFromRenderer } from "./externalLinks";
import { createChatControlsService } from "./chatControls";
import { createSessionService } from "./sessionService";
import { createFileService } from "./fileService";
import { createMutationQueue } from "./mutationQueue";
import { createSettingsService } from "./settingsService";
import { createAuthenticationCoordinator, createAuthenticationService } from "./authenticationService";
import { createCronService } from "./cronService";
import { createManagementService } from "./managementService";
import { createKnowledgeService } from "./knowledgeService";
import { createDesktopDiagnosticSink } from "./desktopDiagnostics";
import { createBackgroundAutomationService, createUnavailableAutomationService } from "./backgroundAutomation";
import { createUpdateService } from "./updateService";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";

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
  diagnosticSink: createDesktopDiagnosticSink({ home: app.getPath("home") }),
});
const mutationQueue = createMutationQueue();
const chatControls = createChatControlsService(supervisor, mutationQueue);
const settingsService = createSettingsService(supervisor, chatControls, mutationQueue);
const managementService = createManagementService(supervisor, mutationQueue);
const waitForBackendReady = (action: "login" | "logout"): Promise<void> => new Promise((resolveReady, rejectReady) => {
  let unsubscribe = (): void => undefined;
  const timeout = setTimeout(() => {
    unsubscribe();
    rejectReady(new Error("Backend did not become ready after authentication"));
  }, 20_000);
  unsubscribe = supervisor.subscribe((next) => {
    if (next.phase === "starting") return;
    clearTimeout(timeout);
    unsubscribe();
    if (next.phase === "ready" || (action === "logout" && next.phase === "authentication-required")) resolveReady();
    else rejectReady(new Error(next.error ?? "Backend could not restart after authentication"));
  });
  supervisor.restartBackend();
});
const authentication = createAuthenticationService(backendRuntime, waitForBackendReady);
const unavailableAutomation = createUnavailableAutomationService("Background automation is available from an installed Railgun app.");
const backgroundAutomation = app.isPackaged && process.platform === "darwin"
  ? createBackgroundAutomationService({
    uid: userInfo().uid,
    home: app.getPath("home"),
    executablePath: process.execPath,
    backendEntry: resolve(process.resourcesPath, "backend/railgun/dist/backend.js"),
  })
  : unavailableAutomation;
const updates = createUpdateService(__RAILGUN_UPDATE_CHANNEL__, autoUpdater);
autoUpdater.on("update-available", () => updates.onUpdateAvailable());
const authenticationCoordinator = createAuthenticationCoordinator({
  mutations: mutationQueue,
  isAgentRunning: async () => (await settingsService.get()).running,
  signIn: authentication.signIn,
  signOut: authentication.signOut,
  snapshot: settingsService.get,
});
const sessionService = createSessionService((command, validate) => supervisor.call(command, validate));
const cronService = createCronService((command, validate) => supervisor.call(command, validate), mutationQueue);
const fileService = createFileService(app.getPath("home"), {
  decodeImage: (buffer) => {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error("Image decode failed");
    const { width, height } = image.getSize();
    return { width, height, toDataUrl: () => image.toDataURL() };
  },
  reveal: path => shell.showItemInFolder(path),
});
const knowledgeService = createKnowledgeService(
  (command, validate) => supervisor.call(command, validate),
  async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  },
);

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
  [DESKTOP_IPC.dreamProgress]: import("../shared/types").DreamProgress;
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
    authenticationCoordinator.assertTaskMutationAllowed();
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
    authenticationCoordinator.assertTaskMutationAllowed();
    await supervisor.call({ type: "prompt", message: PromptTextSchema.parse(value) });
    broadcastSessionSnapshot(await sessionService.snapshot());
  });
  ipcMain.handle(DESKTOP_IPC.steerPrompt, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    await supervisor.call({ type: "steer", message: PromptTextSchema.parse(value) });
  });
  ipcMain.handle(DESKTOP_IPC.followUpPrompt, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
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
  ipcMain.handle(DESKTOP_IPC.listFiles, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return DirectoryListingSchema.parse(await fileService.list(FilePathSegmentsSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.previewFile, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return FilePreviewSchema.parse(await fileService.preview(FilePathSegmentsSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.revealFile, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    await fileService.reveal(FilePathSegmentsSchema.parse(value));
  });
  ipcMain.handle(DESKTOP_IPC.startNewChat, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    const result = await sessionService.create();
    broadcastSessionSnapshot(result);
    return SessionSnapshotSchema.parse(result);
  });
  ipcMain.handle(DESKTOP_IPC.listSessions, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return SessionSummaryListSchema.parse(await sessionService.list());
  });
  ipcMain.handle(DESKTOP_IPC.listArchivedSessions, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return ArchivedSessionSummaryListSchema.parse(await sessionService.listArchived());
  });
  ipcMain.handle(DESKTOP_IPC.archiveSession, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    const result = await sessionService.archive(SessionIdSchema.parse(value));
    broadcastSessionSnapshot(result);
    return SessionSnapshotSchema.parse(result);
  });
  ipcMain.handle(DESKTOP_IPC.unarchiveSession, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    await sessionService.unarchive(SessionIdSchema.parse(value));
  });
  ipcMain.handle(DESKTOP_IPC.resumeSession, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    const result = await sessionService.resume(SessionIdSchema.parse(value));
    broadcastSessionSnapshot(result);
    return SessionSnapshotSchema.parse(result);
  });
  ipcMain.handle(DESKTOP_IPC.branchSession, async (event, messageId: unknown, summarize: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    if (typeof summarize !== "boolean") throw new Error("Summarize must be a boolean");
    const result = await sessionService.branch(PersistenceMessageIdSchema.parse(messageId), summarize);
    broadcastSessionSnapshot(result);
    return SessionSnapshotSchema.parse(result);
  });
  ipcMain.handle(DESKTOP_IPC.forkSession, async (event, sessionId: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    const result = await sessionService.fork(SessionIdSchema.parse(sessionId));
    broadcastSessionSnapshot(result);
    return SessionSnapshotSchema.parse(result);
  });
  ipcMain.handle(DESKTOP_IPC.showSessionContextMenu, async (event, sessionId: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    const validId = SessionIdSchema.parse(sessionId);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("No window for sender");
    return SessionContextMenuResultSchema.parse(await buildSessionContextMenu(validId, window));
  });
  ipcMain.handle(DESKTOP_IPC.getChatControls, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return chatControls.get();
  });
  ipcMain.handle(DESKTOP_IPC.setChatModel, async (event, modelId: unknown, persistence: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    const result = await chatControls.setModel(ChatModelIdSchema.parse(modelId), ModelPersistenceModeSchema.parse(persistence));
    broadcastSessionSnapshot(await sessionService.snapshot());
    return result;
  });
  ipcMain.handle(DESKTOP_IPC.updateAgentControls, async (event, update: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    return chatControls.update(AgentControlUpdateSchema.parse(update));
  });
  ipcMain.handle(DESKTOP_IPC.compactContext, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    authenticationCoordinator.assertTaskMutationAllowed();
    return chatControls.compact();
  });
  ipcMain.handle(DESKTOP_IPC.getSettings, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return SettingsSnapshotSchema.parse(await settingsService.get());
  });
  ipcMain.handle(DESKTOP_IPC.listCronJobs, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return CronJobListSchema.parse(await cronService.list());
  });
  ipcMain.handle(DESKTOP_IPC.createCronJob, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return CronJobSchema.parse(await cronService.create(CronJobInputSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.updateCronJob, async (event, id: unknown, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return CronJobSchema.parse(await cronService.update(CronJobIdSchema.parse(id), CronJobInputSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.deleteCronJob, async (event, id: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    await cronService.delete(CronJobIdSchema.parse(id));
  });
  ipcMain.handle(DESKTOP_IPC.getAutomationStatus, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return BackgroundAutomationStatusSchema.parse(await backgroundAutomation.getAutomationStatus());
  });
  ipcMain.handle(DESKTOP_IPC.enableAutomation, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return BackgroundAutomationStatusSchema.parse(await mutationQueue.run(() => backgroundAutomation.enableAutomation()));
  });
  ipcMain.handle(DESKTOP_IPC.disableAutomation, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return BackgroundAutomationStatusSchema.parse(await mutationQueue.run(() => backgroundAutomation.disableAutomation()));
  });
  ipcMain.handle(DESKTOP_IPC.repairAutomation, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return BackgroundAutomationStatusSchema.parse(await mutationQueue.run(() => backgroundAutomation.repairAutomation()));
  });
  ipcMain.handle(DESKTOP_IPC.updateSettings, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return SettingsSnapshotSchema.parse(await settingsService.update(SettingsUpdateSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.signInDevin, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    if (backendMode === "mock") throw new Error("Devin sign-in is unavailable in mock mode");
    return SettingsSnapshotSchema.parse(await authenticationCoordinator.mutate("login"));
  });
  ipcMain.handle(DESKTOP_IPC.signOutDevin, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    if (backendMode === "mock") throw new Error("Devin sign-out is unavailable in mock mode");
    return SettingsSnapshotSchema.parse(await authenticationCoordinator.mutate("logout"));
  });
  ipcMain.handle(DESKTOP_IPC.listSkills, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return SkillSummaryListSchema.parse(await managementService.listSkills());
  });
  ipcMain.handle(DESKTOP_IPC.getSkill, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return SkillDetailSchema.parse(await managementService.getSkill(SkillNameSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.listMcpServers, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return McpServerListSchema.parse(await managementService.listMcpServers());
  });
  ipcMain.handle(DESKTOP_IPC.upsertMcpServer, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return McpServerListSchema.parse(await managementService.upsertMcpServer(McpServerUpsertSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.removeMcpServer, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return McpServerListSchema.parse(await managementService.removeMcpServer(McpServerNameSchema.parse(value)));
  });
  ipcMain.handle(DESKTOP_IPC.listMemories, async (event, query: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    const validQuery = query === undefined ? undefined : KnowledgeQuerySchema.parse(query);
    return MemoryListSchema.parse(await knowledgeService.listMemories(validQuery));
  });
  ipcMain.handle(DESKTOP_IPC.createMemory, async (event, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return MemorySchema.parse(await mutationQueue.run(() => knowledgeService.createMemory(MemoryMutationSchema.parse(value))));
  });
  ipcMain.handle(DESKTOP_IPC.updateMemory, async (event, id: unknown, value: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return MemorySchema.parse(await mutationQueue.run(() => knowledgeService.updateMemory(MemoryIdSchema.parse(id), MemoryMutationSchema.parse(value))));
  });
  ipcMain.handle(DESKTOP_IPC.deleteMemory, async (event, id: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    await mutationQueue.run(() => knowledgeService.deleteMemory(MemoryIdSchema.parse(id)));
  });
  ipcMain.handle(DESKTOP_IPC.importNotes, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return NoteImportResultSchema.parse(await mutationQueue.run(() => knowledgeService.importNotes()));
  });
  ipcMain.handle(DESKTOP_IPC.searchNotes, async (event, query: unknown, mode: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return NoteResultListSchema.parse(await knowledgeService.searchNotes(KnowledgeQuerySchema.parse(query), NoteSearchModeSchema.parse(mode)));
  });
  ipcMain.handle(DESKTOP_IPC.runDream, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return DreamSummarySchema.parse(await mutationQueue.run(() => knowledgeService.runDream()));
  });
  ipcMain.handle(DESKTOP_IPC.listInstructionFiles, async (event) => {
    assertAuthorizedIpcSender(event, senderContext);
    return InstructionFileListSchema.parse(await knowledgeService.listInstructionFiles());
  });
  ipcMain.handle(DESKTOP_IPC.getInstructionFile, async (event, id: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return InstructionFileSchema.parse(await knowledgeService.getInstructionFile(InstructionFileIdSchema.parse(id)));
  });
  ipcMain.handle(DESKTOP_IPC.updateInstructionFile, async (event, id: unknown, content: unknown) => {
    assertAuthorizedIpcSender(event, senderContext);
    return InstructionFileSchema.parse(await mutationQueue.run(() => knowledgeService.updateInstructionFile(
      InstructionFileIdSchema.parse(id), InstructionContentSchema.parse(content),
    )));
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
  const progress = DreamProgressSchema.safeParse(value);
  if (progress.success) sendToRailgunWindows(DESKTOP_IPC.dreamProgress, progress.data);
  interactionBroker.receiveBackendEvent(value);
  const event = toDesktopAgentEvent(value);
  if (event === undefined) return;
  sendToRailgunWindows(DESKTOP_IPC.agentEvent, event);
});

void app.whenReady().then(() => {
  if (updates.enabled && app.isPackaged) {
    updateElectronApp({
      updateSource: { type: UpdateSourceType.ElectronPublicUpdateService, repo: "dante-teo/railgun" },
    });
  }
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
  authentication.shutdown();
  supervisor.shutdown();
});
