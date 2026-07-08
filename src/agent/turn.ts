import { readFile } from "node:fs/promises";
import type { DevinAssistantContentPart, DevinMessage, DevinProvider, DevinTool } from "widevin";

export type TurnOutcome =
  | { ok: true; messages: readonly DevinMessage[]; assistantText: string }
  | { ok: false; error: unknown };

const MAX_STEPS = 10;

const readFileTool: DevinTool = {
  name: "read_file",
  description: "Read the text content of a file on disk.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const TOOLS: readonly DevinTool[] = [readFileTool];

interface ToolResult {
  content: string;
  isError: boolean;
}

const extractPath = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
};

const runReadFileTool = async (args: unknown): Promise<ToolResult> => {
  const path = extractPath(args);
  if (path === undefined) {
    return { content: 'Error: read_file requires a string "path" argument', isError: true };
  }
  try {
    const content = await readFile(path, "utf-8");
    return { content, isError: false };
  } catch (error) {
    return { content: `Error reading ${path}: ${String(error)}`, isError: true };
  }
};

const runTool = async (name: string, args: unknown): Promise<ToolResult> => {
  if (name === "read_file") return runReadFileTool(args);
  return { content: `Error: unknown tool "${name}"`, isError: true };
};

export const runTurn = async (
  devin: DevinProvider,
  model: string,
  history: readonly DevinMessage[],
  userText: string,
  onDelta?: (delta: string) => void
): Promise<TurnOutcome> => {
  const messages: DevinMessage[] = [...history, { role: "user", content: userText }];
  const allTextParts: string[] = [];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const textParts: string[] = [];
      const toolCalls: { id: string; name: string; arguments: unknown }[] = [];
      const assistantParts: DevinAssistantContentPart[] = [];

      for await (const event of devin.streamChat({
        model,
        messages,
        tools: TOOLS,
        systemPrompt: ["You are Railgun, a helpful assistant with access to a read_file tool for reading files from disk."]
      })) {
        if (event.type === "text_delta") {
          textParts.push(event.delta);
          onDelta?.(event.delta);
        }
        if (event.type === "toolcall_end") {
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
          assistantParts.push({ type: "toolCall", id: event.id, name: event.name, arguments: event.arguments });
        }
      }

      if (textParts.length > 0) {
        assistantParts.unshift({ type: "text", text: textParts.join("") });
      }
      messages.push({ role: "assistant", content: assistantParts });

      if (toolCalls.length === 0) {
        return { ok: true, messages, assistantText: allTextParts.concat(textParts).join("") };
      }

      allTextParts.push(...textParts);
      for (const call of toolCalls) {
        const result = await runTool(call.name, call.arguments);
        messages.push({ role: "tool", toolCallId: call.id, content: result.content, isError: result.isError });
      }
    }
  } catch (error) {
    return { ok: false, error };
  }

  return { ok: true, messages, assistantText: "(stopped: too many steps)" };
};
