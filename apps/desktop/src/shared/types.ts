import type { z } from "zod";
import type {
  AppCommandSchema,
  BackendSnapshotSchema,
  DesktopInteractionRequestSchema,
  DesktopAgentEventSchema,
  MockScenarioIdSchema,
  MockScenarioSchema,
  TransportLogEntrySchema,
  ChatControlsSnapshotSchema,
  ModelPersistenceModeSchema,
  AgentControlUpdateSchema,
  ControlMutationResultSchema,
  DesktopModelMetadataSchema,
  MoAPresetSummarySchema,
  AdvisorControlSchema,
  SessionSummarySchema,
  SessionSnapshotSchema,
  CheckpointStatusSchema,
  RestoredTranscriptEntrySchema,
  RestoredTranscriptMessageSchema,
  RestoredTodoSchema,
  DirectoryEntrySchema,
  DirectoryListingSchema,
  FilePreviewSchema,
  SettingsSectionSchema,
  SettingsSnapshotSchema,
  SettingsUpdateSchema,
  CronJobSchema,
  CronJobInputSchema,
  SkillSummarySchema,
  SkillDetailSchema,
  McpServerSchema,
  McpServerUpsertSchema,
  MemorySchema, MemoryMutationSchema, NoteResultSchema, NoteImportResultSchema, NoteSearchModeSchema,
  DreamSummarySchema, DreamProgressSchema, InstructionFileSummarySchema, InstructionFileSchema, InstructionFileIdSchema,
} from "./schemas";

export type BackendMode = z.infer<typeof BackendSnapshotSchema>["mode"];
export type BackendPhase = z.infer<typeof BackendSnapshotSchema>["phase"];
export type MockScenarioId = z.infer<typeof MockScenarioIdSchema>;
export type TransportLogEntry = z.infer<typeof TransportLogEntrySchema>;
export type BackendSnapshot = z.infer<typeof BackendSnapshotSchema>;
export type MockScenario = z.infer<typeof MockScenarioSchema>;
export type DesktopAgentEvent = z.infer<typeof DesktopAgentEventSchema>;
export type AppCommand = z.infer<typeof AppCommandSchema>;
export type DesktopInteractionRequest = z.infer<typeof DesktopInteractionRequestSchema>;
export type ChatControlsSnapshot = z.infer<typeof ChatControlsSnapshotSchema>;
export type ModelPersistenceMode = z.infer<typeof ModelPersistenceModeSchema>;
export type AgentControlUpdate = z.infer<typeof AgentControlUpdateSchema>;
export type ControlMutationResult = z.infer<typeof ControlMutationResultSchema>;
export type DesktopModelMetadata = z.infer<typeof DesktopModelMetadataSchema>;
export type MoAPresetSummary = z.infer<typeof MoAPresetSummarySchema>;
export type AdvisorControl = z.infer<typeof AdvisorControlSchema>;
export type ContextUsageEvent = Extract<DesktopAgentEvent, { type: "context-usage" }>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;
export type RestoredTranscriptEntry = z.infer<typeof RestoredTranscriptEntrySchema>;
export type RestoredTranscriptMessage = z.infer<typeof RestoredTranscriptMessageSchema>;
export type RestoredTodo = z.infer<typeof RestoredTodoSchema>;
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;
export type FilePreview = z.infer<typeof FilePreviewSchema>;
export type SettingsSection = z.infer<typeof SettingsSectionSchema>;
export type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
export type CronJob = z.infer<typeof CronJobSchema>;
export type CronJobInput = z.infer<typeof CronJobInputSchema>;
export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export type SkillDetail = z.infer<typeof SkillDetailSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpServerUpsert = z.infer<typeof McpServerUpsertSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type MemoryMutation = z.infer<typeof MemoryMutationSchema>;
export type NoteResult = z.infer<typeof NoteResultSchema>;
export type NoteImportResult = z.infer<typeof NoteImportResultSchema>;
export type NoteSearchMode = z.infer<typeof NoteSearchModeSchema>;
export type DreamSummary = z.infer<typeof DreamSummarySchema>;
export type DreamProgress = z.infer<typeof DreamProgressSchema>;
export type InstructionFileSummary = z.infer<typeof InstructionFileSummarySchema>;
export type InstructionFile = z.infer<typeof InstructionFileSchema>;
export type InstructionFileId = z.infer<typeof InstructionFileIdSchema>;

export interface KnowledgeDesktopApi {
  listMemories: (query?: string) => Promise<readonly Memory[]>;
  createMemory: (value: MemoryMutation) => Promise<Memory>;
  updateMemory: (id: string, value: MemoryMutation) => Promise<Memory>;
  deleteMemory: (id: string) => Promise<void>;
  importNotes: () => Promise<NoteImportResult>;
  searchNotes: (query: string, mode: NoteSearchMode) => Promise<readonly NoteResult[]>;
  runDream: () => Promise<DreamSummary>;
  onDreamProgress: (listener: (progress: DreamProgress) => void) => () => void;
  listInstructionFiles: () => Promise<readonly InstructionFileSummary[]>;
  getInstructionFile: (id: InstructionFileId) => Promise<InstructionFile>;
  updateInstructionFile: (id: InstructionFileId, content: string) => Promise<InstructionFile>;
}

