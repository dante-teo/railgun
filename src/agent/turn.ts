import type { DevinAssistantContentPart, DevinMessage, DevinProvider } from "widevin";
import { registry } from "../tools/index.js";
import type { ToolContext } from "../tools/index.js";

export type TurnOutcome =
  | { ok: true; messages: readonly DevinMessage[]; assistantText: string }
  | { ok: false; error: unknown };

const MAX_STEPS = 10;
const ENABLED_TOOLSETS = ["file", "terminal"] as const;

export const runTurn = async (
  devin: DevinProvider,
  model: string,
  history: readonly DevinMessage[],
  userText: string,
  confirmShellCommand: (command: string) => Promise<boolean>,
  onDelta?: (delta: string) => void
): Promise<TurnOutcome> => {
  const messages: DevinMessage[] = [...history, { role: "user", content: userText }];
  const allTextParts: string[] = [];
  const context: ToolContext = { confirmShellCommand };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const textParts: string[] = [];
      const toolCalls: { id: string; name: string; arguments: unknown }[] = [];
      const assistantParts: DevinAssistantContentPart[] = [];

      for await (const event of devin.streamChat({
        model,
        messages,
        tools: registry.getSchemas(ENABLED_TOOLSETS),
        systemPrompt: [
          "You are Railgun, a helpful assistant with access to tools for reading and writing files, listing directories, and running shell commands."
        ]
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
        const result = await registry.run(call.name, call.arguments, context);
        messages.push({ role: "tool", toolCallId: call.id, content: result.content, isError: result.isError });
      }
    }
  } catch (error) {
    return { ok: false, error };
  }

  return { ok: true, messages, assistantText: "(stopped: too many steps)" };
};
