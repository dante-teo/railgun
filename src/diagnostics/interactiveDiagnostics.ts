import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { INTERACTIVE_LOGS_PATH } from "../paths.js";
import { createDiagnosticRecord } from "./schema.js";
import type { DiagnosticOutcome, DiagnosticRecordInput } from "./schema.js";
import { reduceDiagnosticStatus } from "./status.js";
import type { DiagnosticStatus, DiagnosticStatusAction } from "./status.js";
import type { DiagnosticsWorkerInput, DiagnosticsWorkerOutput, InteractiveDiagnostics, InteractiveOperationObserver, OperationObserver, OperationProgress, OperationStart } from "./types.js";

export type { InteractiveDiagnostics, InteractiveOperationObserver, OperationObserver } from "./types.js";
export type { DiagnosticStatus } from "./status.js";

const noopOperation: OperationObserver = Object.freeze({ progress: () => {}, end: () => {} });
const noopObserver: InteractiveOperationObserver = Object.freeze({ start: () => noopOperation, event: () => {}, ready: () => {} });

const createPassiveInteractiveDiagnostics = (status: DiagnosticStatus): InteractiveDiagnostics => Object.freeze({
  runId: "noop",
  observer: noopObserver,
  status,
  subscribe: () => () => {},
  close: async () => {},
});

export const createNoopInteractiveDiagnostics = (): InteractiveDiagnostics =>
  createPassiveInteractiveDiagnostics(reduceDiagnosticStatus(undefined, { type: "ready", at: 0 }));

export const createUnavailableInteractiveDiagnostics = (): InteractiveDiagnostics =>
  createPassiveInteractiveDiagnostics(reduceDiagnosticStatus(undefined, { type: "unavailable", at: 0 }));

const errorFields = (error: unknown): Pick<DiagnosticRecordInput, "errorClass" | "errorMessage"> => ({
  errorClass: error instanceof Error ? error.name : "UnknownError",
  errorMessage: error instanceof Error ? error.message : String(error),
});

export interface InteractiveDiagnosticsOptions {
  readonly logDir?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly now?: () => number;
  readonly workerFactory?: (url: URL, options: ConstructorParameters<typeof Worker>[1]) => Worker;
  readonly shutdownTimeoutMs?: number;
}

