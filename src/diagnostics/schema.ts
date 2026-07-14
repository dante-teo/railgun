export type DiagnosticSeverity = "debug" | "info" | "warning" | "error";
export type DiagnosticOutcome = "start" | "progress" | "success" | "failure" | "timeout" | "abort" | "recovery";

export interface DiagnosticRecordInput {
  readonly event: string;
  readonly severity?: DiagnosticSeverity;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly operationId?: string;
  readonly phase?: string;
  readonly durationMs?: number;
  readonly outcome?: DiagnosticOutcome;
  readonly model?: string;
  readonly toolName?: string;
  readonly errorClass?: string;
  readonly errorMessage?: string;
  readonly progressCount?: number;
  readonly messageCount?: number;
  readonly messageBytes?: number;
  readonly terminalColumns?: number;
  readonly terminalRows?: number;
}

export interface DiagnosticRecord extends DiagnosticRecordInput {
  readonly timestamp: string;
  readonly severity: DiagnosticSeverity;
  readonly process: {
    readonly pid: number;
    readonly platform: NodeJS.Platform;
    readonly node: string;
  };
}

const MAX_ERROR_LENGTH = 512;
const scrubbers: readonly [RegExp, string][] = [
  [/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]"],
  [/\b(password|token|secret|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]"],
  [/\b(command failed|command|spawn|exec(?:file)?)\s*[:=]?\s*[^\r\n]*/gi, "$1 [REDACTED]"],
  [/(?:\/[\w.-]+){2,}/g, "[PATH]"],
  [/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\s]+/g, "[PATH]"],
];

export const redactErrorMessage = (message: string): string =>
  scrubbers.reduce((safe, [pattern, replacement]) => safe.replace(pattern, replacement), message)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_ERROR_LENGTH);

const optional = <K extends keyof DiagnosticRecordInput>(
  input: DiagnosticRecordInput,
  key: K,
): Pick<DiagnosticRecordInput, K> | Record<string, never> => {
  const value = input[key];
  if (value === undefined) return {};
  const safeValue = key === "errorMessage"
    ? redactErrorMessage(String(value))
    : typeof value === "string"
      ? value.replace(/[\r\n\t]+/g, " ").slice(0, 128)
      : typeof value === "number"
        ? Math.max(0, Math.min(Number.isFinite(value) ? value : 0, Number.MAX_SAFE_INTEGER))
        : value;
  return { [key]: safeValue } as Pick<DiagnosticRecordInput, K>;
};

const safeKeys = [
  "runId", "sessionId", "operationId", "phase", "durationMs", "outcome", "model", "toolName",
  "errorClass", "errorMessage", "progressCount", "messageCount", "messageBytes", "terminalColumns", "terminalRows",
] as const;

export const createDiagnosticRecord = (
  input: DiagnosticRecordInput,
  dependencies: { readonly now?: () => Date; readonly pid?: number } = {},
): DiagnosticRecord => ({
  timestamp: (dependencies.now ?? (() => new Date()))().toISOString(),
  event: input.event.slice(0, 80),
  severity: input.severity ?? "info",
  ...safeKeys.reduce((record, key) => ({ ...record, ...optional(input, key) }), {}),
  process: {
    pid: dependencies.pid ?? process.pid,
    platform: process.platform,
    node: process.version,
  },
});
