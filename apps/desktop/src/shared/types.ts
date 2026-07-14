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

export interface RailgunDesktopApi {
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
} as const;
