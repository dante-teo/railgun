import { describe, expect, it, vi } from "vitest";
import { createExtensionRunner } from "./runner.js";
import type { ExtensionError, ToolCallEvent, ToolResultEvent, InputEvent, SessionStartEvent, SessionShutdownEvent } from "./types.js";

const toolCallEvent = (overrides?: Partial<ToolCallEvent>): ToolCallEvent => ({
  type: "tool_call",
  toolCallId: "call-1",
  toolName: "test_tool",
  input: {},
  ...overrides,
});

const toolResultEvent = (overrides?: Partial<ToolResultEvent>): ToolResultEvent => ({
  type: "tool_result",
  toolCallId: "call-1",
  toolName: "test_tool",
  input: {},
  content: "original content",
  isError: false,
  durationMs: 42,
  ...overrides,
});

const inputEvent = (text = "hello"): InputEvent => ({
  type: "input",
  text,
  source: "cli",
});

describe("ExtensionRunner", () => {
  describe("emitToolCall", () => {
    it("returns empty result when no handlers are registered", async () => {
      const runner = createExtensionRunner();
      const result = await runner.emitToolCall(toolCallEvent());
      expect(result).toEqual({});
    });

    it("returns { block: true, reason } when a handler blocks", async () => {
      const runner = createExtensionRunner();
      runner.on("tool_call", () => ({ block: true as const, reason: "no shell" }), "test");
      const result = await runner.emitToolCall(toolCallEvent());
      expect(result).toEqual({ block: true, reason: "no shell" });
    });

    it("stops at the first blocker — second handler not called", async () => {
      const runner = createExtensionRunner();
      const second = vi.fn();
      runner.on("tool_call", () => ({ block: true as const, reason: "blocked" }), "ext1");
      runner.on("tool_call", second, "ext2");
      await runner.emitToolCall(toolCallEvent());
      expect(second).not.toHaveBeenCalled();
    });

    it("does NOT catch handler throws — error propagates", async () => {
      const runner = createExtensionRunner();
      runner.on("tool_call", () => { throw new Error("boom"); }, "ext1");
      await expect(runner.emitToolCall(toolCallEvent())).rejects.toThrow("boom");
    });

    it("continues past non-blocking handler and returns empty", async () => {
      const runner = createExtensionRunner();
      runner.on("tool_call", () => { /* no return */ }, "ext1");
      const result = await runner.emitToolCall(toolCallEvent());
      expect(result).toEqual({});
    });
  });

  describe("emitToolResult", () => {
    it("returns empty overrides when no handlers registered", async () => {
      const runner = createExtensionRunner();
      const result = await runner.emitToolResult(toolResultEvent());
      expect(result).toEqual({});
    });

    it("merges content override from handler", async () => {
      const runner = createExtensionRunner();
      runner.on("tool_result", () => ({ content: "overridden" }), "ext1");
      const result = await runner.emitToolResult(toolResultEvent());
      expect(result.content).toBe("overridden");
    });

    it("merges isError override from handler", async () => {
      const runner = createExtensionRunner();
      runner.on("tool_result", () => ({ isError: true }), "ext1");
      const result = await runner.emitToolResult(toolResultEvent({ isError: false }));
      expect(result.isError).toBe(true);
    });

    it("catches handler throws, reports via onExtensionError, and continues", async () => {
      const runner = createExtensionRunner();
      const errors: ExtensionError[] = [];
      runner.onExtensionError(err => errors.push(err));
      const second = vi.fn(() => ({ content: "second ran" }));
      runner.on("tool_result", () => { throw new Error("handler failed"); }, "ext1");
      runner.on("tool_result", second, "ext2");
      const result = await runner.emitToolResult(toolResultEvent());
      expect(errors).toHaveLength(1);
      expect(errors[0]?.extension).toBe("ext1");
      expect(errors[0]?.event).toBe("tool_result");
      expect(second).toHaveBeenCalled();
      expect(result.content).toBe("second ran");
    });

    it("accumulates overrides from multiple handlers", async () => {
      const runner = createExtensionRunner();
      runner.on("tool_result", () => ({ content: "new content" }), "ext1");
      runner.on("tool_result", () => ({ isError: true }), "ext2");
      const result = await runner.emitToolResult(toolResultEvent());
      expect(result.content).toBe("new content");
      expect(result.isError).toBe(true);
    });
  });

  describe("emitInput", () => {
    it("returns action:continue unchanged when no handlers registered", async () => {
      const runner = createExtensionRunner();
      const result = await runner.emitInput(inputEvent("hi"));
      expect(result.action).toBe("continue");
      expect(result.text).toBe("hi");
    });

    it("transforms text when action is transform", async () => {
      const runner = createExtensionRunner();
      runner.on("input", () => ({ action: "transform", text: "transformed" }), "ext1");
      const result = await runner.emitInput(inputEvent("original"));
      expect(result.action).toBe("continue");
      expect(result.text).toBe("transformed");
    });

    it("short-circuits when action is handled", async () => {
      const runner = createExtensionRunner();
      const second = vi.fn();
      runner.on("input", () => ({ action: "handled" }), "ext1");
      runner.on("input", second, "ext2");
      const result = await runner.emitInput(inputEvent("hi"));
      expect(result.action).toBe("handled");
      expect(second).not.toHaveBeenCalled();
    });

    it("catches handler throws, reports error, and returns action:continue", async () => {
      const runner = createExtensionRunner();
      const errors: ExtensionError[] = [];
      runner.onExtensionError(err => errors.push(err));
      runner.on("input", () => { throw new Error("input fail"); }, "ext1");
      const result = await runner.emitInput(inputEvent("hi"));
      expect(result.action).toBe("continue");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toBe("input");
    });

    it("applies transform from first handler before passing to second", async () => {
      const runner = createExtensionRunner();
      runner.on("input", event => ({ action: "transform", text: event.text + " first" }), "ext1");
      runner.on("input", event => ({ action: "transform", text: event.text + " second" }), "ext2");
      const result = await runner.emitInput(inputEvent("original"));
      expect(result.text).toBe("original first second");
    });
  });

  describe("emitSessionStart / emitSessionShutdown", () => {
    it("calls all handlers on session_start", async () => {
      const runner = createExtensionRunner();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      runner.on("session_start", handler1, "ext1");
      runner.on("session_start", handler2, "ext2");
      const event: SessionStartEvent = { type: "session_start", reason: "new" };
      await runner.emitSessionStart(event);
      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).toHaveBeenCalledWith(event);
    });

    it("catches session_start handler throws without propagating", async () => {
      const runner = createExtensionRunner();
      const errors: ExtensionError[] = [];
      runner.onExtensionError(err => errors.push(err));
      runner.on("session_start", () => { throw new Error("start fail"); }, "ext1");
      await expect(runner.emitSessionStart({ type: "session_start", reason: "new" })).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
    });

    it("calls all handlers on session_shutdown", async () => {
      const runner = createExtensionRunner();
      const handler = vi.fn();
      runner.on("session_shutdown", handler, "ext1");
      const event: SessionShutdownEvent = { type: "session_shutdown", reason: "exit" };
      await runner.emitSessionShutdown(event);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it("catches session_shutdown handler throws without propagating", async () => {
      const runner = createExtensionRunner();
      const errors: ExtensionError[] = [];
      runner.onExtensionError(err => errors.push(err));
      runner.on("session_shutdown", () => { throw new Error("shutdown fail"); }, "ext1");
      await expect(runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" })).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
    });
  });

  describe("registerTool / getTools", () => {
    it("adds tool to getTools() list", () => {
      const runner = createExtensionRunner();
      const tool = {
        name: "my_tool",
        description: "does a thing",
        inputSchema: {},
        execute: async () => ({ content: "ok" }),
      };
      runner.registerTool(tool);
      expect(runner.getTools()).toHaveLength(1);
      expect(runner.getTools()[0]?.name).toBe("my_tool");
    });

    it("returns a copy of the tools array", () => {
      const runner = createExtensionRunner();
      runner.registerTool({ name: "t", description: "", inputSchema: {}, execute: async () => ({ content: "" }) });
      const tools1 = runner.getTools();
      const tools2 = runner.getTools();
      expect(tools1).not.toBe(tools2);
      expect(tools1).toEqual(tools2);
    });
  });
});
