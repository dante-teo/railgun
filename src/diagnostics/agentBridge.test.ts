import { describe, expect, it, vi } from "vitest";
import { createAgentDiagnosticsBridge } from "./agentBridge.js";
import type { InteractiveOperationObserver, OperationObserver } from "./types.js";

describe("agent diagnostics mapping", () => {
  it("maps provider, tool, compaction, MoA, and cancellation without payload leakage", () => {
    const starts: unknown[] = [];
    const progress = vi.fn();
    const end = vi.fn();
    const operation: OperationObserver = { progress, end };
    const observer: InteractiveOperationObserver = {
      start: vi.fn(input => { starts.push(input); return operation; }),
      event: vi.fn(),
      ready: vi.fn(),
    };
    const bridge = createAgentDiagnosticsBridge(observer, { model: "model-a", sessionId: "session-a" });

    bridge.handle({ type: "message_start", message: { role: "assistant", content: [] } });
    bridge.handle({ type: "message_update", streamEvent: { type: "text_delta", delta: "private assistant text" } });
    bridge.handle({ type: "tool_execution_start", toolCallId: "tool-id", toolName: "run_shell", args: { command: "private command" } });
    bridge.handle({ type: "tool_execution_end", toolCallId: "tool-id", toolName: "run_shell", result: { toolCallId: "tool-id", content: "private result", isError: false } });
    bridge.handle({ type: "compaction_start", reason: "threshold" });
    bridge.handle({ type: "moa_reference_start", index: 0, count: 2, model: "reference-model" });
    bridge.handle({ type: "subagent_start", goal: "private goal", index: 0, count: 1 });
    bridge.abort();

    const serialized = JSON.stringify({ starts, calls: progress.mock.calls });
    expect(serialized).not.toContain("private assistant text");
    expect(serialized).not.toContain("private command");
    expect(serialized).not.toContain("private result");
    expect(serialized).not.toContain("private goal");
    expect(starts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "provider_stream", model: "model-a" }),
      expect.objectContaining({ phase: "tool", toolName: "run_shell", operationId: "tool-id" }),
      expect.objectContaining({ phase: "compaction" }),
      expect.objectContaining({ phase: "moa_reference", model: "reference-model" }),
      expect.objectContaining({ phase: "advisor_work" }),
    ]));
    expect(progress).toHaveBeenCalledWith({ messageBytes: 22, progressCount: 1 });
    expect(end).toHaveBeenCalledWith("abort");
  });

  it("leaves the active child as the most recent watchdog progress", () => {
    const calls: string[] = [];
    const observer: InteractiveOperationObserver = {
      start: input => {
        calls.push(`start:${input.phase}`);
        return {
          progress: () => { calls.push(`progress:${input.phase}`); },
          end: () => { calls.push(`end:${input.phase}`); },
        };
      },
      event: vi.fn(),
      ready: vi.fn(),
    };
    const bridge = createAgentDiagnosticsBridge(observer);
    bridge.handle({ type: "agent_start" });
    bridge.handle({ type: "message_start", message: { role: "assistant", content: [] } });
    bridge.handle({ type: "message_update", streamEvent: { type: "text_delta", delta: "secret" } });
    expect(calls.at(-1)).toBe("progress:provider_stream");

    bridge.handle({ type: "tool_execution_start", toolCallId: "tool-id", toolName: "read_file", args: {} });
    expect(calls.at(-1)).toBe("start:tool");
  });
});
