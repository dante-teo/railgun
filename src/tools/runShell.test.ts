import { describe, expect, it, vi } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./runShell.js";

describe("run_shell_command", () => {
  it("runs the command and returns its stdout when approved", async () => {
    const context: ToolContext = { confirmShellCommand: async () => true };

    const result = await registry.run("run_shell_command", { command: "echo railgun-test" }, context);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("railgun-test");
  });

  it("never invokes the command when approval is rejected", async () => {
    const context: ToolContext = { confirmShellCommand: async () => false };

    const result = await registry.run("run_shell_command", { command: "exit 1" }, context);

    expect(result).toEqual({ content: "Command not approved: exit 1", isError: true });
  });

  it("returns isError:true for a failing command even when approved", async () => {
    const context: ToolContext = { confirmShellCommand: async () => true };

    const result = await registry.run("run_shell_command", { command: "exit 1" }, context);

    expect(result.isError).toBe(true);
  });

  it("returns a fixed error and never calls confirmShellCommand when command is missing", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context: ToolContext = { confirmShellCommand };

    const result = await registry.run("run_shell_command", {}, context);

    expect(result).toEqual({
      content: 'Error: run_shell_command requires a string "command" argument',
      isError: true
    });
    expect(confirmShellCommand).not.toHaveBeenCalled();
  });
});
