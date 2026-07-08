import { execFile } from "node:child_process";
import { registry } from "./registry.js";
import type { ToolRunResult } from "./registry.js";

const extractCommand = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
};

const execShell = (command: string): Promise<ToolRunResult> => {
  const { promise, resolve } = Promise.withResolvers<ToolRunResult>();
  execFile("bash", ["-c", command], (err, stdout, stderr) => {
    resolve(err ? { content: `Error: ${stderr}`, isError: true } : { content: stdout, isError: false });
  });
  return promise;
};

registry.register({
  name: "run_shell_command",
  toolset: "terminal",
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
    const approved = await context.confirmShellCommand(command);
    if (!approved) return { content: `Command not approved: ${command}`, isError: true };
    return execShell(command);
  }
});
