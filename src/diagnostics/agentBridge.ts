import type { AgentSessionEvent } from "../agent/agentSession.js";
import type { InteractiveOperationObserver, OperationObserver } from "./types.js";

export interface AgentDiagnosticsBridge {
  readonly handle: (event: AgentSessionEvent) => void;
  readonly complete: () => void;
  readonly fail: (error: unknown) => void;
  readonly abort: () => void;
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export const createAgentDiagnosticsBridge = (
  observer: InteractiveOperationObserver,
  correlation: { readonly sessionId?: string; readonly model?: string } = {},
): AgentDiagnosticsBridge => {
  const operations = new Map<string, OperationObserver>();
  const start = (key: string, phase: string, extra: { readonly operationId?: string; readonly model?: string; readonly toolName?: string } = {}): void => {
    operations.get(key)?.end("abort");
    operations.set(key, observer.start({ phase, ...correlation, ...extra }));
  };
  const progress = (key: string, value: Parameters<OperationObserver["progress"]>[0]): void => operations.get(key)?.progress(value);
  const end = (key: string, outcome: Parameters<OperationObserver["end"]>[0] = "success", error?: unknown): void => {
    const operation = operations.get(key);
    if (error === undefined) operation?.end(outcome);
    else operation?.end(outcome, error);
    operations.delete(key);
  };
  const settle = (outcome: Parameters<OperationObserver["end"]>[0], error?: unknown): void => {
    [...operations.values()].forEach(operation => error === undefined ? operation.end(outcome) : operation.end(outcome, error));
    operations.clear();
  };

  const handle = (event: AgentSessionEvent): void => {
    if (event.type !== "queue_update" && event.type !== "agent_settled") progress("turn", { progressCount: 1 });
    if (event.type === "agent_start") start("turn", "agent_turn");
    else if (event.type === "agent_end") end("turn");
    else if (event.type === "message_start" && event.message.role === "assistant") start("provider", "provider_stream");
    else if (event.type === "message_update") {
      const bytes = event.streamEvent.type === "text_delta" ? byteLength(event.streamEvent.delta) : 0;
      progress("provider", { messageBytes: bytes, progressCount: 1 });
    } else if (event.type === "message_end" && event.message.role === "assistant") end("provider");
    else if (event.type === "tool_execution_start") start(`tool:${event.toolCallId}`, "tool", { operationId: event.toolCallId, toolName: event.toolName });
    else if (event.type === "tool_execution_end") end(`tool:${event.toolCallId}`, event.result.isError ? "failure" : "success");
    else if (event.type === "compaction_start") start("compaction", "compaction");
    else if (event.type === "compaction_end") end("compaction");
    else if (event.type === "moa_reference_start") start(`moa:${event.index}`, "moa_reference", { model: event.model });
    else if (event.type === "moa_reference_end") end(`moa:${event.index}`, event.text.startsWith("[failed:") ? "failure" : "success");
    else if (event.type === "moa_aggregating") start("moa:aggregate", "moa_aggregation", { model: event.aggregator });
    else if (event.type === "subagent_start") start(`subagent:${event.index}`, "advisor_work");
    else if (event.type === "subagent_end") end(`subagent:${event.index}`, event.result.startsWith("[failed:") ? "failure" : "success");
    else if (event.type === "turn_end") end("moa:aggregate");
  };

  return Object.freeze({
    handle,
    complete: () => settle("success"),
    fail: (error: unknown) => settle("failure", error),
    abort: () => settle("abort"),
  });
};
