import type { DevinAssistantContentPart, DevinContentPart, DevinMessage, DevinProvider } from "widevin";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelSlot {
  readonly model: string;
  readonly temperature?: number;
}

export interface MoAPreset {
  readonly name: string;
  readonly referenceModels: readonly ModelSlot[];
  readonly aggregator: ModelSlot;
  readonly referenceMaxTokens?: number;
}

// ---------------------------------------------------------------------------
// Reference system prompt
// ---------------------------------------------------------------------------

export const REFERENCE_SYSTEM_PROMPT =
  "You are an advisory model in a Mixture of Agents setup. " +
  "Your role is to analyse the conversation and provide high-quality, " +
  "thoughtful guidance to the acting aggregator model. " +
  "You CANNOT call tools and you will NOT interact with the user directly. " +
  "Focus on: what is happening in the conversation, what the best next step " +
  "is, any risks or mistakes you notice, and how the acting model should " +
  "proceed. Be concise and direct.";

// ---------------------------------------------------------------------------
// Tool result truncation
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_RESULT_BUDGET = 4000;

export const truncateToolResult = (text: string, budget = DEFAULT_TOOL_RESULT_BUDGET): string => {
  if (text.length <= budget) return text;
  const half = Math.floor(budget / 2);
  const omitted = text.length - budget;
  return `${text.slice(0, half)}\n[... ${omitted} chars omitted ...]\n${text.slice(text.length - half)}`;
};

// ---------------------------------------------------------------------------
// Message building for reference models
// ---------------------------------------------------------------------------

const extractTextFromContent = (content: string | readonly DevinContentPart[]): string => {
  if (typeof content === "string") return content;
  return content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
};

const extractAssistantText = (content: readonly DevinAssistantContentPart[]): string => {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "thinking") {
      parts.push(part.thinking);
    } else if (part.type === "toolCall") {
      const args = part.arguments !== undefined ? JSON.stringify(part.arguments) : "{}";
      parts.push(`[called tool: ${part.name}(${args})]`);
    }
  }
  return parts.join("\n").trim();
};

const ADVISORY_PROMPT =
  "[The conversation above is the current state of the task. Give your most " +
  "intelligent judgement: what is going on, what should happen next, what " +
  "risks or mistakes you see, and how the acting agent should proceed.]";

export const buildReferenceMessages = (messages: readonly DevinMessage[]): DevinMessage[] => {
  if (messages.length === 0) return [{ role: "user", content: ADVISORY_PROMPT }];

  const result: DevinMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "developer") {
      const text = extractTextFromContent(msg.content);
      result.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const text = extractAssistantText(msg.content);
      if (text !== "") result.push({ role: "assistant", content: [{ type: "text", text }] });
    } else if (msg.role === "tool") {
      const rawText = extractTextFromContent(msg.content);
      const text = truncateToolResult(rawText);
      const toolNote = `[tool result: ${text}]`;

      const last = result.at(-1);
      if (last !== undefined && last.role === "assistant") {
        const prevText = last.content.flatMap(p => p.type === "text" ? [p.text] : []).join("");
        result[result.length - 1] = {
          role: "assistant",
          content: [{ type: "text", text: `${prevText}\n${toolNote}` }],
        };
      } else {
        result.push({ role: "assistant", content: [{ type: "text", text: toolNote }] });
      }
    }
    // skip any other roles
  }

  if (result.length === 0) {
    // find last user text as fallback
    type UserMessage = DevinMessage & { role: "user" | "developer" };
    const isUserMsg = (m: DevinMessage): m is UserMessage => m.role === "user" || m.role === "developer";
    const lastUser = [...messages].reverse().find(isUserMsg);
    const fallbackText =
      lastUser !== undefined ? extractTextFromContent(lastUser.content) : ADVISORY_PROMPT;
    return [{ role: "user", content: fallbackText }];
  }

  // if ending on an assistant message, append synthetic user advisory
  const last = result.at(-1);
  if (last !== undefined && last.role === "assistant") {
    result.push({ role: "user", content: ADVISORY_PROMPT });
  }

  return result;
};

// ---------------------------------------------------------------------------
// Reference execution
// ---------------------------------------------------------------------------

export const runOneReference = async (
  devin: DevinProvider,
  slot: ModelSlot,
  refMessages: readonly DevinMessage[],
  maxTokens: number | undefined,
  signal: AbortSignal,
): Promise<{ label: string; text: string }> => {
  const label = slot.model;
  try {
    const stream = devin.streamChat({
      model: slot.model,
      messages: refMessages,
      systemPrompt: [REFERENCE_SYSTEM_PROMPT],
      ...(slot.temperature !== undefined ? { temperature: slot.temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal,
    });

    const charBudget = maxTokens !== undefined ? maxTokens * 4 : undefined;
    let collected = "";

    for await (const event of stream) {
      if (event.type === "text_delta") {
        collected += event.delta;
        if (charBudget !== undefined && collected.length >= charBudget) break;
      }
    }

    return { label, text: collected };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { label, text: `[failed: ${message}]` };
  }
};

export interface ReferenceCallbacks {
  onStart: (index: number, count: number, model: string) => Promise<void>;
  onEnd: (index: number, model: string, text: string) => Promise<void>;
}

export const runReferences = async (
  devin: DevinProvider,
  preset: MoAPreset,
  messages: readonly DevinMessage[],
  signal: AbortSignal,
  callbacks?: ReferenceCallbacks,
): Promise<readonly { label: string; text: string }[]> => {
  const refMessages = buildReferenceMessages(messages);
  const count = preset.referenceModels.length;
  return Promise.all(
    preset.referenceModels.map(async (slot, index) => {
      await callbacks?.onStart(index, count, slot.model);
      const result = await runOneReference(devin, slot, refMessages, preset.referenceMaxTokens, signal);
      await callbacks?.onEnd(index, result.label, result.text);
      return result;
    })
  );
};

// ---------------------------------------------------------------------------
// Aggregator guidance
// ---------------------------------------------------------------------------

export const buildAggregatorGuidance = (
  referenceResults: readonly { label: string; text: string }[],
): string => {
  const labels = referenceResults.map(r => r.label).join(", ");
  const blocks = referenceResults
    .map((r, i) => `Reference ${i + 1} (${r.label}):\n${r.text}`)
    .join("\n\n");

  return (
    `[Mixture of Agents reference context — private, not from the real user]\n` +
    `References: ${labels}\n\n` +
    `Use the reference responses below as private advisory context. You are the aggregator and the ONLY acting model here: answer the user directly or call tools as needed.\n\n` +
    blocks
  );
};

export const injectMoAGuidance = (
  messages: readonly DevinMessage[],
  guidance: string,
): DevinMessage[] => [...messages, { role: "user", content: guidance }];
