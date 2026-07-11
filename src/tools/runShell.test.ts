import { describe, expect, it, vi } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./runShell.js";

describe("run_shell_command", () => {
  it("runs the command and returns its stdout when approved", async () => {
    const context: ToolContext = { signal: new AbortController().signal, confirmShellCommand: async () => true };

    const result = await registry.run("run_shell_command", { command: "echo railgun-test" }, context);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("railgun-test");
  });

  it("never invokes the command when approval is rejected", async () => {
    const context: ToolContext = { signal: new AbortController().signal, confirmShellCommand: async () => false };

    const result = await registry.run("run_shell_command", { command: "exit 1" }, context);

    expect(result).toEqual({ content: "Command not approved: exit 1", isError: true });
  });

  it("returns isError:true for a failing command even when approved", async () => {
    const context: ToolContext = { signal: new AbortController().signal, confirmShellCommand: async () => true };

    const result = await registry.run("run_shell_command", { command: "exit 1" }, context);

    expect(result.isError).toBe(true);
  });

  it("returns a fixed error and never calls confirmShellCommand when command is missing", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context: ToolContext = { signal: new AbortController().signal, confirmShellCommand };

    const result = await registry.run("run_shell_command", {}, context);

    expect(result).toEqual({
      content: 'Error: run_shell_command requires a string "command" argument',
      isError: true
    });
    expect(confirmShellCommand).not.toHaveBeenCalled();
  });

  it("returns a stopped result when aborted during approval", async () => {
    const controller = new AbortController();
    const approval = Promise.withResolvers<boolean>();
    const resultPromise = registry.run("run_shell_command", { command: "echo never" }, {
      signal: controller.signal,
      confirmShellCommand: () => approval.promise,
    });

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ content: "[stopped by user]", isError: true });
  });

  it("preserves an approval failure as a tool execution error", async () => {
    const result = await registry.run("run_shell_command", { command: "echo never" }, {
      signal: new AbortController().signal,
      confirmShellCommand: async () => { throw new Error("approval unavailable"); },
    });

    expect(result).toEqual({
      content: "Error running run_shell_command: Error: approval unavailable",
      isError: true,
    });
  });

  it("terminates an active shell process on abort", async () => {
    const controller = new AbortController();
    const resultPromise = registry.run("run_shell_command", { command: "sleep 30" }, {
      signal: controller.signal,
      confirmShellCommand: async () => true,
    });
    await new Promise(resolve => setTimeout(resolve, 25));

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ content: "[stopped by user]", isError: true });
  });
});
