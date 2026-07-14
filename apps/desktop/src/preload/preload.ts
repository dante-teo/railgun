import { contextBridge, ipcRenderer } from "electron";
import {
  AppCommandSchema,
  AgentControlUpdateSchema,
  BackendSnapshotSchema,
  ChatControlsSnapshotSchema,
  ChatModelIdSchema,
  ClarificationAnswerSchema,
  ControlMutationResultSchema,
  DesktopAgentEventSchema,
  DesktopInteractionRequestSchema,
  EmptyResponseSchema,
  ExternalUrlSchema,
  InteractionCorrelationIdSchema,
  MockScenarioIdSchema,
  MockScenarioListSchema,
  ModelPersistenceModeSchema,
  PromptTextSchema,
  PersistenceMessageIdSchema,
  SessionIdSchema,
  SessionSnapshotSchema,
  SessionSummaryListSchema,
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
  MemoryListSchema, MemoryMutationSchema, MemorySchema, MemoryIdSchema, KnowledgeQuerySchema,
  NoteImportResultSchema, NoteResultListSchema, NoteSearchModeSchema, DreamSummarySchema, DreamProgressSchema,
  InstructionFileListSchema, InstructionFileSchema, InstructionFileIdSchema, InstructionContentSchema,
} from "../shared/schemas";
import { DESKTOP_IPC } from "../shared/types";
import type { AppCommand, RailgunDesktopApi } from "../shared/types";

interface IpcTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export const createDesktopApi = (transport: IpcTransport): RailgunDesktopApi => {
  const appCommandListeners = new Set<(command: AppCommand) => void>();
  const pendingAppCommands: AppCommand[] = [];
  let appCommandSubscribed = true;
  const appCommandHandler = (_event: unknown, payload: unknown): void => {
    const result = AppCommandSchema.safeParse(payload);
    if (!result.success) return;
    if (appCommandListeners.size === 0) {
      pendingAppCommands.push(result.data);
      return;
    }
    for (const listener of appCommandListeners) listener(result.data);
  };
  transport.on(DESKTOP_IPC.appCommand, appCommandHandler);

