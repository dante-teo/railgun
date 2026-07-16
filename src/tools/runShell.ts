import { spawn } from "node:child_process";
import { checkCommandApproval } from "../security/commandApproval.js";
import { smartApprove } from "../security/smartApproval.js";
import { registry } from "./registry.js";
import type { ToolRunResult } from "./registry.js";
import { runBoundedOperation } from "../asyncOperation.js";

const extractCommand = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
};

const STOPPED_RESULT: ToolRunResult = { content: "[stopped by user]", isError: true };
type ShellInvocation = Readonly<{ command: string; args: readonly string[] }>;

export const shellInvocation = (
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): ShellInvocation => {
  const shell = environment.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "bash");
  return { command: shell, args: ["-lc", command] };
};

const runShellBounded = (command: string, context: Parameters<typeof registry.run>[2]): Promise<ToolRunResult> =>
  runBoundedOperation(context.signal, context.operationTimeoutMs, `Tool "run_shell_command"`, signal => execShell(command, signal))
    .catch(error => context.signal.aborted ? STOPPED_RESULT : Promise.reject(error));

const awaitApproval = (
  confirm: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> => {
  if (signal.aborted) return Promise.resolve(false);
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  let settled = false;
  const settle = (complete: () => void): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    complete();
  };
  const onAbort = (): void => settle(() => resolve(false));
  signal.addEventListener("abort", onAbort, { once: true });
  void confirm().then(
    approved => settle(() => resolve(approved)),
    error => settle(() => reject(error)),
  );
  return promise;
};

const execShell = (command: string, signal: AbortSignal): Promise<ToolRunResult> => {
  const { promise, resolve } = Promise.withResolvers<ToolRunResult>();
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const invocation = shellInvocation(command);
  const child = spawn(invocation.command, [...invocation.args], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", error => finish(signal.aborted ? STOPPED_RESULT : { content: `Error: ${String(error)}`, isError: true }));
  child.on("close", code => finish(signal.aborted ? STOPPED_RESULT : code === 0
    ? { content: stdout, isError: false }
    : { content: `Error: ${stderr}`, isError: true }));
  const killGroup = (signalName: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signalName); } catch { /* already exited */ }
  };
  const onAbort = (): void => {
    killGroup("SIGTERM");
    killTimer = setTimeout(() => {
      killGroup("SIGKILL");
      finish(STOPPED_RESULT);
    }, 2_000);
    killTimer.unref();
  };
  const finish = (result: ToolRunResult): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    if (killTimer !== undefined) clearTimeout(killTimer);
    resolve(result);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return promise;
};

registry.register({
  name: "run_shell_command",
  toolset: "terminal",
  verb: "Running",
  previewArgKey: "command",
  schema: {
    name: "run_shell_command",
    description: "Run a shell command and return its output. Safe commands run immediately; dangerous commands require approval or are blocked.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    }
  },
  handler: async (args, context) => {
    const command = extractCommand(args);
    if (command === undefined) {
      return { content: 'Error: run_shell_command requires a string "command" argument', isError: true };
    }

    const requirement = checkCommandApproval(command, context.commandApprovalMode, context.sessionApprovals);

    if (requirement.kind === "forbidden") {
      return { content: requirement.reason, isError: true };
    }

    if (requirement.kind === "skip") {
      return runShellBounded(command, context);
    }

    // needs_approval
    if (context.commandApprovalMode === "smart" && context.devin !== undefined && context.reviewerModel !== undefined) {
      const verdict = await smartApprove(context.devin, context.reviewerModel, command, requirement.reason);
      if (verdict === "approve") {
        context.sessionApprovals.add(requirement.patternId);
        return runShellBounded(command, context);
      }
      if (verdict === "deny") {
        return { content: `Smart approval denied: ${requirement.reason}`, isError: true };
      }
      // escalate — fall through to human prompt
    }

    const approved = await awaitApproval(() => context.confirmShellCommand(command), context.signal);
    if (context.signal.aborted) return STOPPED_RESULT;
    if (!approved) return { content: `Command not approved: ${command}`, isError: true };
    context.sessionApprovals.add(requirement.patternId);
    return runShellBounded(command, context);
  }
});
