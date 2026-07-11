import { describe, expect, it } from "vitest";
import type { DevinMessage, DevinProvider, DevinStreamEvent } from "widevin";
import { DevinApiError } from "widevin";
import {
  approxTokenCount,
  buildCompactedMessage,
  isSummaryMessage,
  runCompaction,
  selectRecentUserTexts,
  SUMMARIZATION_PROMPT,
  SUMMARY_PREFIX,
  truncateMiddleTokens,
} from "./compaction.js";

type FakeRound = readonly DevinStreamEvent[] | { throws: unknown };
type StreamChatRequest = Parameters<DevinProvider["streamChat"]>[0];
type FakeProvider = DevinProvider & { streamChatRequests: StreamChatRequest[] };

const fakeProvider = (rounds: readonly FakeRound[]): FakeProvider => {
  let callIndex = 0;
  const streamChatRequests: StreamChatRequest[] = [];
  const provider = {
    login: async () => "",
    setToken: async () => {},
    clearToken: async () => {},
    listModels: async () => [],
    streamChat: async function* (request: StreamChatRequest) {
      streamChatRequests.push(request);
      const round = rounds[callIndex++];
      if (!round) throw new Error(`streamChat called more times (call ${callIndex}) than scripted (${rounds.length})`);
      if ("throws" in round) throw round.throws;
      for (const event of round) yield event;
    },
  };
  return Object.assign(provider, { streamChatRequests });
};

const defaultSystemPrompt = ["Railgun test system prompt"] as const;

describe("approxTokenCount", () => {
  it("divides character length by 4, rounding up", () => {
    expect(approxTokenCount("")).toBe(0);
    expect(approxTokenCount("abcd")).toBe(1);
    expect(approxTokenCount("abcde")).toBe(2);
    expect(approxTokenCount("a".repeat(400))).toBe(100);
  });
});

describe("truncateMiddleTokens", () => {
  it("returns text unchanged when under budget", () => {
    const text = "short text";
    expect(truncateMiddleTokens(text, 1000)).toBe(text);
  });

  it("inserts a token-count marker and preserves prefix/suffix verbatim", () => {
    const prefix = "P".repeat(40);
    const suffix = "S".repeat(40);
    const middle = "M".repeat(400);
    const text = prefix + middle + suffix;
    const maxTokens = 30; // budget far under approxTokenCount(text)

    const result = truncateMiddleTokens(text, maxTokens);

    const totalTokens = approxTokenCount(text);
    const expectedRemoved = totalTokens - maxTokens;
    expect(result).toContain(`…${expectedRemoved} tokens truncated…`);
    expect(result.startsWith(prefix)).toBe(true);
    expect(result.endsWith(suffix)).toBe(true);
  });
});

describe("isSummaryMessage", () => {
  it("matches text starting with the summary prefix followed by a newline", () => {
    expect(isSummaryMessage(`${SUMMARY_PREFIX}\nActual summary body`)).toBe(true);
  });

  it("rejects text that does not start with the summary prefix", () => {
    expect(isSummaryMessage("Just a regular user message")).toBe(false);
    expect(isSummaryMessage(SUMMARY_PREFIX)).toBe(false); // missing trailing newline
  });
});

describe("selectRecentUserTexts", () => {
  it("restores chronological order after selecting newest-first", () => {
    const messages: DevinMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: "third" },
    ];

    const result = selectRecentUserTexts(messages, 1000);

    expect(result).toEqual(["first", "second", "third"]);
  });

  it("drops the oldest text once the budget is exceeded", () => {
    const big = "x".repeat(4000); // ~1000 tokens
    const messages: DevinMessage[] = [
      { role: "user", content: big },
      { role: "user", content: big },
      { role: "user", content: big },
    ];

    // Budget only fits two ~1000-token messages.
    const result = selectRecentUserTexts(messages, 2000);

    expect(result).toHaveLength(2);
    expect(result).toEqual([big, big]);
  });

  it("truncates rather than drops the boundary message that exceeds remaining budget", () => {
    const big = "x".repeat(4000); // ~1000 tokens
    const messages: DevinMessage[] = [
      { role: "user", content: big },
      { role: "user", content: big },
    ];

    // First selected (newest) consumes 1000 tokens leaving 500 remaining for the older one.
    const result = selectRecentUserTexts(messages, 1500);

    expect(result).toHaveLength(2);
    expect(result[1]).toBe(big); // newest kept whole
    expect(result[0]).not.toBe(big); // oldest truncated, not identical
    expect(result[0]).toContain("tokens truncated");
  });

  it("excludes summary messages from selection", () => {
    const messages: DevinMessage[] = [
      { role: "user", content: "real message" },
      { role: "user", content: `${SUMMARY_PREFIX}\nold summary` },
    ];

    const result = selectRecentUserTexts(messages, 1000);

    expect(result).toEqual(["real message"]);
  });
});

