import type { z } from "zod";
import type {
  BackendSnapshotSchema,
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

export interface RailgunDesktopApi {
  getBackendSnapshot: () => Promise<BackendSnapshot>;
  restartBackend: () => Promise<BackendSnapshot>;
  onBackendSnapshot: (listener: (snapshot: BackendSnapshot) => void) => () => void;
  listMockScenarios: () => Promise<readonly MockScenario[]>;
  selectMockScenario: (id: MockScenarioId) => Promise<BackendSnapshot>;
  sendPrompt: (message: string) => Promise<void>;
  abortPrompt: () => Promise<void>;
  startNewChat: () => Promise<BackendSnapshot>;
  onAgentEvent: (listener: (event: DesktopAgentEvent) => void) => () => void;
}

export const DESKTOP_IPC = {
  getBackendSnapshot: "backend:get-snapshot",
  restartBackend: "backend:restart",
  backendSnapshot: "backend:snapshot",
  listMockScenarios: "mock:list-scenarios",
  selectMockScenario: "mock:select-scenario",
  sendPrompt: "agent:prompt",
  abortPrompt: "agent:abort",
  startNewChat: "agent:new-chat",
  agentEvent: "agent:event",
} as const;
