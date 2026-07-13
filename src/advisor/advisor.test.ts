import { describe, expect, it, vi } from "vitest";
import type { DevinProvider, DevinMessage, DevinStreamEvent } from "widevin";
import type { MemoryStore } from "../persistence/memoryStore.js";
import {
  createAdvisorRuntime,
  formatDeltaForAdvisor,
  ADVISOR_ALLOWED_TOOLS,
  ADVISOR_SYSTEM_PROMPT,
} from "./advisor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeProvider = (rounds: readonly (readonly DevinStreamEvent[])[]): DevinProvider => {
  let index = 0;
  return {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(),
    streamChat: vi.fn(async function* () {
      for (const event of rounds[index++] ?? []) yield event;
    }),
  };
};

/** toolcall_end requires arguments per the widevin type. */
const toolcallEnd = (id: string, name: string): DevinStreamEvent =>
  ({ type: "toolcall_end", id, name, arguments: undefined });

/** Build a typed steer spy. */
const makeSteer = (): (text: string) => void => vi.fn() as unknown as (text: string) => void;
/** Build a typed appendToPrimary spy. */
const makeAppend = (): (msg: DevinMessage) => void => vi.fn() as unknown as (msg: DevinMessage) => void;

// ---------------------------------------------------------------------------
// formatDeltaForAdvisor
// ---------------------------------------------------------------------------

describe("formatDeltaForAdvisor", () => {
  it("formats a user text message", () => {
    const msgs: DevinMessage[] = [{ role: "user", content: "hello world" }];
    expect(formatDeltaForAdvisor(msgs)).toBe("[User]: hello world");
  });

  it("truncates user content to 500 chars", () => {
    const long = "x".repeat(600);
    const msgs: DevinMessage[] = [{ role: "user", content: long }];
    const result = formatDeltaForAdvisor(msgs);
    expect(result).toBe(`[User]: ${"x".repeat(500)}`);
  });

  it("renders [non-text content] for array user content", () => {
    const msgs: DevinMessage[] = [{ role: "user", content: [] as unknown as string }];
    expect(formatDeltaForAdvisor(msgs)).toBe("[User]: [non-text content]");
  });

  it("formats an assistant message with text and tool calls", () => {
    const msgs: DevinMessage[] = [{
      role: "assistant",
      content: [
        { type: "text", text: "thinking..." },
        { type: "toolCall", id: "t1", name: "read_file", arguments: { path: "/foo" } },
      ],
    }];
    const result = formatDeltaForAdvisor(msgs);
    expect(result).toContain("[Assistant]:");
    expect(result).toContain("thinking...");
    expect(result).toContain("Tool call: read_file(");
    expect(result).toContain("/foo");
  });

  it("truncates tool call args to 200 chars", () => {
    const longPath = "a".repeat(250);
    const msgs: DevinMessage[] = [{
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: longPath } }],
    }];
    const result = formatDeltaForAdvisor(msgs);
    expect(result).toContain("…");
  });

  it("formats a tool result message", () => {
    const msgs: DevinMessage[] = [{ role: "tool", toolCallId: "t1", content: "file contents", isError: false }];
    const result = formatDeltaForAdvisor(msgs);
    expect(result).toContain("[Tool t1]: file contents");
  });

  it("truncates tool result to 300 chars", () => {
    const long = "z".repeat(400);
    const msgs: DevinMessage[] = [{ role: "tool", toolCallId: "t1", content: long, isError: false }];
    const result = formatDeltaForAdvisor(msgs);
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(400);
  });

  it("joins multiple messages with double newlines", () => {
    const msgs: DevinMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(formatDeltaForAdvisor(msgs)).toContain("\n\n");
  });
});

// ---------------------------------------------------------------------------
// AdvisorRuntime — seedFrom
// ---------------------------------------------------------------------------