  return {
    getBackendSnapshot: async () => BackendSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.getBackendSnapshot),
    ),
    restartBackend: async () => BackendSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.restartBackend),
    ),
    onBackendSnapshot: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const result = BackendSnapshotSchema.safeParse(payload);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_IPC.backendSnapshot, handler);
      return () => transport.removeListener(DESKTOP_IPC.backendSnapshot, handler);
    },
    listMockScenarios: async () => MockScenarioListSchema.parse(
      await transport.invoke(DESKTOP_IPC.listMockScenarios),
    ),
    selectMockScenario: async (id) => {
      const validId = MockScenarioIdSchema.parse(id);
      return BackendSnapshotSchema.parse(
        await transport.invoke(DESKTOP_IPC.selectMockScenario, validId),
      );
    },
    sendPrompt: async (message) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.sendPrompt, PromptTextSchema.parse(message)),
      );
    },
    steerPrompt: async (message) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.steerPrompt, PromptTextSchema.parse(message)),
      );
    },
    followUpPrompt: async (message) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.followUpPrompt, PromptTextSchema.parse(message)),
      );
    },
    abortPrompt: async () => {
      EmptyResponseSchema.parse(await transport.invoke(DESKTOP_IPC.abortPrompt));
    },
    openExternal: async (url) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.openExternal, ExternalUrlSchema.parse(url)),
      );
    },
    listFiles: async (pathSegments) => DirectoryListingSchema.parse(
      await transport.invoke(DESKTOP_IPC.listFiles, FilePathSegmentsSchema.parse(pathSegments)),
    ),
    previewFile: async (pathSegments) => FilePreviewSchema.parse(
      await transport.invoke(DESKTOP_IPC.previewFile, FilePathSegmentsSchema.parse(pathSegments)),
    ),
    revealFile: async (pathSegments) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.revealFile, FilePathSegmentsSchema.parse(pathSegments)),
      );
    },
    startNewChat: async () => SessionSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.startNewChat),
    ),
    listSessions: async () => SessionSummaryListSchema.parse(
      await transport.invoke(DESKTOP_IPC.listSessions),
    ),
    resumeSession: async (sessionId) => SessionSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.resumeSession, SessionIdSchema.parse(sessionId)),
    ),
    branchSession: async (messageId, summarize) => {
      const validMessageId = PersistenceMessageIdSchema.parse(messageId);
      if (typeof summarize !== "boolean") throw new Error("Summarize must be a boolean");
      return SessionSnapshotSchema.parse(
        await transport.invoke(DESKTOP_IPC.branchSession, validMessageId, summarize),
      );
    },
    forkSession: async (sessionId) => SessionSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.forkSession, SessionIdSchema.parse(sessionId)),
    ),
    onSessionSnapshot: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const result = SessionSnapshotSchema.safeParse(payload);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_IPC.sessionSnapshot, handler);
      return () => transport.removeListener(DESKTOP_IPC.sessionSnapshot, handler);
    },
    getChatControls: async () => ChatControlsSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.getChatControls),
    ),
    setChatModel: async (modelId, persistence) => ControlMutationResultSchema.parse(
      await transport.invoke(
        DESKTOP_IPC.setChatModel,
        ChatModelIdSchema.parse(modelId),
        ModelPersistenceModeSchema.parse(persistence),
      ),
    ),
    updateAgentControls: async (update) => ControlMutationResultSchema.parse(
      await transport.invoke(DESKTOP_IPC.updateAgentControls, AgentControlUpdateSchema.parse(update)),
    ),
    compactContext: async () => ControlMutationResultSchema.parse(
      await transport.invoke(DESKTOP_IPC.compactContext),
    ),
    getSettings: async () => SettingsSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.getSettings),
    ),
    updateSettings: async (update) => SettingsSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.updateSettings, SettingsUpdateSchema.parse(update)),
    ),
    listCronJobs: async () => CronJobListSchema.parse(
      await transport.invoke(DESKTOP_IPC.listCronJobs),
    ),
    createCronJob: async (input) => CronJobSchema.parse(
      await transport.invoke(DESKTOP_IPC.createCronJob, CronJobInputSchema.parse(input)),
    ),
    updateCronJob: async (id, input) => CronJobSchema.parse(
      await transport.invoke(
        DESKTOP_IPC.updateCronJob,
        CronJobIdSchema.parse(id),
        CronJobInputSchema.parse(input),
      ),
    ),
    deleteCronJob: async (id) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.deleteCronJob, CronJobIdSchema.parse(id)),
      );
    },
    signInDevin: async () => SettingsSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.signInDevin),
    ),
    signOutDevin: async () => SettingsSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.signOutDevin),
    ),
    listSkills: async () => SkillSummaryListSchema.parse(
      await transport.invoke(DESKTOP_IPC.listSkills),
    ),
    getSkill: async (name) => SkillDetailSchema.parse(
      await transport.invoke(DESKTOP_IPC.getSkill, SkillNameSchema.parse(name)),
    ),
    listMcpServers: async () => McpServerListSchema.parse(
      await transport.invoke(DESKTOP_IPC.listMcpServers),
    ),
    upsertMcpServer: async (server) => McpServerListSchema.parse(
      await transport.invoke(DESKTOP_IPC.upsertMcpServer, McpServerUpsertSchema.parse(server)),
    ),
    removeMcpServer: async (name) => McpServerListSchema.parse(
      await transport.invoke(DESKTOP_IPC.removeMcpServer, McpServerNameSchema.parse(name)),
    ),
    onAgentEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const result = DesktopAgentEventSchema.safeParse(payload);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_IPC.agentEvent, handler);
      return () => transport.removeListener(DESKTOP_IPC.agentEvent, handler);
    },
    respondToApproval: async (id, approved) => {
      const validId = InteractionCorrelationIdSchema.parse(id);
      if (typeof approved !== "boolean") throw new Error("Approval response must be a boolean");
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.respondToApproval, validId, approved),
      );
    },
    respondToClarification: async (id, answer) => {
      const validId = InteractionCorrelationIdSchema.parse(id);
      const validAnswer = ClarificationAnswerSchema.parse(answer);
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.respondToClarification, validId, validAnswer),
      );
    },
    onInteractionRequest: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const result = DesktopInteractionRequestSchema.safeParse(payload);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_IPC.interactionRequest, handler);
      return () => transport.removeListener(DESKTOP_IPC.interactionRequest, handler);
    },
    onAppCommand: (listener) => {
      if (!appCommandSubscribed) {
        transport.on(DESKTOP_IPC.appCommand, appCommandHandler);
        appCommandSubscribed = true;
      }
      appCommandListeners.add(listener);
      for (const command of pendingAppCommands.splice(0)) listener(command);
      return () => {
        appCommandListeners.delete(listener);
        if (appCommandListeners.size === 0 && appCommandSubscribed) {
          transport.removeListener(DESKTOP_IPC.appCommand, appCommandHandler);
          appCommandSubscribed = false;
        }
      };
    },
    listMemories: async (query) => MemoryListSchema.parse(await transport.invoke(
      DESKTOP_IPC.listMemories,
      query === undefined ? undefined : KnowledgeQuerySchema.parse(query),
    )),
    createMemory: async (value) => MemorySchema.parse(await transport.invoke(
      DESKTOP_IPC.createMemory, MemoryMutationSchema.parse(value),
    )),
    updateMemory: async (id, value) => MemorySchema.parse(await transport.invoke(
      DESKTOP_IPC.updateMemory, MemoryIdSchema.parse(id), MemoryMutationSchema.parse(value),
    )),
    deleteMemory: async (id) => EmptyResponseSchema.parse(await transport.invoke(
      DESKTOP_IPC.deleteMemory, MemoryIdSchema.parse(id),
    )),
    importNotes: async () => NoteImportResultSchema.parse(await transport.invoke(DESKTOP_IPC.importNotes)),
    searchNotes: async (query, mode) => NoteResultListSchema.parse(await transport.invoke(
      DESKTOP_IPC.searchNotes, KnowledgeQuerySchema.parse(query), NoteSearchModeSchema.parse(mode),
    )),
    runDream: async () => DreamSummarySchema.parse(await transport.invoke(DESKTOP_IPC.runDream)),
    onDreamProgress: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const result = DreamProgressSchema.safeParse(payload);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_IPC.dreamProgress, handler);
      return () => transport.removeListener(DESKTOP_IPC.dreamProgress, handler);
    },
    listInstructionFiles: async () => InstructionFileListSchema.parse(await transport.invoke(DESKTOP_IPC.listInstructionFiles)),
    getInstructionFile: async (id) => InstructionFileSchema.parse(await transport.invoke(
      DESKTOP_IPC.getInstructionFile, InstructionFileIdSchema.parse(id),
    )),
    updateInstructionFile: async (id, content) => InstructionFileSchema.parse(await transport.invoke(
      DESKTOP_IPC.updateInstructionFile, InstructionFileIdSchema.parse(id), InstructionContentSchema.parse(content),
    )),
  };
};

const api = Object.freeze(createDesktopApi(ipcRenderer));
contextBridge.exposeInMainWorld("railgunDesktop", api);
