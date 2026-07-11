import { DevinApiError } from "widevin";
import type { DevinMessage, DevinProvider } from "widevin";

export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const AUTO_COMPACT_THRESHOLD_RATIO = 0.9;
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACTION_ACK_MESSAGE = "Compacted conversation history to stay under the context limit.";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

const CHARS_PER_TOKEN = 4;

export const approxTokenCount = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export const shouldCompact = (usage: UsageTotals | undefined, contextWindow: number): boolean =>
  usage !== undefined && usage.inputTokens + usage.outputTokens >= Math.floor(contextWindow * AUTO_COMPACT_THRESHOLD_RATIO);

export const isSummaryMessage = (text: string): boolean => text.startsWith(`${SUMMARY_PREFIX}\n`);

export const extractUserText = (message: DevinMessage): string | null => {
  if (message.role !== "user") return null;
  return typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("");
};

export const truncateMiddleTokens = (text: string, maxTokens: number): string => {
  if (approxTokenCount(text) <= maxTokens) return text;
  const prefixChars = Math.floor(maxTokens / 2) * CHARS_PER_TOKEN;
  const suffixChars = Math.max(0, maxTokens * CHARS_PER_TOKEN - prefixChars);
  const prefix = text.slice(0, prefixChars);
  const suffix = suffixChars > 0 ? text.slice(text.length - suffixChars) : "";
  const removedTokens = approxTokenCount(text) - maxTokens;
  return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
};

export const selectRecentUserTexts = (messages: readonly DevinMessage[], maxTokens: number): string[] => {
  const userTexts = messages
    .map(extractUserText)
    .filter((text): text is string => text !== null && !isSummaryMessage(text));

  const selected: string[] = [];
  let remaining = maxTokens;
  for (let i = userTexts.length - 1; i >= 0; i--) {
    if (remaining === 0) break;
    const text = userTexts[i];
    if (text === undefined) continue;
    const tokens = approxTokenCount(text);
    if (tokens <= remaining) {
      selected.push(text);
      remaining -= tokens;
    } else {
      selected.push(truncateMiddleTokens(text, remaining));
      break;
    }
  }
  selected.reverse();
  return selected;
};

export const buildCompactedMessage = (selectedTexts: readonly string[], summaryText: string): DevinMessage => {
  const joinedUserTexts = selectedTexts.join("\n\n---\n\n");
  const summaryBody = summaryText || "(no summary available)";
  const summaryBlock = `${SUMMARY_PREFIX}\n${summaryBody}`;
  const content = joinedUserTexts.length > 0 ? `${joinedUserTexts}\n\n${summaryBlock}` : summaryBlock;
  return { role: "user", content };
};

const isDevinApiError413 = (error: unknown): error is DevinApiError =>
  error instanceof DevinApiError && error.status === 413;

export const runCompaction = async (
  devin: DevinProvider,
  model: string,
  systemPrompt: readonly string[],
  messages: readonly DevinMessage[],
  signal?: AbortSignal,
): Promise<{ messages: readonly DevinMessage[]; usage: UsageTotals | undefined }> => {
  let requestMessages: DevinMessage[] = [...messages, { role: "user", content: SUMMARIZATION_PROMPT }];
  let summaryText = "";
  let lastUsage: UsageTotals | undefined;

  for (;;) {
    summaryText = "";
    try {
      for await (const event of devin.streamChat({
        model, messages: requestMessages, systemPrompt,
        ...(signal ? { signal } : {}),
      })) {
        if (event.type === "text_delta") summaryText += event.delta;
        if (event.type === "usage") lastUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      }
      break;
    } catch (error) {
      if (isDevinApiError413(error) && requestMessages.length > 1) {
        requestMessages = requestMessages.slice(1);
        continue;
      }
      throw error;
    }
  }

  const selectedTexts = selectRecentUserTexts(messages, COMPACT_USER_MESSAGE_MAX_TOKENS);
  const compactedMessage = buildCompactedMessage(selectedTexts, summaryText);
  return { messages: [compactedMessage], usage: lastUsage };
};
