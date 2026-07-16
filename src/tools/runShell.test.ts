import { describe, expect, it, vi } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { shellInvocation } from "./runShell.js";

const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  commandApprovalMode: "manual",
  sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => true,
  ...overrides,
});

describe("run_shell_command", () => {
  it("runs commands through the user's login shell without interactive aliases or functions", () => {
    expect(shellInvocation("copilot", { SHELL: "/bin/zsh" })).toEqual({
      command: "/bin/zsh",
      args: ["-lc", "copilot"],
    });
  });

  it("uses macOS's default login shell when the app has no SHELL", () => {
    expect(shellInvocation("copilot", {}, "darwin")).toEqual({
      command: "/bin/zsh",
      args: ["-lc", "copilot"],
    });
  });

  it("runs a safe command and returns its stdout without asking for approval", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context = makeContext({ confirmShellCommand });

    const result = await registry.run("run_shell_command", { command: "echo railgun-test" }, context);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("railgun-test");
    expect(confirmShellCommand).not.toHaveBeenCalled();
  });

  it("never invokes the command when approval is rejected", async () => {
    // sudo is a dangerous pattern — triggers manual approval
    const context = makeContext({ confirmShellCommand: async () => false });

    const result = await registry.run("run_shell_command", { command: "sudo echo hi" }, context);

    expect(result).toEqual({ content: "Command not approved: sudo echo hi", isError: true });
  });

  it("returns isError:true for a failing command even when it runs", async () => {
    const context = makeContext();

    const result = await registry.run("run_shell_command", { command: "exit 1" }, context);

    expect(result.isError).toBe(true);
  });

  it("returns a fixed error and never calls confirmShellCommand when command is missing", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context = makeContext({ confirmShellCommand });

    const result = await registry.run("run_shell_command", {}, context);

    expect(result).toEqual({
      content: 'Error: run_shell_command requires a string "command" argument',
      isError: true
    });
    expect(confirmShellCommand).not.toHaveBeenCalled();
  });

  it("returns a stopped result when aborted during approval of a dangerous command", async () => {
    const controller = new AbortController();
    const approval = Promise.withResolvers<boolean>();
    // sudo is dangerous → goes through manual approval path
    const resultPromise = registry.run("run_shell_command", { command: "sudo echo never" }, makeContext({
      signal: controller.signal,
      confirmShellCommand: () => approval.promise,
    }));

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ content: "[stopped by user]", isError: true });
  });

  it("preserves an approval failure as a tool execution error", async () => {
    // sudo is dangerous → goes through approval → throws
    const result = await registry.run("run_shell_command", { command: "sudo echo never" }, makeContext({
      confirmShellCommand: async () => { throw new Error("approval unavailable"); },
    }));

    expect(result).toEqual({
      content: "Error running run_shell_command: Error: approval unavailable",
      isError: true,
    });
  });

  it("terminates an active shell process on abort", async () => {
    // sleep 30 is safe → spawned immediately, no approval step.
    // spawn is synchronous, so the process is running before controller.abort() below.
    const controller = new AbortController();
    const resultPromise = registry.run("run_shell_command", { command: "sleep 30" }, makeContext({
      signal: controller.signal,
    }));

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ content: "[stopped by user]", isError: true });
  });

  // --- Approval gate tests ---

  it("rm -rf / is forbidden regardless of approval mode", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context = makeContext({ commandApprovalMode: "off", confirmShellCommand });

    const result = await registry.run("run_shell_command", { command: "rm -rf /" }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/blocked|forbidden|not permitted/i);
    expect(confirmShellCommand).not.toHaveBeenCalled();
  });

  it("safe command ls runs without asking for approval in manual mode", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context = makeContext({ commandApprovalMode: "manual", confirmShellCommand });

    const result = await registry.run("run_shell_command", { command: "echo safe" }, context);

    expect(result.isError).toBe(false);
    expect(confirmShellCommand).not.toHaveBeenCalled();
  });

  it("dangerous command asks for approval in manual mode", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context = makeContext({ commandApprovalMode: "manual", confirmShellCommand });

    await registry.run("run_shell_command", { command: "sudo echo hi" }, context);

    expect(confirmShellCommand).toHaveBeenCalledWith("sudo echo hi");
  });

  it("dangerous command skips approval gate in off mode (no confirmation prompt)", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context = makeContext({ commandApprovalMode: "off", confirmShellCommand });

    // git push --force is a dangerous pattern; in off mode the gate lets it through.
    // It will fail at execution (no remote), but the gate itself does not block it.
    await registry.run("run_shell_command", { command: "git push origin HEAD --force" }, context);

    expect(confirmShellCommand).not.toHaveBeenCalled();
  });

  it("session-approved pattern skips re-approval", async () => {
    const confirmShellCommand = vi.fn(async () => true);
    const context = makeContext({
      commandApprovalMode: "manual",
      sessionApprovals: new Set(["rm_recursive"]),
      confirmShellCommand,
    });

    await registry.run("run_shell_command", { command: "rm -rf ./foo" }, context);

    expect(confirmShellCommand).not.toHaveBeenCalled();
  });

  it("human approval adds the pattern to sessionApprovals", async () => {
    const sessionApprovals = new Set<string>();
    const context = makeContext({
      commandApprovalMode: "manual",
      sessionApprovals,
      confirmShellCommand: async () => true,
    });

    await registry.run("run_shell_command", { command: "sudo ls" }, context);

    expect(sessionApprovals.has("sudo")).toBe(true);
  });
});
