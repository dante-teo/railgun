import type { DevinTool } from "widevin";

export interface ToolContext {
  confirmShellCommand: (command: string) => Promise<boolean>;
}

export interface ToolRunResult {
  content: string;
  isError: boolean;
}

export interface RegisteredTool {
  name: string;
  toolset: string;
  schema: DevinTool;
  handler: (args: unknown, context: ToolContext) => Promise<ToolRunResult>;
  isAvailable?: () => boolean;
}

export interface ToolRegistry {
  register(tool: RegisteredTool): void;
  getSchemas(enabledToolsets: readonly string[]): DevinTool[];
  run(name: string, args: unknown, context: ToolContext): Promise<ToolRunResult>;
}

export const createToolRegistry = (): ToolRegistry => {
  const tools = new Map<string, RegisteredTool>();

  const register = (tool: RegisteredTool): void => {
    tools.set(tool.name, tool);
  };

  const getSchemas = (enabledToolsets: readonly string[]): DevinTool[] =>
    [...tools.values()]
      .filter(t => enabledToolsets.includes(t.toolset))
      .filter(t => (t.isAvailable ? t.isAvailable() : true))
      .map(t => t.schema);

  const run = async (name: string, args: unknown, context: ToolContext): Promise<ToolRunResult> => {
    const tool = tools.get(name);
    if (!tool) return { content: `Error: unknown tool "${name}"`, isError: true };
    try {
      return await tool.handler(args, context);
    } catch (err) {
      return { content: `Error running ${name}: ${String(err)}`, isError: true };
    }
  };

  return { register, getSchemas, run };
};

export const registry = createToolRegistry();
