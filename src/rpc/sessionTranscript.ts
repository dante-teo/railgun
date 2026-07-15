export interface RpcTranscriptMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly messageId?: number;
  readonly branchable?: true;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface RpcTranscriptTool {
  readonly role: "tool";
  readonly id: string;
  readonly name: string;
  readonly failed: boolean;
}

export type RpcTranscriptEntry = RpcTranscriptMessage | RpcTranscriptTool;

export interface RpcTranscriptPage {
  readonly sessionId: string;
  readonly messages: readonly RpcTranscriptEntry[];
  readonly nextCursor?: number;
}

export const RPC_TRANSCRIPT_PAGE_LIMIT = 100;
const RPC_TRANSCRIPT_DATA_BUDGET = 48 * 1024;
const RPC_TRANSCRIPT_TEXT_BUDGET = 24 * 1024;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const transcriptText = (item: Record<string, unknown>): string => (typeof item.content === "string"
  ? item.content
  : Array.isArray(item.content)
    ? item.content.flatMap(part => {
      const content = record(part);
      return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
    }).join("")
    : "").trim();

const transcriptMessage = (message: unknown): RpcTranscriptMessage | undefined => {
  const item = record(message);
  if (item?.role !== "user" && item?.role !== "assistant") return undefined;
  const text = transcriptText(item);
  if (text === "") return undefined;
  const hasToolCalls = item.role === "assistant" && Array.isArray(item.content) && item.content.some(part => record(part)?.type === "toolCall");
  const at = typeof item.at === "number" && Number.isInteger(item.at) && item.at >= 0 && item.at <= Number.MAX_SAFE_INTEGER ? item.at : undefined;
  return {
    role: item.role,
    text,
    ...(item.role === "assistant" && !hasToolCalls ? { branchable: true as const } : {}),
    ...(at === undefined ? {} : item.role === "user" ? { startedAt: at } : { completedAt: at }),
  };
};

const toolFailureByCallId = (history: readonly unknown[]): ReadonlyMap<string, boolean> => {
  const failures = new Map<string, boolean>();
  for (const message of history) {
    const item = record(message);
    if (item?.role === "tool" && typeof item.toolCallId === "string") failures.set(item.toolCallId, item.isError === true);
  }
  return failures;
};

const transcriptTools = (
  message: unknown,
  historyIndex: number,
  failures: ReadonlyMap<string, boolean>,
): readonly RpcTranscriptTool[] => {
  const item = record(message);
  if (item?.role !== "assistant" || !Array.isArray(item.content)) return [];
  return item.content.flatMap((part, partIndex) => {
    const call = record(part);
    if (call?.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string" || call.name.trim() === "") return [];
    return [{
      role: "tool" as const,
      id: `restored-tool-${String(historyIndex)}-${String(partIndex)}`,
      name: truncateUtf8(call.name.trim(), 128),
      failed: failures.get(call.id) === true,
    }];
  });
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

const transcriptEntries = (
  history: readonly unknown[],
  messageIds: readonly number[] | undefined,
): readonly RpcTranscriptEntry[] => {
  const failures = toolFailureByCallId(history);
  return history.flatMap((source, historyIndex) => {
    const message = transcriptMessage(source);
    const messageId = messageIds?.[historyIndex];
    const textEntry = message === undefined ? [] : [{
      role: message.role,
      text: truncateUtf8(message.text, RPC_TRANSCRIPT_TEXT_BUDGET),
      ...(messageId === undefined ? {} : { messageId }),
      ...(messageId !== undefined && message.branchable ? { branchable: true as const } : {}),
      ...(message.startedAt === undefined ? {} : { startedAt: message.startedAt }),
      ...(message.completedAt === undefined ? {} : { completedAt: message.completedAt }),
    }];
    return [...textEntry, ...transcriptTools(source, historyIndex, failures)];
  });
};

/** Projects provider history into a renderer-safe page that always fits a desktop RPC frame. */
export const createRpcTranscriptPage = (
  sessionId: string,
  history: readonly unknown[],
  cursor = 0,
  limit = RPC_TRANSCRIPT_PAGE_LIMIT,
  messageIds?: readonly number[],
): RpcTranscriptPage => {
  const messages: RpcTranscriptEntry[] = [];
  const entries = transcriptEntries(history, messageIds);
  let next = cursor;
  while (next < entries.length && messages.length < limit) {
    const candidate = entries[next]!;
    const proposed = { sessionId, messages: [...messages, candidate], nextCursor: next + 1 };
    if (Buffer.byteLength(JSON.stringify(proposed), "utf8") > RPC_TRANSCRIPT_DATA_BUDGET && messages.length > 0) break;
    messages.push(candidate);
    next += 1;
  }
  return {
    sessionId,
    messages,
    ...(next < entries.length ? { nextCursor: next } : {}),
  };
};
