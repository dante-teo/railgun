import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "./registry.js";
import type { ToolContext } from "./registry.js";

const noopContext: ToolContext = {
  confirmShellCommand: async () => {
    throw new Error("confirmShellCommand should not be called in these tests");
  }
};

describe("ToolRegistry", () => {
  it("getSchemas returns only schemas whose toolset is in the requested list", () => {
    const registry = createToolRegistry();
    registry.register({
      name: "file_tool",
      toolset: "file",
      schema: { name: "file_tool", description: "a file tool", inputSchema: {} },
      handler: async () => ({ content: "", isError: false })
    });
    registry.register({
      name: "terminal_tool",
      toolset: "terminal",
      schema: { name: "terminal_tool", description: "a terminal tool", inputSchema: {} },
      handler: async () => ({ content: "", isError: false })
    });

    const schemas = registry.getSchemas(["file"]);

    expect(schemas).toEqual([{ name: "file_tool", description: "a file tool", inputSchema: {} }]);
  });

  it("getSchemas excludes a tool whose isAvailable() returns false, and includes one whose isAvailable() returns true or is omitted", () => {
    const registry = createToolRegistry();
    registry.register({
      name: "unavailable_tool",
      toolset: "file",
      schema: { name: "unavailable_tool", description: "unavailable", inputSchema: {} },
      handler: async () => ({ content: "", isError: false }),
      isAvailable: () => false
    });
    registry.register({
      name: "available_tool",
      toolset: "file",
      schema: { name: "available_tool", description: "available", inputSchema: {} },
      handler: async () => ({ content: "", isError: false }),
      isAvailable: () => true
    });
    registry.register({
      name: "omitted_tool",
      toolset: "file",
      schema: { name: "omitted_tool", description: "omitted", inputSchema: {} },
      handler: async () => ({ content: "", isError: false })
    });

    const schemas = registry.getSchemas(["file"]);

    expect(schemas.map(s => s.name).sort()).toEqual(["available_tool", "omitted_tool"]);
  });

  it("run on an unregistered name returns an unknown-tool error without invoking any handler", async () => {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => ({ content: "should not run", isError: false }));
    registry.register({
      name: "some_tool",
      toolset: "file",
      schema: { name: "some_tool", description: "a tool", inputSchema: {} },
      handler
    });

    const result = await registry.run("x", {}, noopContext);

    expect(result).toEqual({ content: 'Error: unknown tool "x"', isError: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("run catches a handler that throws and returns a run-error result", async () => {
    const registry = createToolRegistry();
    registry.register({
      name: "throwing_tool",
      toolset: "file",
      schema: { name: "throwing_tool", description: "throws", inputSchema: {} },
      handler: async () => {
        throw new Error("boom");
      }
    });

    const result = await registry.run("throwing_tool", {}, noopContext);

    expect(result).toEqual({ content: "Error running throwing_tool: Error: boom", isError: true });
  });
});
