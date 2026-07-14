export interface RpcTranscriptMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface RpcTranscriptPage {
  readonly sessionId: string;
  readonly messages: readonly RpcTranscriptMessage[];
  readonly nextCursor?: number;
}

export const RPC_TRANSCRIPT_PAGE_LIMIT = 100;
const RPC_TRANSCRIPT_DATA_BUDGET = 48 * 1024;
const RPC_TRANSCRIPT_TEXT_BUDGET = 24 * 1024;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const transcriptMessage = (message: unknown): RpcTranscriptMessage | undefined => {
  const item = record(message);
  if (item?.role !== "user" && item?.role !== "assistant") return undefined;
  const text = (typeof item.content === "string"
    ? item.content
    : Array.isArray(item.content)
      ? item.content.flatMap(part => {
        const content = record(part);
        return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
      }).join("")
      : "").trim();
  return text === "" ? undefined : { role: item.role, text };
};

const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes - 3) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}…`;
};

/** Projects provider history into a renderer-safe page that always fits a desktop RPC frame. */
export const createRpcTranscriptPage = (
  sessionId: string,
  history: readonly unknown[],
  cursor = 0,
  limit = RPC_TRANSCRIPT_PAGE_LIMIT,
): RpcTranscriptPage => {
  const messages: RpcTranscriptMessage[] = [];
  let next = cursor;
  while (next < history.length && messages.length < limit) {
    const projected = transcriptMessage(history[next]!);
    if (projected === undefined) {
      next += 1;
      continue;
    }
    const candidate = { ...projected, text: truncateUtf8(projected.text, RPC_TRANSCRIPT_TEXT_BUDGET) };
    const proposed = { sessionId, messages: [...messages, candidate], nextCursor: next + 1 };
    if (Buffer.byteLength(JSON.stringify(proposed), "utf8") > RPC_TRANSCRIPT_DATA_BUDGET && messages.length > 0) break;
    messages.push(candidate);
    next += 1;
  }
  return {
    sessionId,
    messages,
    ...(next < history.length ? { nextCursor: next } : {}),
  };
};
