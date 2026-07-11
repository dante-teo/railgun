import type { DevinMessage, DevinProvider } from "widevin";

export const BRANCH_SUMMARIZATION_PROMPT =
  "Summarize this conversation branch concisely. Preserve key decisions, outcomes, and any important context. Be brief.";

const messageToText = (m: DevinMessage): string => {
  if (typeof m.content === "string") return `${m.role}: ${m.content}`;
  if (Array.isArray(m.content)) {
    const text = m.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join(" ");
    return `${m.role}: ${text}`;
  }
  return `${m.role}: ${JSON.stringify(m.content)}`;
};

export const summarizeMessages = async (
  messages: readonly DevinMessage[],
  devin: DevinProvider,
  model: string,
): Promise<string> => {
  if (messages.length === 0) return "";
  const flatText = messages.map(messageToText).join("\n");
  let summary = "";
  for await (const event of devin.streamChat({
    model,
    systemPrompt: [BRANCH_SUMMARIZATION_PROMPT],
    messages: [{ role: "user", content: flatText }],
  })) {
    if (event.type === "text_delta") summary += event.delta;
  }
  return summary;
};
