import type { DiagnosticOutcome, DiagnosticRecordInput } from "./schema.js";
import type { DiagnosticStatus } from "./status.js";

export interface OperationStart {
  readonly phase: string;
  readonly operationId?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly toolName?: string;
  readonly exempt?: boolean;
}

export interface OperationProgress {
  readonly phase?: string;
  readonly progressCount?: number;
  readonly messageCount?: number;
  readonly messageBytes?: number;
  readonly terminalColumns?: number;
  readonly terminalRows?: number;
}

export interface OperationObserver {
  readonly progress: (progress?: OperationProgress) => void;
  readonly end: (outcome?: Exclude<DiagnosticOutcome, "start" | "progress" | "recovery">, error?: unknown) => void;
}

export interface InteractiveOperationObserver {
  readonly start: (input: OperationStart) => OperationObserver;
  readonly event: (input: DiagnosticRecordInput) => void;
  readonly ready: () => void;
}

export interface InteractiveDiagnostics {
  readonly runId: string;
  readonly latestLogPath?: string;
  readonly observer: InteractiveOperationObserver;
  readonly status: DiagnosticStatus;
  readonly subscribe: (listener: (status: DiagnosticStatus) => void) => () => void;
  readonly close: () => Promise<void>;
}

export type DiagnosticsWorkerInput =
  | { readonly type: "record"; readonly record: DiagnosticRecordInput }
  | { readonly type: "heartbeat"; readonly at: number }
  | { readonly type: "operation"; readonly at: number; readonly operationId: string; readonly phase: string; readonly exempt?: boolean }
  | { readonly type: "progress"; readonly at: number; readonly operationId: string; readonly phase: string; readonly exempt?: boolean }
  | { readonly type: "operation_end"; readonly at: number; readonly operationId: string }
  | { readonly type: "close" };

export type DiagnosticsWorkerOutput =
  | { readonly type: "ready"; readonly path: string; readonly latestPath: string }
  | { readonly type: "watchdog"; readonly event: "event_loop_stall" | "event_loop_recovery" | "operation_stall" | "operation_recovery"; readonly durationMs: number; readonly operationId?: string; readonly phase?: string }
  | { readonly type: "closed" }
  | { readonly type: "failure"; readonly errorClass: string };
