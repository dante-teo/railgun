import { appendFileSync, fsyncSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createDiagnosticRecord } from "./schema.js";
import { clearOperation, createWatchdogState, evaluateWatchdog, noteHeartbeat, noteProgress } from "./watchdog.js";
import type { WatchdogState } from "./watchdog.js";
import { initializeLogFile } from "./storage.js";
import type { DiagnosticsWorkerInput, DiagnosticsWorkerOutput } from "./types.js";

interface WorkerData {
  readonly logDir: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly pid: number;
}

const data = workerData as WorkerData;
const port = parentPort;
if (!port) throw new Error("Interactive diagnostics worker requires a parent port");

const output = (message: DiagnosticsWorkerOutput): void => port.postMessage(message);
const queued: DiagnosticsWorkerInput[] = [];
let accept = (message: DiagnosticsWorkerInput): void => { queued.push(message); };
port.on("message", (message: DiagnosticsWorkerInput) => accept(message));

void initializeLogFile({ logDir: data.logDir, runId: data.runId, pid: data.pid }).then(opened => {
  const fd = opened.handle.fd;
  let watchdog: WatchdogState = createWatchdogState(performance.now());
  let timer: NodeJS.Timeout | undefined;
  let closing = false;
  const write = (record: Parameters<typeof createDiagnosticRecord>[0]): void => {
    appendFileSync(fd, `${JSON.stringify(createDiagnosticRecord({ ...record, runId: data.runId, ...(data.sessionId ? { sessionId: data.sessionId } : {}) }))}\n`);
  };
  const handle = (message: DiagnosticsWorkerInput): void => {
    if (message.type === "record") write(message.record);
    else if (message.type === "heartbeat") watchdog = noteHeartbeat(watchdog, message.at);
    else if (message.type === "operation" || message.type === "progress") watchdog = noteProgress(watchdog, message.at, { operationId: message.operationId, phase: message.phase, ...(message.exempt ? { exempt: true } : {}) });
    else if (message.type === "operation_end") watchdog = clearOperation(watchdog, message.at);
    else {
      if (closing) return;
      closing = true;
      if (timer) clearInterval(timer);
      fsyncSync(fd);
      void opened.handle.close().then(() => output({ type: "closed" }));
    }
  };
  accept = handle;
  output({ type: "ready", path: opened.path, latestPath: opened.latestPath });
  write({ event: "diagnostics_start", outcome: "success" });
  queued.splice(0).forEach(handle);
  if (closing) return;
  timer = setInterval(() => {
    const evaluated = evaluateWatchdog(watchdog, performance.now());
    watchdog = evaluated.state;
    evaluated.events.forEach(event => {
      write({ event: event.event, severity: event.event.endsWith("stall") ? "warning" : "info", outcome: event.event.endsWith("recovery") ? "recovery" : "progress", durationMs: event.durationMs, ...(event.operationId ? { operationId: event.operationId } : {}), ...(event.phase ? { phase: event.phase } : {}) });
      output({ type: "watchdog", ...event });
    });
  }, 1_000);
  timer.unref();
}).catch(error => output({ type: "failure", errorClass: error instanceof Error ? error.name : "UnknownError" }));