export const createInteractiveDiagnostics = (options: InteractiveDiagnosticsOptions = {}): InteractiveDiagnostics => {
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => performance.now());
  const logDir = options.logDir ?? INTERACTIVE_LOGS_PATH;
  const latestLogPath = join(logDir, "interactive-latest.jsonl");
  const listeners = new Set<(status: DiagnosticStatus) => void>();
  let status = reduceDiagnosticStatus(undefined, { type: "start", operationId: "startup", phase: "startup", at: now() });
  let closed = false;
  let workerFailed = false;
  const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
  const workerOptions: ConstructorParameters<typeof Worker>[1] = {
    workerData: { logDir, runId, pid: process.pid, ...(options.sessionId ? { sessionId: options.sessionId } : {}) },
  };
  const worker = options.workerFactory
    ? options.workerFactory(workerUrl, workerOptions)
    : import.meta.url.endsWith(".ts")
      ? new Worker(
        `import("tsx/esm/api").then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, ${JSON.stringify(import.meta.url)}))`,
        { ...workerOptions, eval: true },
      )
      : new Worker(workerUrl, workerOptions);

  const updateStatus = (action: DiagnosticStatusAction): void => {
    status = reduceDiagnosticStatus(status, action);
    listeners.forEach(listener => listener(status));
  };
  const post = (message: DiagnosticsWorkerInput): void => {
    if (!closed && !workerFailed) worker.postMessage(message);
  };
  const record = (input: DiagnosticRecordInput): void => post({ type: "record", record: createDiagnosticRecord({ ...input, runId, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }) });

  worker.on("message", (message: DiagnosticsWorkerOutput) => {
    if (message.type === "watchdog") {
      const isRecovery = message.event.endsWith("recovery");
      updateStatus(isRecovery
        ? { type: "recovery", at: now() }
        : { type: "stall", kind: message.event.startsWith("event_loop") ? "event_loop" : "operation", at: now(), latestLogPath });
    } else if (message.type === "failure") {
      workerFailed = true;
      updateStatus({ type: "unavailable", at: now() });
    }
  });
  worker.on("error", () => {
    workerFailed = true;
    updateStatus({ type: "unavailable", at: now() });
  });
  worker.on("exit", code => {
    if (!closed && code !== 0) {
      workerFailed = true;
      updateStatus({ type: "unavailable", at: now() });
    }
  });

  const heartbeat = setInterval(() => post({ type: "heartbeat", at: now() }), 2_000);
  heartbeat.unref();
  const warningListener = (warning: Error): void => record({ event: "process_warning", severity: "warning", errorClass: warning.name, errorMessage: warning.message });
  process.on("warning", warningListener);

  const observer: InteractiveOperationObserver = Object.freeze({
    start: (input: OperationStart): OperationObserver => {
      const operationId = input.operationId ?? randomUUID();
      const startedAt = now();
      const base = { operationId, phase: input.phase, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.model ? { model: input.model } : {}), ...(input.toolName ? { toolName: input.toolName } : {}) };
      updateStatus({ type: "start", operationId, phase: input.phase, ...(input.toolName ? { toolName: input.toolName } : {}), at: startedAt });
      post({ type: "operation", at: startedAt, operationId, phase: input.phase, ...(input.exempt ? { exempt: true } : {}) });
      record({ event: "operation_start", severity: "info", outcome: "start", ...base });
      let ended = false;
      return Object.freeze({
        progress: (progress?: OperationProgress) => {
          if (ended) return;
          const at = now();
          const phase = progress?.phase ?? input.phase;
          updateStatus({ type: "progress", operationId, phase, at });
          post({ type: "progress", at, operationId, phase, ...(input.exempt ? { exempt: true } : {}) });
          record({ event: "operation_progress", severity: "debug", outcome: "progress", ...base, ...progress, phase, durationMs: at - startedAt });
        },
        end: (outcome: Exclude<DiagnosticOutcome, "start" | "progress" | "recovery"> = "success", error?: unknown) => {
          if (ended) return;
          ended = true;
          const at = now();
          updateStatus({ type: "end", operationId, at });
          post({ type: "operation_end", at, operationId });
          const fallback = status.operations.at(-1);
          if (fallback) post({ type: "progress", at, operationId: fallback.operationId, phase: fallback.phase });
          record({ event: `operation_${outcome}`, severity: outcome === "failure" || outcome === "timeout" ? "error" : "info", outcome, ...base, durationMs: at - startedAt, ...(error === undefined ? {} : errorFields(error)) });
        },
      });
    },
    event: record,
    ready: () => updateStatus({ type: "end", operationId: "startup", at: now() }),
  });

  const diagnostics: InteractiveDiagnostics = {
    runId,
    latestLogPath,
    observer,
    get status() { return status; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    close: async () => {
      if (closed) return;
      clearInterval(heartbeat);
      process.off("warning", warningListener);
      record({ event: "diagnostics_shutdown", outcome: "success" });
      const { promise, resolve } = Promise.withResolvers<void>();
      const timeout = setTimeout(resolve, options.shutdownTimeoutMs ?? 1_000);
      const onCloseMessage = (message: DiagnosticsWorkerOutput): void => { if (message.type === "closed") resolve(); };
      worker.on("message", onCloseMessage);
      post({ type: "close" });
      await promise;
      clearTimeout(timeout);
      worker.off("message", onCloseMessage);
      closed = true;
      await worker.terminate().catch(() => undefined);
    },
  };
  return Object.freeze(diagnostics);
};