export interface RailgunDesktopApi extends KnowledgeDesktopApi {
  getBackendSnapshot: () => Promise<BackendSnapshot>;
  restartBackend: () => Promise<BackendSnapshot>;
  onBackendSnapshot: (listener: (snapshot: BackendSnapshot) => void) => () => void;
  listMockScenarios: () => Promise<readonly MockScenario[]>;
  selectMockScenario: (id: MockScenarioId) => Promise<BackendSnapshot>;
  sendPrompt: (message: string) => Promise<void>;
  steerPrompt: (message: string) => Promise<void>;
  followUpPrompt: (message: string) => Promise<void>;
  abortPrompt: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  listFiles: (pathSegments: readonly string[]) => Promise<DirectoryListing>;
  previewFile: (pathSegments: readonly string[]) => Promise<FilePreview>;
  revealFile: (pathSegments: readonly string[]) => Promise<void>;
  startNewChat: () => Promise<SessionSnapshot>;
  listSessions: () => Promise<readonly SessionSummary[]>;
  resumeSession: (sessionId: string) => Promise<SessionSnapshot>;
  branchSession: (messageId: number, summarize: boolean) => Promise<SessionSnapshot>;
  forkSession: (sessionId: string) => Promise<SessionSnapshot>;
  showSessionContextMenu: (sessionId: string) => Promise<"fork" | null>;
  onSessionSnapshot: (listener: (snapshot: SessionSnapshot) => void) => () => void;
  getChatControls: () => Promise<ChatControlsSnapshot>;
  setChatModel: (modelId: string, persistence: ModelPersistenceMode) => Promise<ControlMutationResult>;
  updateAgentControls: (update: AgentControlUpdate) => Promise<ControlMutationResult>;
  compactContext: () => Promise<ControlMutationResult>;
  getSettings: () => Promise<SettingsSnapshot>;
  updateSettings: (update: SettingsUpdate) => Promise<SettingsSnapshot>;
  listCronJobs: () => Promise<readonly CronJob[]>;
  createCronJob: (input: CronJobInput) => Promise<CronJob>;
  updateCronJob: (id: string, input: CronJobInput) => Promise<CronJob>;
  deleteCronJob: (id: string) => Promise<void>;
  signInDevin: () => Promise<SettingsSnapshot>;
  signOutDevin: () => Promise<SettingsSnapshot>;
  listSkills: () => Promise<readonly SkillSummary[]>;
  getSkill: (name: string) => Promise<SkillDetail>;
  listMcpServers: () => Promise<readonly McpServer[]>;
  upsertMcpServer: (server: McpServerUpsert) => Promise<readonly McpServer[]>;
  removeMcpServer: (name: string) => Promise<readonly McpServer[]>;
  onAgentEvent: (listener: (event: DesktopAgentEvent) => void) => () => void;
  respondToApproval: (id: string, approved: boolean) => Promise<void>;
  respondToClarification: (id: string, answer: string) => Promise<void>;
  onInteractionRequest: (listener: (request: DesktopInteractionRequest) => void) => () => void;
  onAppCommand: (listener: (command: AppCommand) => void) => () => void;
}

export const DESKTOP_IPC = {
  getBackendSnapshot: "backend:get-snapshot",
  restartBackend: "backend:restart",
  backendSnapshot: "backend:snapshot",
  listMockScenarios: "mock:list-scenarios",
  selectMockScenario: "mock:select-scenario",
  sendPrompt: "agent:prompt",
  steerPrompt: "agent:steer",
  followUpPrompt: "agent:follow-up",
  abortPrompt: "agent:abort",
  openExternal: "shell:open-external",
  listFiles: "files:list",
  previewFile: "files:preview",
  revealFile: "files:reveal",
  startNewChat: "agent:new-chat",
  listSessions: "sessions:list",
  resumeSession: "sessions:resume",
  branchSession: "sessions:branch",
  forkSession: "sessions:fork",
  showSessionContextMenu: "sessions:context-menu",
  sessionSnapshot: "sessions:snapshot",
  getChatControls: "agent:get-chat-controls",
  setChatModel: "agent:set-chat-model",
  updateAgentControls: "agent:update-controls",
  compactContext: "agent:compact-context",
  getSettings: "settings:get",
  updateSettings: "settings:update",
  signInDevin: "settings:sign-in-devin",
  signOutDevin: "settings:sign-out-devin",
  listCronJobs: "cron:list",
  createCronJob: "cron:create",
  updateCronJob: "cron:update",
  deleteCronJob: "cron:delete",
  listSkills: "knowledge:list-skills",
  getSkill: "knowledge:get-skill",
  listMcpServers: "settings:list-mcp-servers",
  upsertMcpServer: "settings:upsert-mcp-server",
  removeMcpServer: "settings:remove-mcp-server",
  agentEvent: "agent:event",
  appCommand: "app:command",
  interactionRequest: "agent:interaction-request",
  respondToApproval: "agent:approval-response",
  respondToClarification: "agent:clarification-response",
  listMemories: "knowledge:memories-list",
  createMemory: "knowledge:memory-create",
  updateMemory: "knowledge:memory-update",
  deleteMemory: "knowledge:memory-delete",
  importNotes: "knowledge:notes-import",
  searchNotes: "knowledge:notes-search",
  runDream: "knowledge:dream-run",
  dreamProgress: "knowledge:dream-progress",
  listInstructionFiles: "knowledge:instructions-list",
  getInstructionFile: "knowledge:instruction-get",
  updateInstructionFile: "knowledge:instruction-update",
} as const;
