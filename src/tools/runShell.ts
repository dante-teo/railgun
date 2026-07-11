import { spawn } from "node:child_process";
import { registry } from "./registry.js";
import type { ToolRunResult } from "./registry.js";

const extractCommand = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
};

const STOPPED_RESULT: ToolRunResult = { content: "[stopped by user]", isError: true };

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
  const child = spawn("bash", ["-c", command], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
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
    description: "Run a shell command and return its output. Requires human approval before running.",
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
    const approved = await awaitApproval(() => context.confirmShellCommand(command), context.signal);
    if (context.signal.aborted) return STOPPED_RESULT;
    if (!approved) return { content: `Command not approved: ${command}`, isError: true };
    context.checkpointGuard?.beforeMutation();
    return execShell(command, context.signal);
  }
});
