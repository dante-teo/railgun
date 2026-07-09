import type { DevinTool } from "widevin";

export interface ToolContext {
  confirmShellCommand: (command: string) => Promise<boolean>;
  todoStore?: {
    read(): unknown;
    write(input: { todos?: unknown; merge?: unknown }): unknown;
    formatForInjection(): string;
  };
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
  verb?: string;
  previewArgKey?: string;
}

export interface ToolRegistry {
  register(tool: RegisteredTool): void;
  getSchemas(enabledToolsets: readonly string[]): DevinTool[];
  get(name: string): RegisteredTool | undefined;
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

  const get = (name: string): RegisteredTool | undefined => tools.get(name);

  const run = async (name: string, args: unknown, context: ToolContext): Promise<ToolRunResult> => {
    const tool = tools.get(name);
    if (!tool) return { content: `Error: unknown tool "${name}"`, isError: true };
    try {
      return await tool.handler(args, context);
    } catch (err) {
      return { content: `Error running ${name}: ${String(err)}`, isError: true };
    }
  };

  return { register, getSchemas, get, run };
};

export const registry = createToolRegistry();