describe("buildCompactedMessage", () => {
  it("returns a single role:user message with texts joined and the summary prefix present", () => {
    const message = buildCompactedMessage(["first", "second"], "the summary body");

    expect(message.role).toBe("user");
    expect(typeof message.content).toBe("string");
    const content = message.content as string;
    expect(content).toContain("first\n\n---\n\nsecond");
    expect(content).toContain(`${SUMMARY_PREFIX}\nthe summary body`);
  });

  it("falls back to a placeholder when the summary body is empty", () => {
    const message = buildCompactedMessage([], "");
    const content = message.content as string;
    expect(content).toContain(`${SUMMARY_PREFIX}\n(no summary available)`);
  });
});

describe("runCompaction", () => {
  it("summarizes successfully and returns a single compacted message", async () => {
    const devin = fakeProvider([
      [
        { type: "text_delta", delta: "Summary " },
        { type: "text_delta", delta: "text." },
        { type: "usage", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { type: "done", reason: "stop" },
      ],
    ]);
    const messages: DevinMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];

    const result = await runCompaction(devin, "model-1", defaultSystemPrompt, messages);

    expect(result.messages).toHaveLength(1);
    const [compacted] = result.messages;
    expect(compacted?.role).toBe("user");
    expect(compacted?.content).toContain("Summary text.");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(devin.streamChatRequests).toHaveLength(1);
    expect(devin.streamChatRequests[0]?.tools).toBeUndefined();
    const requestMessages = devin.streamChatRequests[0]?.messages ?? [];
    expect(requestMessages.at(-1)).toEqual({ role: "user", content: SUMMARIZATION_PROMPT });
  });

  it("retries with one fewer message on a 413 and succeeds on the second attempt", async () => {
    const devin = fakeProvider([
      { throws: new DevinApiError("too large", 413) },
      [{ type: "text_delta", delta: "ok summary" }],
    ]);
    const messages: DevinMessage[] = [
      { role: "user", content: "old message" },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: "recent message" },
    ];

    const result = await runCompaction(devin, "model-1", defaultSystemPrompt, messages);

    expect(devin.streamChatRequests).toHaveLength(2);
    const firstLen = devin.streamChatRequests[0]?.messages.length ?? 0;
    const secondLen = devin.streamChatRequests[1]?.messages.length ?? 0;
    expect(secondLen).toBe(firstLen - 1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toContain("ok summary");
  });

  it("rethrows when a 413 persists down to a single request message", async () => {
    const persistentBoom = new DevinApiError("too large", 413);
    const devin = fakeProvider(
      Array.from({ length: 5 }, () => ({ throws: persistentBoom })),
    );
    const messages: DevinMessage[] = [{ role: "user", content: "only message" }];

    await expect(runCompaction(devin, "model-1", defaultSystemPrompt, messages)).rejects.toThrow(persistentBoom);
  });

  it("rethrows non-413 errors immediately without retry", async () => {
    const boom = new Error("boom");
    const devin = fakeProvider([{ throws: boom }]);
    const messages: DevinMessage[] = [{ role: "user", content: "hi" }];

    await expect(runCompaction(devin, "model-1", defaultSystemPrompt, messages)).rejects.toThrow(boom);
    expect(devin.streamChatRequests).toHaveLength(1);
  });

  it("selects user texts from the original messages, not the retry-shrunk request array", async () => {
    const devin = fakeProvider([
      { throws: new DevinApiError("too large", 413) },
      [{ type: "text_delta", delta: "summary" }],
    ]);
    const messages: DevinMessage[] = [
      { role: "user", content: "first user text" },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: "second user text" },
    ];

    const result = await runCompaction(devin, "model-1", defaultSystemPrompt, messages);

    const content = result.messages[0]?.content as string;
    expect(content).toContain("first user text");
    expect(content).toContain("second user text");
  });
});