describe("AdvisorRuntime.seedFrom", () => {
  it("after seeding with N messages, onPrimaryTurnEnd with same array does NOT call streamChat", async () => {
    const devin = makeProvider([]);
    const runtime = createAdvisorRuntime(devin, { model: "test-model" });

    const msgs: DevinMessage[] = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));

    runtime.seedFrom(msgs);
    await runtime.onPrimaryTurnEnd(msgs, makeSteer(), makeAppend());

    expect(devin.streamChat).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AdvisorRuntime — onPrimaryTurnEnd
// ---------------------------------------------------------------------------

describe("AdvisorRuntime.onPrimaryTurnEnd", () => {
  it("calls streamChat with correct model, tools, and system prompt", async () => {
    const devin = makeProvider([[{ type: "text_delta", delta: "ok" }]]);
    const runtime = createAdvisorRuntime(devin, { model: "advisor-model" });

    const msgs: DevinMessage[] = [{ role: "user", content: "do something" }];
    await runtime.onPrimaryTurnEnd(msgs, makeSteer(), makeAppend());

    expect(devin.streamChat).toHaveBeenCalledOnce();
    const calls = (devin.streamChat as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[0]![0] as {
      model: string;
      tools: { name: string }[];
      systemPrompt: readonly string[];
    };
    expect(req.model).toBe("advisor-model");
    expect(req.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(ADVISOR_ALLOWED_TOOLS.filter(n => n === "advise"))
    );
    expect(req.systemPrompt).toBe(ADVISOR_SYSTEM_PROMPT);
  });

  it("advisor calls advise with concern → steer spy called with XML", async () => {
    const steerSpy = vi.fn<(text: string) => void>();
    const appendSpy = vi.fn<(msg: DevinMessage) => void>();

    const argsStr = JSON.stringify({ note: "missing null check", severity: "concern" });
    const deltaEvents: DevinStreamEvent[] = argsStr.split("").map(ch => ({
      type: "toolcall_delta" as const,
      id: "tc1",
      delta: ch,
    }));

    // Round 1: advisor calls advise tool; Round 2: done
    const devin = makeProvider([
      [...deltaEvents, toolcallEnd("tc1", "advise")],
      [{ type: "text_delta", delta: "noted" }],
    ]);

    const runtime = createAdvisorRuntime(devin, { model: "advisor-model" });
    const msgs: DevinMessage[] = [{ role: "user", content: "some work" }];
    await runtime.onPrimaryTurnEnd(
      msgs,
      steerSpy as unknown as (text: string) => void,
      appendSpy as unknown as (msg: DevinMessage) => void,
    );

    expect(steerSpy).toHaveBeenCalledOnce();
    const callArg = steerSpy.mock.calls[0]![0];
    expect(callArg).toContain('<advisory severity="concern"');
    expect(callArg).toContain("missing null check");
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("advisor calls advise with no severity → steers with nit XML", async () => {
    const steerSpy = vi.fn<(text: string) => void>();
    const appendSpy = vi.fn<(msg: DevinMessage) => void>();

    const argsStr = JSON.stringify({ note: "minor rename" });
    const deltaEvents: DevinStreamEvent[] = argsStr.split("").map(ch => ({
      type: "toolcall_delta" as const,
      id: "tc2",
      delta: ch,
    }));

    const devin = makeProvider([
      [...deltaEvents, toolcallEnd("tc2", "advise")],
      [{ type: "text_delta", delta: "done" }],
    ]);

    const runtime = createAdvisorRuntime(devin, { model: "advisor-model" });
    const msgs: DevinMessage[] = [{ role: "user", content: "work" }];
    await runtime.onPrimaryTurnEnd(
      msgs,
      steerSpy as unknown as (text: string) => void,
      appendSpy as unknown as (msg: DevinMessage) => void,
    );

    expect(appendSpy).not.toHaveBeenCalled();
    expect(steerSpy).toHaveBeenCalledWith(expect.stringContaining('<advisory severity="nit"'));
  });

  it("streamChat throws → no exception propagates and console.error is called", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const devin: DevinProvider = {
      login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(),
      streamChat: vi.fn() as unknown as DevinProvider["streamChat"],
    };
    (devin.streamChat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      throw new Error("network failure");
    });

    const runtime = createAdvisorRuntime(devin, { model: "advisor-model" });
    const msgs: DevinMessage[] = [{ role: "user", content: "work" }];

    await expect(runtime.onPrimaryTurnEnd(msgs, makeSteer(), makeAppend())).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith("Advisor error:", expect.any(Error));

    consoleError.mockRestore();
  });

  it("iteration budget: loop stops after 3 rounds even if advisor keeps calling tools", async () => {
    const argsStr = JSON.stringify({ note: "repeated", severity: "nit" });
    const deltaEvents: DevinStreamEvent[] = argsStr.split("").map(ch => ({
      type: "toolcall_delta" as const,
      id: "tc-loop",
      delta: ch,
    }));
    const round: DevinStreamEvent[] = [...deltaEvents, toolcallEnd("tc-loop", "advise")];

    const devin = makeProvider([round, round, round, round, round]);
    const runtime = createAdvisorRuntime(devin, { model: "advisor-model" });
    const msgs: DevinMessage[] = [{ role: "user", content: "work" }];

    await runtime.onPrimaryTurnEnd(msgs, makeSteer(), makeAppend());

    // Budget is 3 — streamChat must not be called more than 3 times
    expect((devin.streamChat as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("ADVISOR_ALLOWED_TOOLS", () => {
  it("includes memory_search", () => {
    expect(ADVISOR_ALLOWED_TOOLS).toContain("memory_search");
  });

  it("includes note_search", () => {
    expect(ADVISOR_ALLOWED_TOOLS).toContain("note_search");
  });

  it("does not include memory_write", () => {
    expect(ADVISOR_ALLOWED_TOOLS).not.toContain("memory_write");
  });
});

describe("createAdvisorRuntime with memoryStore", () => {
  it("passes memoryStore to tool context so memory_search returns results instead of error", async () => {
    // Mock memory store
    const mockMemoryStore = {
      save: vi.fn(),
      search: vi.fn().mockReturnValue([{ id: "1", content: "prefers TypeScript", category: "preference", createdAt: 1234 }]),
      recent: vi.fn().mockReturnValue([]),
      all: vi.fn().mockReturnValue([]),
      delete: vi.fn(),
      update: vi.fn(),
      runInTransaction: vi.fn(),
    };

    // Provide a memory_search round: the advisor calls memory_search, gets results, then ends
    const searchResultEvent: readonly DevinStreamEvent[] = [
      { type: "toolcall_delta", id: "tc1", delta: '{"query":"typescript"}' },
      toolcallEnd("tc1", "memory_search"),
    ];
    const doneEvent: readonly DevinStreamEvent[] = [];

    const provider = makeProvider([searchResultEvent, doneEvent]);
    const runtime = createAdvisorRuntime(provider, { model: "test-model" }, mockMemoryStore as unknown as MemoryStore);
    runtime.seedFrom([]);

    const steer = makeSteer();
    const append = makeAppend();
    // Run with one primary turn message so delta is non-empty
    await runtime.onPrimaryTurnEnd(
      [{ role: "user", content: "hello" }],
      steer,
      append,
    );

    // memory_search should have been called on the mock store
    expect(mockMemoryStore.search).toHaveBeenCalledWith("typescript");
  });
});
