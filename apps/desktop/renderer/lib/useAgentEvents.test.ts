// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentEvents } from "./useAgentEvents.js";
import type { GatewayEvent } from "../../gateway/protocol.js";
import { installFakeWebSocket } from "./test/fakeWebSocket.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface WsHarness {
  /** Push a GatewayEvent through the WebSocket onmessage handler. */
  readonly injectEvent: (event: GatewayEvent) => void;
  /** Answer a pending request by id with optional data (success=true by default). */
  readonly resolveRequest: (id: string, data?: unknown, success?: boolean) => void;
  /** All messages sent by the client, parsed as objects. */
  readonly getSent: () => Array<Record<string, unknown>>;
  /** Trigger socket open and mark it ready. */
  readonly _open: () => void;
}

const buildWsHarness = (): WsHarness => {
  const ws = installFakeWebSocket();
  const getSent = (): Array<Record<string, unknown>> =>
    ws.rawSent.map(s => JSON.parse(s) as Record<string, unknown>);
  return {
    injectEvent: ws.simulateMessage,
    resolveRequest: (id: string, data?: unknown, success = true) =>
      ws.simulateMessage({ type: "response", id, command: "unknown", success, data }),
    getSent,
    _open: ws.simulateOpen,
  };
};


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAgentEvents", () => {
  let harness: WsHarness;

  beforeEach(() => {
    harness = buildWsHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Render the hook and synchronously open the socket + resolve get_state.
  const render = () => {
    const { result } = renderHook(() => useAgentEvents("ws://localhost:9400"));

    act(() => {
      // Open the socket so sends become effective
      harness._open();
      // The hook immediately sends get_state — find and answer it
      const req = harness.getSent().find(s => s["type"] === "get_state");
      if (req) {
        harness.resolveRequest(req["id"] as string, { running: false, model: "claude-sonnet-4", todos: [] });
      }
    });

    return result;
  };

  it("1. state_update event updates busy, model, and todos", () => {
    const result = render();
    act(() => {
      harness.injectEvent({
        type: "state_update",
        state: { running: true, model: "claude-opus-4", messageCount: 1, todos: [{ id: "t1", content: "Do thing", status: "pending" }] },
      });
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.model).toBe("claude-opus-4");
    expect(result.current.todos).toHaveLength(1);
  });

  it("2. approval_request sets overlay and pendingCommand", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "approval_request", command: "rm -rf /tmp" });
    });
    expect(result.current.overlay?.kind).toBe("approval");
    expect(result.current.pendingCommand).toBe("rm -rf /tmp");
    expect(result.current.composerMode).toBe("awaiting_approval");
  });

  it("3. clarify_request sets overlay and pendingClarify", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "clarify_request", question: "Which path?", choices: ["A", "B"] });
    });
    expect(result.current.overlay?.kind).toBe("clarify");
    expect(result.current.pendingClarify?.question).toBe("Which path?");
    expect(result.current.pendingClarify?.choices).toEqual(["A", "B"]);
  });

  it("4. text_delta events accumulate into streaming", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "state_update", state: { running: true, model: "claude-sonnet-4", messageCount: 1, todos: [] } });
    });
    act(() => {
      harness.injectEvent({ type: "event", event: { type: "message_update", streamEvent: { type: "text_delta", delta: "Hello" } } });
    });
    act(() => {
      harness.injectEvent({ type: "event", event: { type: "message_update", streamEvent: { type: "text_delta", delta: " world" } } });
    });
    expect(result.current.streaming).toBe("Hello world");
  });

  it("5. tool_execution_start adds entry to toolLabels", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "state_update", state: { running: true, model: "claude-sonnet-4", messageCount: 1, todos: [] } });
    });
    act(() => {
      harness.injectEvent({
        type: "event",
        event: { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "echo hi" } },
      });
    });
    expect(result.current.toolLabels.has("tc-1")).toBe(true);
    expect(result.current.toolLabels.get("tc-1")).toContain("bash");
  });

  it("6. tool_execution_end removes from toolLabels and appends a tool line", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "state_update", state: { running: true, model: "claude-sonnet-4", messageCount: 1, todos: [] } });
    });
    act(() => {
      harness.injectEvent({
        type: "event",
        event: { type: "tool_execution_start", toolCallId: "tc-2", toolName: "bash", args: {} },
      });
    });
    act(() => {
      harness.injectEvent({
        type: "event",
        event: { type: "tool_execution_end", toolCallId: "tc-2", toolName: "bash", result: { toolCallId: "tc-2", content: "ok", isError: false } },
      });
    });
    expect(result.current.toolLabels.has("tc-2")).toBe(false);
    expect(result.current.lines.some(l => l.kind === "tool")).toBe(true);
  });

  it("7. submit with non-slash text sends prompt command when idle", () => {
    const result = render();
    act(() => { result.current.submit("run tests"); });

    const prompt = harness.getSent().find(s => s["type"] === "prompt");
    expect(prompt).toBeDefined();
    expect(prompt?.["message"]).toBe("run tests");
  });

  it("8. submit with non-slash text sends steer command when busy", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "state_update", state: { running: true, model: "claude-sonnet-4", messageCount: 1, todos: [] } });
    });
    act(() => { result.current.submit("actually do this instead"); });

    const steer = harness.getSent().find(s => s["type"] === "steer");
    expect(steer).toBeDefined();
    expect(steer?.["message"]).toBe("actually do this instead");
    expect(result.current.queuedSteer).toBe(true);
  });

  it("9. /clear command empties lines without sending to gateway", () => {
    const result = render();
    act(() => { result.current.submit("hello"); });
    expect(result.current.lines.length).toBeGreaterThan(0);

    const countBefore = harness.getSent().length;
    act(() => { result.current.submit("/clear"); });

    expect(result.current.lines).toHaveLength(0);
    // /clear is local — no extra command sent
    expect(harness.getSent().length).toBe(countBefore);
  });

  it("10. /model requests available models and opens model overlay on success", async () => {
    const result = render();

    act(() => { result.current.submit("/model"); });

    const req = harness.getSent().find(s => s["type"] === "get_available_models");
    expect(req).toBeDefined();

    await act(async () => {
      harness.resolveRequest(req!["id"] as string, [{ id: "claude-sonnet-4" }, { id: "claude-opus-4" }]);
      await Promise.resolve(); // flush promise microtasks
    });

    expect(result.current.overlay?.kind).toBe("model");
    expect(result.current.availableModels).toHaveLength(2);
  });

  it("11. abort sends abort command and appends stopped error line", () => {
    const result = render();
    act(() => { result.current.abort(); });

    expect(harness.getSent().some(s => s["type"] === "abort")).toBe(true);
    expect(result.current.lines.some(l => l.kind === "error" && l.text.includes("Stopped by user"))).toBe(true);
  });

  it("12. approveCommand sends approve and clears overlay", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "approval_request", command: "rm -rf /" });
    });
    expect(result.current.overlay?.kind).toBe("approval");

    act(() => { result.current.approveCommand(true); });

    const approveCmd = harness.getSent().find(s => s["type"] === "approve");
    expect(approveCmd?.["approved"]).toBe(true);
    expect(result.current.overlay).toBeNull();
    expect(result.current.pendingCommand).toBeNull();
  });

  it("13. busy→idle transition clears streaming and resets tool state", () => {
    const result = render();
    act(() => {
      harness.injectEvent({ type: "state_update", state: { running: true, model: "claude-sonnet-4", messageCount: 1, todos: [] } });
    });
    act(() => {
      harness.injectEvent({ type: "event", event: { type: "message_update", streamEvent: { type: "text_delta", delta: "Final answer." } } });
    });
    expect(result.current.streaming).toBe("Final answer.");

    act(() => {
      harness.injectEvent({ type: "state_update", state: { running: false, model: "claude-sonnet-4", messageCount: 2, todos: [] } });
    });
    expect(result.current.streaming).toBe("");
    expect(result.current.busy).toBe(false);
  });
});
