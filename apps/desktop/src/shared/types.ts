import type { z } from "zod";
import type {
  AppCommandSchema,
  BackendSnapshotSchema,
  DesktopInteractionRequestSchema,
  DesktopAgentEventSchema,
  MockScenarioIdSchema,
  MockScenarioSchema,
  TransportLogEntrySchema,
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
  startNewChat: () => Promise<BackendSnapshot>;
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
  agentEvent: "agent:event",
  appCommand: "app:command",
  interactionRequest: "agent:interaction-request",
  respondToApproval: "agent:approval-response",
  respondToClarification: "agent:clarification-response",
} as const;
