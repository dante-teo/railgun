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
  agentEvent: "agent:event",
  appCommand: "app:command",
  interactionRequest: "agent:interaction-request",
  respondToApproval: "agent:approval-response",
  respondToClarification: "agent:clarification-response",
} as const;
