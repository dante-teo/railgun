import { describe, expect, it } from "vitest";
import { toDesktopAgentEvent } from "./agentBoundary";

describe("agent renderer boundary", () => {
  it("reduces backend events to the renderer vocabulary", () => {
    expect(toDesktopAgentEvent({ type: "agent_start" })).toEqual({ type: "run-start" });
    expect(toDesktopAgentEvent({
      type: "message_update",
      streamEvent: { type: "text_delta", delta: "hello", secret: "withheld" },
    })).toEqual({ type: "assistant-delta", text: "hello" });
    expect(toDesktopAgentEvent({ type: "message_end", message: { role: "assistant", content: "hello" } }))
      .toEqual({ type: "assistant-complete" });
    expect(toDesktopAgentEvent({ type: "queue_update", steering: ["one"], followUp: ["two"] }))
      .toEqual({ type: "queue-update", steering: ["one"], followUp: ["two"] });
    expect(toDesktopAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read_file",
      args: { path: "/secret" },
    })).toEqual({ type: "tool-start", id: "tool-1", name: "read_file", input: '{\n  "path": "/secret"\n}' });
    expect(toDesktopAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read_file",
      result: { content: "secret", isError: true },
    })).toEqual({ type: "tool-end", id: "tool-1", name: "read_file", failed: true, output: "secret" });
  });

  it("maps exact usage totals and automatic compaction resets", () => {
    expect(toDesktopAgentEvent({
      type: "turn_end",
      message: { role: "assistant", content: [] },
      toolResults: [],
      usage: { inputTokens: 120, outputTokens: 30 },
    })).toEqual({ type: "context-usage", inputTokens: 120, outputTokens: 30 });
    expect(toDesktopAgentEvent({ type: "compaction_start", reason: "threshold" }))
      .toEqual({ type: "context-reset", reason: "compaction" });
    expect(toDesktopAgentEvent({ type: "turn_end", usage: { inputTokens: -1, outputTokens: 2 } }))
      .toBeUndefined();
  });

  it("recursively redacts and truncates tool details at the renderer boundary", () => {
    const event = toDesktopAgentEvent({
      type: "tool_execution_start", toolCallId: "tool-1", toolName: "run_shell",
      args: {
        password: "hunter2",
        nested: [{ apiToken: "abc" }],
        command: `PASSWORD=plain-secret DEVIN_TOKEN=devin-secret api_key: key-secret curl -H 'Authorization: Bearer abc.def.ghi' ${"x".repeat(9_000)}`,
      },
    });
    expect(event).toMatchObject({ type: "tool-start", id: "tool-1" });
    if (event?.type !== "tool-start") throw new Error("expected tool start");
    expect(event.input).toContain('"password": "[REDACTED]"');
    expect(event.input).toContain('"apiToken": "[REDACTED]"');
    expect(event.input).not.toContain("abc.def.ghi");
    expect(event.input).not.toContain("plain-secret");
    expect(event.input).not.toContain("devin-secret");
    expect(event.input).not.toContain("key-secret");
    expect(event.input?.length).toBeLessThanOrEqual(8_000);
  });

  it("normalizes valid successful todo output and withholds malformed todo data", () => {
    const base = { type: "tool_execution_end", toolCallId: "todo-1", toolName: "todo" };
    expect(toDesktopAgentEvent({ ...base, result: { isError: false, content: JSON.stringify({ todos: [
      { id: "a", content: "First", status: "in_progress", ignored: true },
      { id: "b", content: "Second" },
    ] }) } })).toMatchObject({
      type: "tool-end", failed: false,
      todos: [{ id: "a", content: "First", status: "in_progress" }, { id: "b", content: "Second", status: "pending" }],
    });
    const malformed = toDesktopAgentEvent({ ...base, result: { isError: false, content: '{"todos":[{"id":7}]}' } });
    expect(malformed).toMatchObject({ type: "tool-end", failed: false });
    expect(malformed).not.toHaveProperty("todos");
  });

  it("maps bounded MoA, advisor, and subagent activity without exposing advisory XML", () => {
    expect(toDesktopAgentEvent({ type: "moa_reference_start", index: 0, count: 2, model: "ref-model" }))
      .toEqual({ type: "moa-reference-start", index: 0, count: 2, model: "ref-model" });
    expect(toDesktopAgentEvent({ type: "moa_reference_end", index: 0, model: "ref-model", text: "private advice" }))
      .toEqual({ type: "moa-reference-end", index: 0, model: "ref-model", preview: "private advice" });
    expect(toDesktopAgentEvent({ type: "moa_aggregating", aggregator: "agg", refCount: 2 }))
      .toEqual({ type: "moa-aggregating", model: "agg", refCount: 2 });
    expect(toDesktopAgentEvent({ type: "message_start", message: { role: "user", content: '<advisory severity="blocker">Fix &amp; verify</advisory>' } }))
      .toEqual({ type: "advisor-note", severity: "blocker", text: "Fix & verify" });
    expect(toDesktopAgentEvent({ type: "message_start", message: { role: "user", content: '<advisory severity="unknown">raw</advisory>' } }))
      .toBeUndefined();
    expect(toDesktopAgentEvent({ type: "subagent_start", goal: "Inspect", index: 0, count: 1 }))
      .toEqual({ type: "subagent-start", goal: "Inspect", index: 0, count: 1 });
    expect(toDesktopAgentEvent({ type: "subagent_end", goal: "Inspect", index: 0, result: "Done" }))
      .toEqual({ type: "subagent-end", goal: "Inspect", index: 0, result: "Done" });
  });

  it("withholds malformed and unrelated backend data", () => {
    expect(toDesktopAgentEvent(null)).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "message_update", streamEvent: { type: "text_delta", delta: 7 } })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "response", data: { token: "secret" } })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "queue_update", steering: [7], followUp: [] })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "message_end", message: { role: "user", content: "hidden" } })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "tool_execution_end", toolCallId: "x", toolName: "read_file", result: null })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "tool_execution_end", toolCallId: "x", toolName: "read_file", result: { isError: false, content: 7 } })).toBeUndefined();
  });
});
