export interface ActiveDiagnosticOperation {
  readonly operationId: string;
  readonly phase: string;
  readonly startedAt: number;
  readonly toolName?: string;
}

export interface DiagnosticStatus {
  readonly kind: "ready" | "working" | "stalled" | "unavailable";
  readonly since: number;
  readonly operations: readonly ActiveDiagnosticOperation[];
  readonly stallKind?: "event_loop" | "operation";
  readonly latestLogPath?: string;
}

export type DiagnosticStatusAction =
  | { readonly type: "ready"; readonly at: number }
  | { readonly type: "start"; readonly operationId: string; readonly phase: string; readonly toolName?: string; readonly at: number }
  | { readonly type: "progress"; readonly operationId: string; readonly phase?: string; readonly at: number }
  | { readonly type: "end"; readonly operationId: string; readonly at: number }
  | { readonly type: "stall"; readonly kind: "event_loop" | "operation"; readonly latestLogPath?: string; readonly at: number }
  | { readonly type: "recovery"; readonly at: number }
  | { readonly type: "unavailable"; readonly at: number };

const readyStatus = (at: number): DiagnosticStatus => ({ kind: "ready", since: at, operations: [] });

export const reduceDiagnosticStatus = (state: DiagnosticStatus | undefined, action: DiagnosticStatusAction): DiagnosticStatus => {
  const current = state ?? readyStatus(action.at);
  if (action.type === "ready") return readyStatus(action.at);
  if (action.type === "unavailable") return { kind: "unavailable", since: action.at, operations: [] };
  if (action.type === "stall") return { ...current, kind: "stalled", stallKind: action.kind, ...(action.latestLogPath ? { latestLogPath: action.latestLogPath } : {}) };
  if (action.type === "recovery") {
    if (current.operations.length === 0) return readyStatus(action.at);
    const { stallKind: _stallKind, latestLogPath: _latestLogPath, ...recovered } = current;
    return { ...recovered, kind: "working", since: current.operations[0]!.startedAt };
  }
  if (action.type === "start") {
    const operation = { operationId: action.operationId, phase: action.phase, startedAt: action.at, ...(action.toolName ? { toolName: action.toolName } : {}) };
    const existing = current.operations.filter(item => item.operationId !== action.operationId);
    return { kind: "working", since: existing.length === 0 ? action.at : Math.min(current.since, action.at), operations: [...existing, operation] };
  }
  if (action.type === "progress") {
    return { ...current, operations: current.operations.map(item => item.operationId === action.operationId ? { ...item, ...(action.phase ? { phase: action.phase } : {}) } : item) };
  }
  const operations = current.operations.filter(item => item.operationId !== action.operationId);
  return operations.length === 0 ? readyStatus(action.at) : { kind: "working", since: Math.min(...operations.map(item => item.startedAt)), operations };
};

export const formatElapsed = (durationMs: number): string => {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

const operationLabel = (operations: readonly ActiveDiagnosticOperation[]): string => {
  const tools = operations.filter(operation => operation.phase === "tool");
  if (tools.length > 1) return `tools (${tools.length})`;
  const selected = operations.at(-1);
  if (!selected) return "ready";
  return selected.phase === "tool" && selected.toolName ? `tool: ${selected.toolName}` : selected.phase.replaceAll("_", " ");
};

export const statusText = (status: DiagnosticStatus, now: number): string => {
  if (status.kind === "unavailable") return "logs unavailable";
  if (status.kind === "ready") return "ready";
  const elapsed = formatElapsed(now - status.since);
  if (status.kind === "stalled") return `STALLED · ${operationLabel(status.operations)} · ${elapsed}${status.latestLogPath ? ` · ${status.latestLogPath}` : ""}`;
  return `${operationLabel(status.operations)} · ${elapsed}`;
};
