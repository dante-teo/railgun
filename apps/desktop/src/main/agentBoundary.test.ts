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
    })).toEqual({ type: "tool-start", id: "tool-1", name: "read_file" });
    expect(toDesktopAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read_file",
      result: { content: "secret", isError: true },
    })).toEqual({ type: "tool-end", id: "tool-1", name: "read_file", failed: true });
  });

  it("withholds malformed and unrelated backend data", () => {
    expect(toDesktopAgentEvent(null)).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "message_update", streamEvent: { type: "text_delta", delta: 7 } })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "response", data: { token: "secret" } })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "queue_update", steering: [7], followUp: [] })).toBeUndefined();
    expect(toDesktopAgentEvent({ type: "message_end", message: { role: "user", content: "hidden" } })).toBeUndefined();
  });
});
