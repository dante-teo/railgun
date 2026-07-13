export type BackendMode = "real" | "mock";

export type BackendPhase = "starting" | "ready" | "failed" | "disconnected";

export interface TransportLogEntry {
  readonly direction: "system" | "stdin" | "stdout" | "stderr";
  readonly text: string;
}

export interface BackendSnapshot {
  readonly mode: BackendMode;
  readonly phase: BackendPhase;
  readonly scenarioId?: string;
  readonly error?: string;
  readonly diagnostics: readonly string[];
  readonly transportLog: readonly TransportLogEntry[];
}

export interface MockScenario {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface RailgunDesktopApi {
  getBackendSnapshot: () => Promise<BackendSnapshot>;
  onBackendSnapshot: (listener: (snapshot: BackendSnapshot) => void) => () => void;
  listMockScenarios: () => Promise<readonly MockScenario[]>;
  selectMockScenario: (id: string) => Promise<BackendSnapshot>;
}

export const DESKTOP_IPC = {
  getBackendSnapshot: "backend:get-snapshot",
  backendSnapshot: "backend:snapshot",
  listMockScenarios: "mock:list-scenarios",
  selectMockScenario: "mock:select-scenario",
} as const;
