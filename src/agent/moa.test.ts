import { describe, expect, it, vi } from "vitest";
import type { DevinMessage, DevinProvider, DevinStreamEvent } from "widevin";
import {
  buildAggregatorGuidance,
  buildReferenceMessages,
  injectMoAGuidance,
  REFERENCE_SYSTEM_PROMPT,
  runOneReference,
  runReferences,
  truncateToolResult,
} from "./moa.js";
import type { MoAPreset, ModelSlot } from "./moa.js";

// ---------------------------------------------------------------------------
// fakeProvider helpers (matching turn.test.ts pattern)
// ---------------------------------------------------------------------------

type FakeRound = readonly DevinStreamEvent[] | { throws: unknown };
type StreamChatRequest = Parameters<DevinProvider["streamChat"]>[0];
type FakeProvider = DevinProvider & { streamChatRequests: StreamChatRequest[] };

const fakeProvider = (rounds: readonly FakeRound[]): FakeProvider => {
  let callIndex = 0;
  const streamChatRequests: StreamChatRequest[] = [];
  const provider = {
    login: vi.fn(),
    setToken: vi.fn(),
    clearToken: vi.fn(),
    listModels: vi.fn(),
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

const abortSignal = (): AbortSignal => new AbortController().signal;

// ---------------------------------------------------------------------------
// truncateToolResult
// ---------------------------------------------------------------------------

describe("truncateToolResult", () => {
  it("passes through text at or below budget", () => {
    const text = "a".repeat(100);
    expect(truncateToolResult(text, 100)).toBe(text);
    expect(truncateToolResult(text, 200)).toBe(text);
  });

  it("truncates with head+tail and omission marker", () => {
    const text = "a".repeat(3000) + "b".repeat(3000);
    const result = truncateToolResult(text, 4000);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[... 2000 chars omitted ...]");
    expect(result.startsWith("a".repeat(2000))).toBe(true);
    expect(result.endsWith("b".repeat(2000))).toBe(true);
  });

  it("handles empty string", () => {
    expect(truncateToolResult("", 100)).toBe("");
  });

  it("uses default budget of 4000", () => {
    const short = "x".repeat(3999);
    expect(truncateToolResult(short)).toBe(short);
    const long = "x".repeat(4001);
    expect(truncateToolResult(long)).toContain("[... 1 chars omitted ...]");
  });
});

// ---------------------------------------------------------------------------
// buildReferenceMessages
// ---------------------------------------------------------------------------

describe("buildReferenceMessages", () => {
  it("returns advisory fallback for empty messages", () => {
    const result = buildReferenceMessages([]);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
  });

  it("passes user messages through as plain text", () => {
    const msgs: DevinMessage[] = [{ role: "user", content: "hello" }];
    const result = buildReferenceMessages(msgs);
    // user message → advisory appended since last is user
    const userMsg = result.find(m => m.role === "user" && typeof m.content === "string" && m.content === "hello");
    expect(userMsg).toBeDefined();
  });

  it("extracts text parts from user content arrays", () => {
    const msgs: DevinMessage[] = [
      { role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] },
    ];
    const result = buildReferenceMessages(msgs);
    const userMsg = result.find(m => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("part1"));
    expect(userMsg).toBeDefined();
  });

  it("renders assistant tool calls as text in content", () => {
    const msgs: DevinMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "readFile", arguments: { path: "/x" } }] },
    ];
    const result = buildReferenceMessages(msgs);
    const assistantMsg = result.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg === undefined || assistantMsg.role !== "assistant") throw new Error("expected assistant");
    const text = assistantMsg.content.flatMap(p => p.type === "text" ? [p.text] : []).join("");
    expect(text).toContain("[called tool: readFile(");
  });

  it("folds tool results into preceding assistant message", () => {
    const msgs: DevinMessage[] = [
      { role: "user", content: "do stuff" },
      { role: "assistant", content: [{ type: "text", text: "calling tool" }] },
      { role: "tool", toolCallId: "t1", content: "result text" },
    ];
    const result = buildReferenceMessages(msgs);
    const assistantMsg = result.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg === undefined || assistantMsg.role !== "assistant") throw new Error("expected assistant");
    const text = assistantMsg.content.flatMap(p => p.type === "text" ? [p.text] : []).join("");
    expect(text).toContain("[tool result:");
    expect(text).toContain("result text");
    // advisory prompt appended since last is assistant (now followed by synthetic user)
    const last = result.at(-1);
    expect(last?.role).toBe("user");
  });

  it("emits tool result as assistant message when no preceding assistant exists", () => {
    const msgs: DevinMessage[] = [
      { role: "tool", toolCallId: "t1", content: "orphan result" },
    ];
    const result = buildReferenceMessages(msgs);
    const assistantMsg = result.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg === undefined || assistantMsg.role !== "assistant") throw new Error("expected assistant");
    const text = assistantMsg.content.flatMap(p => p.type === "text" ? [p.text] : []).join("");
    expect(text).toContain("[tool result:");
  });

  it("appends synthetic user advisory when conversation ends on assistant", () => {
    const msgs: DevinMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
    ];
    const result = buildReferenceMessages(msgs);
    const last = result.at(-1);
    expect(last?.role).toBe("user");
    if (last === undefined) throw new Error("expected last");
    expect(typeof last.content).toBe("string");
    expect((last.content as string)).toContain("acting agent");
  });

  it("does not append advisory when last message is already user", () => {
    const msgs: DevinMessage[] = [
      { role: "user", content: "question" },
    ];
    const result = buildReferenceMessages(msgs);
    // The only user message is the real one; no extra synthetic appended
    const userMessages = result.filter(m => m.role === "user");
    // last is user: "question" — no advisory appended (ends on user, not assistant)
    expect(userMessages).toHaveLength(1);
  });

  it("falls back to last user text when all messages are filtered out", () => {
    // developer role would also be included, but let's test empty result scenario
    // by passing a single tool message with no preceding assistant
    const msgs: DevinMessage[] = [
      { role: "tool", toolCallId: "t1", content: "result" },
    ];
    const result = buildReferenceMessages(msgs);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildAggregatorGuidance
// ---------------------------------------------------------------------------

describe("buildAggregatorGuidance", () => {
  it("formats header with model labels", () => {
    const refs = [
      { label: "model-a", text: "advice from a" },
      { label: "model-b", text: "advice from b" },
    ];
    const result = buildAggregatorGuidance(refs);
    expect(result).toContain("model-a, model-b");
    expect(result).toContain("[Mixture of Agents reference context");
  });

  it("formats each reference with 1-based index and label", () => {
    const refs = [
      { label: "model-a", text: "first" },
      { label: "model-b", text: "second" },
    ];
    const result = buildAggregatorGuidance(refs);
    expect(result).toContain("Reference 1 (model-a):");
    expect(result).toContain("Reference 2 (model-b):");
    expect(result).toContain("first");
    expect(result).toContain("second");
  });

  it("works with a single reference", () => {
    const refs = [{ label: "only-model", text: "solo" }];
    const result = buildAggregatorGuidance(refs);
    expect(result).toContain("Reference 1 (only-model):");
    expect(result).toContain("solo");
  });

  it("marks content as private advisory", () => {
    const refs = [{ label: "m", text: "text" }];
    const result = buildAggregatorGuidance(refs);
    expect(result).toContain("private");
    expect(result).toContain("aggregator");
  });
});

// ---------------------------------------------------------------------------
// injectMoAGuidance
// ---------------------------------------------------------------------------

describe("injectMoAGuidance", () => {
  it("appends a user message with the guidance text", () => {
    const messages: DevinMessage[] = [{ role: "user", content: "original" }];
    const result = injectMoAGuidance(messages, "guidance text");
    expect(result).toHaveLength(2);
    expect(result.at(-1)).toEqual({ role: "user", content: "guidance text" });
  });

  it("does not mutate the input array", () => {
    const messages: DevinMessage[] = [{ role: "user", content: "original" }];
    injectMoAGuidance(messages, "guidance");
    expect(messages).toHaveLength(1);
  });

  it("returns a new array reference", () => {
    const messages: DevinMessage[] = [];
    const result = injectMoAGuidance(messages, "g");
    expect(result).not.toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// runOneReference
// ---------------------------------------------------------------------------

describe("runOneReference", () => {
  const slot: ModelSlot = { model: "ref-model" };
  const refMessages: DevinMessage[] = [{ role: "user", content: "advise" }];

  it("collects text_delta events into returned text", async () => {
    const devin = fakeProvider([
      [
        { type: "text_delta", delta: "Hello " },
        { type: "text_delta", delta: "world" },
        { type: "done", reason: "stop" },
      ],
    ]);
    const result = await runOneReference(devin, slot, refMessages, undefined, abortSignal());
    expect(result.label).toBe("ref-model");
    expect(result.text).toBe("Hello world");
  });

  it("uses the REFERENCE_SYSTEM_PROMPT and no tools", async () => {
    const devin = fakeProvider([[{ type: "done", reason: "stop" }]]);
    await runOneReference(devin, slot, refMessages, undefined, abortSignal());
    const req = devin.streamChatRequests[0];
    expect(req?.systemPrompt).toEqual([REFERENCE_SYSTEM_PROMPT]);
    expect(req?.tools).toBeUndefined();
  });

  it("passes temperature from slot when provided", async () => {
    const hotSlot: ModelSlot = { model: "ref-model", temperature: 0.8 };
    const devin = fakeProvider([[{ type: "done", reason: "stop" }]]);
    await runOneReference(devin, hotSlot, refMessages, undefined, abortSignal());
    expect(devin.streamChatRequests[0]?.temperature).toBe(0.8);
  });

  it("returns labelled failure note on provider error, never throws", async () => {
    const devin = fakeProvider([{ throws: new Error("model unavailable") }]);
    const result = await runOneReference(devin, slot, refMessages, undefined, abortSignal());
    expect(result.label).toBe("ref-model");
    expect(result.text).toMatch(/^\[failed: model unavailable\]/);
  });

  it("breaks early when collected text exceeds char budget", async () => {
    const longDelta = "x".repeat(3000);
    const devin = fakeProvider([
      [
        { type: "text_delta", delta: longDelta },
        { type: "text_delta", delta: longDelta },
        { type: "text_delta", delta: longDelta },
        { type: "done", reason: "stop" },
      ],
    ]);
    // maxTokens=100 → charBudget=400; longDelta=3000 > 400 so breaks after first
    const result = await runOneReference(devin, slot, refMessages, 100, abortSignal());
    expect(result.text.length).toBeGreaterThanOrEqual(3000);
    expect(result.text.length).toBeLessThan(9000);
  });

  it("passes maxTokens to streamChat when provided", async () => {
    const devin = fakeProvider([[{ type: "done", reason: "stop" }]]);
    await runOneReference(devin, slot, refMessages, 512, abortSignal());
    expect(devin.streamChatRequests[0]?.maxTokens).toBe(512);
  });
});

// runReferences
// ---------------------------------------------------------------------------

describe("runReferences", () => {
  const preset: MoAPreset = {
    name: "test",
    referenceModels: [
      { model: "ref-1" },
      { model: "ref-2" },
    ],
    aggregator: { model: "agg-model" },
  };

  const messages: DevinMessage[] = [{ role: "user", content: "hi" }];

  it("fans out all references in parallel and preserves order", async () => {
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "from ref-1" }, { type: "done", reason: "stop" }],
      [{ type: "text_delta", delta: "from ref-2" }, { type: "done", reason: "stop" }],
    ]);
    const results = await runReferences(devin, preset, messages, abortSignal());
    expect(results).toHaveLength(2);
    expect(results[0]?.label).toBe("ref-1");
    expect(results[0]?.text).toBe("from ref-1");
    expect(results[1]?.label).toBe("ref-2");
    expect(results[1]?.text).toBe("from ref-2");
  });

  it("continues when one reference fails, returning failure note in order", async () => {
    const devin = fakeProvider([
      { throws: new Error("ref-1 down") },
      [{ type: "text_delta", delta: "ref-2 ok" }, { type: "done", reason: "stop" }],
    ]);
    const results = await runReferences(devin, preset, messages, abortSignal());
    expect(results).toHaveLength(2);
    expect(results[0]?.text).toMatch(/\[failed:/);
    expect(results[1]?.text).toBe("ref-2 ok");
  });
});
