import type { DevinMessage } from "widevin";
import type { AdviceSeverity } from "./advisoryContext.js";

export interface ParsedAdvisory {
  readonly severity: AdviceSeverity;
  readonly text: string;
}

const ADVISORY_PATTERN = /^\s*<advisory\b[^>]*\bseverity=["'](nit|concern|blocker)["'][^>]*>([\s\S]*?)<\/advisory>\s*$/i;

const decodeXmlText = (text: string): string => text
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
  .replaceAll("&apos;", "'").replaceAll("&amp;", "&");

export const parseAdvisoryMessage = (text: string): ParsedAdvisory | null => {
  const match = text.match(ADVISORY_PATTERN);
  return match ? { severity: match[1]!.toLowerCase() as AdviceSeverity, text: decodeXmlText(match[2]!).trim() } : null;
};

const isAdvisory = (message: DevinMessage): boolean =>
  message.role === "user" && typeof message.content === "string" && parseAdvisoryMessage(message.content) !== null;

const mergeAssistantMessages = (
  previous: Extract<DevinMessage, { role: "assistant" }>,
  current: Extract<DevinMessage, { role: "assistant" }>,
): DevinMessage => ({ role: "assistant", content: [...previous.content, ...current.content] });

export const normalizeAdvisoryHistory = (messages: readonly DevinMessage[]): readonly DevinMessage[] =>
  messages.reduce<readonly DevinMessage[]>((normalized, message) => {
    if (isAdvisory(message)) return normalized;
    const previous = normalized.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      return [...normalized.slice(0, -1), mergeAssistantMessages(previous, message)];
    }
    return [...normalized, message];
  }, []);
