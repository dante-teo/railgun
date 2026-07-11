import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import { DevinApiError } from "widevin";
import { runTurn } from "./turn.js";
import type { MoAPreset } from "./moa.js";
import type { AgentEvent } from "./events.js";
import { registry } from "../tools/index.js";
import { createTodoStore } from "../tools/todo.js";
import { CORRUPTION_MARKER } from "./toolDispatch.js";
import { IterationBudget, ITERATION_LIMIT_MESSAGE } from "./iterationBudget.js";
import { createExtensionRunner } from "../extensions/runner.js";

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

// Default passthrough to the real readFile so every existing test keeps hitting the real
// filesystem; individual tests override with mockImplementationOnce to control timing.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualReadFile = actual.readFile as typeof readFile;
  readFileMock.mockImplementation((...args: Parameters<typeof readFile>) => actualReadFile(...args));
  return { ...actual, readFile: readFileMock };
});

type FakeRound = readonly DevinStreamEvent[] | { throws: unknown };
type StreamChatRequest = Parameters<DevinProvider["streamChat"]>[0];
type FakeProvider = DevinProvider & { streamChatRequests: StreamChatRequest[] };

const approveAll = async () => true;
const defaultBudget = () => IterationBudget.create();
const defaultSystemPrompt = ["Railgun test system prompt"] as const;

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
    }
  };
  return Object.assign(provider, { streamChatRequests });
};

describe("runTurn", () => {
  it("accumulates text_delta events, streams via message_update text_delta events, and appends user+assistant messages", async () => {
    const devin = fakeProvider([
      [
        { type: "text_delta", delta: "Hel" },
        { type: "text_delta", delta: "lo" },
        { type: "done", reason: "stop" }
      ]
    ]);
    const deltas: string[] = [];

    const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll, async event => {
      if (event.type === "message_update" && event.streamEvent.type === "text_delta") deltas.push(event.streamEvent.delta);
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.assistantText).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(outcome.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] }
    ]);
  });

  it("passes the provided systemPrompt unchanged to Devin", async () => {
    const devin = fakeProvider([[{ type: "text_delta", delta: "ok" }]]);
    const systemPrompt = ["identity", "tool rules", "environment"] as const;

    const outcome = await runTurn(devin, "model-1", 1_000_000, systemPrompt, [], "Hi", defaultBudget(), approveAll);

    expect(outcome.ok).toBe(true);
    expect(devin.streamChatRequests).toHaveLength(1);
    expect(devin.streamChatRequests[0]?.systemPrompt).toBe(systemPrompt);
  });

  it("passes the same systemPrompt to every Devin call in a multi-round turn", async () => {
    const devin = fakeProvider([
      [
        { type: "toolcall_delta", id: "call-1", delta: "{}" },
        { type: "toolcall_end", id: "call-1", name: "loop_forever", arguments: {} }
      ],
      [
        { type: "toolcall_delta", id: "call-2", delta: "{}" },
        { type: "toolcall_end", id: "call-2", name: "loop_forever", arguments: {} }
      ],
      [{ type: "text_delta", delta: "done" }]
    ]);
    const systemPrompt = ["stable", "cached"] as const;

    const outcome = await runTurn(devin, "model-1", 1_000_000, systemPrompt, [], "Hi", defaultBudget(), approveAll);

    expect(outcome.ok).toBe(true);
    expect(devin.streamChatRequests).toHaveLength(3);
    expect(devin.streamChatRequests.map(request => request.systemPrompt)).toEqual([
      systemPrompt,
      systemPrompt,
      systemPrompt
    ]);
  });

  it("exposes the planning todo tool to Devin", async () => {
    const devin = fakeProvider([[{ type: "text_delta", delta: "ok" }]]);

    const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

    expect(outcome.ok).toBe(true);
    expect(devin.streamChatRequests[0]?.tools?.some(tool => tool.name === "todo")).toBe(true);
  });

  it("keeps prior history intact and appends the new turn on success", async () => {
    const devin = fakeProvider([[{ type: "text_delta", delta: "Alex" }]]);
    const priorHistory = [
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: [{ type: "text", text: "Nice to meet you, Alex" }] }
    ] as const;

    const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, priorHistory, "What is my name?", defaultBudget(), approveAll);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.messages.slice(0, 2)).toEqual(priorHistory);
    expect(outcome.messages).toHaveLength(4);
  });

  it("returns ok:false and leaves the caller's history untouched when streamChat throws", async () => {
    const boom = new DevinApiError("network blip", 400);
    const devin = fakeProvider([{ throws: boom }]);

    const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

    expect(outcome).toEqual({ ok: false, error: boom });
  });

  it("pushes a corruption marker and never invokes registry.run when tool-call JSON never parses", async () => {
    const runSpy = vi.spyOn(registry, "run");
    try {
      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: '{"path": "a.txt"' },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: {} }
        ],
        [{ type: "text_delta", delta: "ok" }]
      ]);

      const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.messages).toContainEqual({
        role: "tool",
        toolCallId: "call-1",
        content: CORRUPTION_MARKER,
        isError: true
      });
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      runSpy.mockRestore();
    }
  });

  it("retries a step after a retryable API error and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    try {
      const devin = fakeProvider([
        { throws: new DevinApiError("rate limited", 429) },
        [{ type: "text_delta", delta: "ok" }]
      ]);

      const outcomePromise = runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);
      await vi.runAllTimersAsync();
      const outcome = await outcomePromise;

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unrelated errors immediately without replaying the failed turn", async () => {
    const err = new Error("persistent failure");
    const devin = fakeProvider([{ throws: err }]);
    const streamChat = vi.spyOn(devin, "streamChat");

    const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

    expect(outcome).toEqual({ ok: false, error: err });
    expect(streamChat).toHaveBeenCalledOnce();
  });

  it("returns HTTP 401 immediately with unchanged history and never replays the failed message", async () => {
    const err = new DevinApiError("unauthorized", 401);
    const devin = fakeProvider([{ throws: err }]);
    const streamChat = vi.spyOn(devin, "streamChat");
    const history = [{ role: "user", content: "prior" }] as const;

    const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, history, "resubmit me", defaultBudget(), approveAll);

    expect(outcome).toEqual({ ok: false, error: err });
    expect(history).toEqual([{ role: "user", content: "prior" }]);
    expect(streamChat).toHaveBeenCalledOnce();
  });

  describe("tool calling", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "railgun-turn-test-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
      readFileMock.mockClear();
    });

    it("round-trips a successful read_file tool call into the final answer (proves registry wiring works end-to-end)", async () => {
      const filePath = join(dir, "secret.txt");
      await writeFile(filePath, "the secret is 42", "utf-8");

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: filePath }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: filePath } }
        ],
        [{ type: "text_delta", delta: "The secret is 42." }]
      ]);

      const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "What is the secret?", defaultBudget(), approveAll);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe("The secret is 42.");
      expect(outcome.messages).toEqual([
        { role: "user", content: "What is the secret?" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: filePath } }]
        },
        { role: "tool", toolCallId: "call-1", content: "the secret is 42", isError: false },
        { role: "assistant", content: [{ type: "text", text: "The secret is 42." }] }
      ]);
    });

    it("passes confirmShellCommand through to a run_shell_command tool call for a dangerous command", async () => {
      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ command: "sudo echo turn-test" }) },
          { type: "toolcall_end", id: "call-1", name: "run_shell_command", arguments: { command: "sudo echo turn-test" } }
        ],
        [{ type: "text_delta", delta: "Ran it." }]
      ]);
      const confirmShellCommand = vi.fn(async () => true);

      const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Run sudo echo", defaultBudget(), confirmShellCommand);

      expect(confirmShellCommand).toHaveBeenCalledWith("sudo echo turn-test");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const toolMessage = outcome.messages.find(m => m.role === "tool");
      expect(toolMessage).toBeDefined();
    });

    it("stops after exhausting the iteration budget and appends the limit message", async () => {
      const budget = IterationBudget.create(3);
      const rounds: FakeRound[] = Array.from({ length: 3 }, (_, i) => [
        { type: "toolcall_delta", id: `call-${i}`, delta: "{}" },
        { type: "toolcall_end", id: `call-${i}`, name: "loop_forever", arguments: {} }
      ]);
      const devin = fakeProvider(rounds);
      const streamChatSpy = vi.spyOn(devin, "streamChat");

      const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Loop forever", budget, approveAll);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe(ITERATION_LIMIT_MESSAGE);
      expect(streamChatSpy).toHaveBeenCalledTimes(3);
      expect(outcome.messages.at(-1)).toEqual({
        role: "assistant",
        content: [{ type: "text", text: ITERATION_LIMIT_MESSAGE }]
      });
    });

    it("discards the whole turn and leaves caller history untouched when a later round throws", async () => {
      const filePath = join(dir, "secret.txt");
      await writeFile(filePath, "the secret is 42", "utf-8");
      const boom = new DevinApiError("bad request", 400);

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: filePath }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: filePath } }
        ],
        { throws: boom }
      ]);
      const priorHistory = [{ role: "user", content: "hi" }] as const;
      const priorHistorySnapshot = JSON.parse(JSON.stringify(priorHistory));

      const outcome = await runTurn(
        devin,
        "model-1",
        1_000_000,
        defaultSystemPrompt,
        priorHistory,
        "What is the secret?",
        defaultBudget(),
        approveAll
      );

      expect(outcome).toEqual({ ok: false, error: boom });
      expect(priorHistory).toEqual(priorHistorySnapshot);
    });

    it("runs two read_file calls on different paths concurrently via Promise.all", async () => {
      const fileA = join(dir, "a.txt");
      const fileB = join(dir, "b.txt");
      await writeFile(fileA, "AAA", "utf-8");
      await writeFile(fileB, "BBB", "utf-8");

      const deferredA = Promise.withResolvers<string>();
      const deferredB = Promise.withResolvers<string>();
      readFileMock.mockImplementationOnce(() => deferredA.promise).mockImplementationOnce(() => deferredB.promise);

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: fileA }) },
          { type: "toolcall_delta", id: "call-2", delta: JSON.stringify({ path: fileB }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: fileA } },
          { type: "toolcall_end", id: "call-2", name: "read_file", arguments: { path: fileB } }
        ],
        [{ type: "text_delta", delta: "done" }]
      ]);

      const outcomePromise = runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Read both files", defaultBudget(), approveAll);

      // Both readFile calls must fire before either resolves -- genuine concurrency, not
      // "both eventually completed".
      await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2));

      deferredA.resolve("AAA");
      deferredB.resolve("BBB");
      const outcome = await outcomePromise;

      expect(outcome.ok).toBe(true);
      expect(readFileMock).toHaveBeenNthCalledWith(1, fileA, "utf-8");
      expect(readFileMock).toHaveBeenNthCalledWith(2, fileB, "utf-8");
    });

    it("runs two read_file calls on the identical path sequentially, one at a time", async () => {
      const fileA = join(dir, "a.txt");
      await writeFile(fileA, "AAA", "utf-8");

      const deferred1 = Promise.withResolvers<string>();
      const deferred2 = Promise.withResolvers<string>();
      readFileMock.mockImplementationOnce(() => deferred1.promise).mockImplementationOnce(() => deferred2.promise);

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: fileA }) },
          { type: "toolcall_delta", id: "call-2", delta: JSON.stringify({ path: fileA }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: fileA } },
          { type: "toolcall_end", id: "call-2", name: "read_file", arguments: { path: fileA } }
        ],
        [{ type: "text_delta", delta: "done" }]
      ]);

      const outcomePromise = runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Read the same file twice", defaultBudget(), approveAll);

      await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(1));
      // The second read_file call cannot fire until this `await registry.run(...)` inside
      // turn.ts's sequential for-loop settles -- deferred1 is still pending here, so the
      // count staying at 1 is a structural guarantee from the await chain, not a race.
      expect(readFileMock).toHaveBeenCalledTimes(1);

      deferred1.resolve("AAA");
      await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2));

      deferred2.resolve("AAA");
      const outcome = await outcomePromise;

      expect(outcome.ok).toBe(true);
    });

    it("emits tool_execution_start before tool_execution_end for a sequential read_file call", async () => {
      const filePath = join(dir, "secret.txt");
      await writeFile(filePath, "the secret is 42", "utf-8");
      const events: AgentEvent[] = [];
      const emit = async (e: AgentEvent) => { events.push(e); };

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: filePath }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: filePath } }
        ],
        [{ type: "text_delta", delta: "The secret is 42." }]
      ]);

      const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "What is the secret?", defaultBudget(), approveAll, emit);

      expect(outcome.ok).toBe(true);
      const startIndex = events.findIndex(e =>
        e.type === "tool_execution_start" && e.toolCallId === "call-1" && e.toolName === "read_file" && JSON.stringify(e.args) === JSON.stringify({ path: filePath })
      );
      const endIndex = events.findIndex(e =>
        e.type === "tool_execution_end" && e.toolCallId === "call-1" && e.toolName === "read_file" &&
        JSON.stringify(e.result) === JSON.stringify({ toolCallId: "call-1", content: "the secret is 42", isError: false })
      );
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
    });

    it("emits tool_execution_start/tool_execution_end with empty args and isError true for a corrupted tool call", async () => {
      const events: AgentEvent[] = [];
      const emit = async (e: AgentEvent) => { events.push(e); };
      const runSpy = vi.spyOn(registry, "run");
      try {
        const devin = fakeProvider([
          [
            { type: "toolcall_delta", id: "call-1", delta: '{"path": "a.txt"' },
            { type: "toolcall_end", id: "call-1", name: "read_file", arguments: {} }
          ],
          [{ type: "text_delta", delta: "ok" }]
        ]);

        const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll, emit);

        expect(outcome.ok).toBe(true);
        expect(events).toContainEqual({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file", args: {} });
        expect(events).toContainEqual({
          type: "tool_execution_end", toolCallId: "call-1", toolName: "read_file",
          result: { toolCallId: "call-1", content: CORRUPTION_MARKER, isError: true }
        });
        expect(runSpy).not.toHaveBeenCalled();
      } finally {
        runSpy.mockRestore();
      }
    });

    it("emits an independent tool_execution_start/tool_execution_end pair per call in a parallel batch", async () => {
      const fileA = join(dir, "a.txt");
      const fileB = join(dir, "b.txt");
      await writeFile(fileA, "AAA", "utf-8");
      await writeFile(fileB, "BBB", "utf-8");
      const events: AgentEvent[] = [];
      const emit = async (e: AgentEvent) => { events.push(e); };

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: fileA }) },
          { type: "toolcall_delta", id: "call-2", delta: JSON.stringify({ path: fileB }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: fileA } },
          { type: "toolcall_end", id: "call-2", name: "read_file", arguments: { path: fileB } }
        ],
        [{ type: "text_delta", delta: "done" }]
      ]);

      const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Read both files", defaultBudget(), approveAll, emit);

      expect(outcome.ok).toBe(true);
      const starts = events.filter(e => e.type === "tool_execution_start");
      expect(starts).toHaveLength(2);
      expect(starts).toContainEqual({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file", args: { path: fileA } });
      expect(starts).toContainEqual({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read_file", args: { path: fileB } });

      const lastStartIndex = Math.max(...events.map((e, i) => (e.type === "tool_execution_start" ? i : -1)));
      const firstEndIndex = events.findIndex(e => e.type === "tool_execution_end");
      expect(firstEndIndex).toBeGreaterThan(lastStartIndex);

      const ends = events.filter(e => e.type === "tool_execution_end");
      expect(ends).toHaveLength(2);
      for (const end of ends) {
        if (end.type !== "tool_execution_end") throw new Error("unreachable");
        expect(end.result.toolCallId).toBe(end.toolCallId);
        expect(end.result.isError).toBe(false);
      }
    });

    it("updates the caller-owned todo store from a todo tool call", async () => {
      const todoStore = createTodoStore();
      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ todos: [{ id: "a", content: "A" }] }) },
          { type: "toolcall_end", id: "call-1", name: "todo", arguments: { todos: [{ id: "a", content: "A" }] } }
        ],
        [{ type: "text_delta", delta: "tracked" }]
      ]);

      const outcome = await runTurn(
        devin,
        "model-1",
        1_000_000,
        defaultSystemPrompt,
        [],
        "Track this",
        defaultBudget(),
        approveAll,
        undefined,
        { todoStore }
      );

      expect(outcome.ok).toBe(true);
      expect(todoStore.read()).toEqual([{ id: "a", content: "A", status: "pending" }]);
    });
  });

  describe("compaction", () => {
    it("proactively compacts when usage crosses the 90% threshold, then continues the turn", async () => {
      const devin = fakeProvider([
        [
          { type: "text_delta", delta: "partial" },
          { type: "usage", inputTokens: 950, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          { type: "toolcall_delta", id: "call-1", delta: "{}" },
          { type: "toolcall_end", id: "call-1", name: "loop_forever", arguments: {} }
        ],
        [{ type: "text_delta", delta: "Summary of the conversation." }],
        [{ type: "text_delta", delta: "Final answer." }]
      ]);

      const outcome = await runTurn(devin, "model-1", 1000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe("partialFinal answer.");
      expect(devin.streamChatRequests).toHaveLength(3);
      const compactionRequestMessages = devin.streamChatRequests[1]?.messages ?? [];
      const lastCompactionMessage = compactionRequestMessages.at(-1);
      expect(lastCompactionMessage?.role).toBe("user");
      expect(lastCompactionMessage?.content).toContain("CONTEXT CHECKPOINT COMPACTION");
      const finalRequestMessages = devin.streamChatRequests[2]?.messages ?? [];
      expect(finalRequestMessages[0]?.role).toBe("user");
      expect(finalRequestMessages[0]?.content).toContain("Summary of the conversation.");
    });

    it("fires compaction_start/compaction_end with reason threshold when proactive compaction happens", async () => {
      const devin = fakeProvider([
        [
          { type: "usage", inputTokens: 950, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          { type: "toolcall_delta", id: "call-1", delta: "{}" },
          { type: "toolcall_end", id: "call-1", name: "loop_forever", arguments: {} }
        ],
        [{ type: "text_delta", delta: "Summary." }],
        [{ type: "text_delta", delta: "Done." }]
      ]);
      const events: AgentEvent[] = [];
      const emit = async (e: AgentEvent) => { events.push(e); };

      const outcome = await runTurn(devin, "model-1", 1000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll, emit);

      expect(outcome.ok).toBe(true);
      expect(events.filter(e => e.type === "compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
      expect(events.filter(e => e.type === "compaction_end")).toEqual([{ type: "compaction_end", reason: "threshold" }]);
    });

    it("does not compact when usage stays below the 90% threshold", async () => {
      const devin = fakeProvider([
        [
          { type: "usage", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          { type: "text_delta", delta: "ok" }
        ]
      ]);

      const outcome = await runTurn(devin, "model-1", 1000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

      expect(outcome.ok).toBe(true);
      expect(devin.streamChatRequests).toHaveLength(1);
    });

    it("does not double-compact when a reactive 413 retry still crosses the proactive threshold in the same round", async () => {
      const devin = fakeProvider([
        { throws: new DevinApiError("too large", 413) },
        [{ type: "text_delta", delta: "compress summary" }],
        [
          { type: "usage", inputTokens: 950, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          { type: "toolcall_delta", id: "call-1", delta: "{}" },
          { type: "toolcall_end", id: "call-1", name: "loop_forever", arguments: {} }
        ],
        [{ type: "text_delta", delta: "Final answer." }]
      ]);

      const events: AgentEvent[] = [];
      const emit = async (e: AgentEvent) => { events.push(e); };

      const outcome = await runTurn(devin, "model-1", 1000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll, emit);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe("Final answer.");
      expect(devin.streamChatRequests).toHaveLength(4);
      expect(events.filter(e => e.type === "compaction_start")).toEqual([{ type: "compaction_start", reason: "overflow" }]);
      expect(events.filter(e => e.type === "compaction_end")).toEqual([{ type: "compaction_end", reason: "overflow" }]);
    });
  });
});

describe("runTurn with extensionRunner", () => {

  // Register a simple echo tool for extension tests
  beforeEach(() => {
    registry.register({
      name: "ext_echo",
      toolset: "extension",
      schema: { name: "ext_echo", description: "echos input", inputSchema: {} },
      handler: async (args) => ({
        content: `echo: ${JSON.stringify(args)}`,
        isError: false,
      }),
    });
  });

  it("a tool_call handler that blocks produces 'Blocked by extension' result with isError:true", async () => {
    const runner = createExtensionRunner();
    runner.on("tool_call", ({ toolName }) => {
      if (toolName === "ext_echo") return { block: true as const, reason: "blocked in test" };
    }, "test-ext");

    const devin = fakeProvider([
      [
        { type: "toolcall_delta", id: "call-1", delta: "{}" },
        { type: "toolcall_end", id: "call-1", name: "ext_echo", arguments: {} }
      ],
      [{ type: "text_delta", delta: "done" }]
    ]);

    const outcome = await runTurn(
      devin, "model-1", 1_000_000, defaultSystemPrompt, [], "go", defaultBudget(), approveAll,
      undefined, { extensionRunner: runner }
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    const toolMsg = outcome.messages.find(m => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (!toolMsg || toolMsg.role !== "tool") throw new Error("expected tool message");
    expect(toolMsg.isError).toBe(true);
    expect(typeof toolMsg.content === "string" && toolMsg.content.includes("Blocked by extension")).toBe(true);
    expect(typeof toolMsg.content === "string" && toolMsg.content.includes("blocked in test")).toBe(true);
  });

  it("a tool_result handler that rewrites content changes the tool message content", async () => {
    const runner = createExtensionRunner();
    runner.on("tool_result", () => ({ content: "rewritten by extension" }), "test-ext");

    const devin = fakeProvider([
      [
        { type: "toolcall_delta", id: "call-1", delta: "{}" },
        { type: "toolcall_end", id: "call-1", name: "ext_echo", arguments: {} }
      ],
      [{ type: "text_delta", delta: "done" }]
    ]);

    const outcome = await runTurn(
      devin, "model-1", 1_000_000, defaultSystemPrompt, [], "go", defaultBudget(), approveAll,
      undefined, { extensionRunner: runner }
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    const toolMsg = outcome.messages.find(m => m.role === "tool");
    expect(toolMsg?.content).toBe("rewritten by extension");
  });

  it("a throwing tool_call handler produces an error tool result for that call, not a process crash", async () => {
    const runner = createExtensionRunner();
    runner.on("tool_call", () => { throw new Error("extension crashed"); }, "test-ext");

    const devin = fakeProvider([
      [
        { type: "toolcall_delta", id: "call-1", delta: "{}" },
        { type: "toolcall_end", id: "call-1", name: "ext_echo", arguments: {} }
      ],
      [{ type: "text_delta", delta: "done" }]
    ]);

    const outcome = await runTurn(
      devin, "model-1", 1_000_000, defaultSystemPrompt, [], "go", defaultBudget(), approveAll,
      undefined, { extensionRunner: runner }
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    const toolMsg = outcome.messages.find(m => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (!toolMsg || toolMsg.role !== "tool") throw new Error("expected tool message");
    expect(toolMsg.isError).toBe(true);
    expect(typeof toolMsg.content === "string" && toolMsg.content.includes("Error")).toBe(true);
  });

  it("existing tests are unaffected when extensionRunner is omitted (undefined)", async () => {
    const devin = fakeProvider([[{ type: "text_delta", delta: "no-op" }]]);
    const outcome = await runTurn(devin, "model-1", 1_000_000, defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.assistantText).toBe("no-op");
  });
});

// ---------------------------------------------------------------------------
// runTurn with MoA
// ---------------------------------------------------------------------------

describe("runTurn with MoA", () => {
  const defaultSystemPrompt = ["test system prompt"] as const;
  const defaultBudget = () => IterationBudget.create();
  const approveAll = async () => true;

  const dualPreset: MoAPreset = {
    name: "dual",
    referenceModels: [{ model: "ref-1" }, { model: "ref-2" }],
    aggregator: { model: "agg-model" },
  };

  it("emits moa_reference_start, moa_reference_end, moa_aggregating events before turn_start, then completes", async () => {
    // round 0: ref-1 advisory, round 1: ref-2 advisory, round 2: aggregator turn
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "ref1 advice" }, { type: "done", reason: "stop" }],
      [{ type: "text_delta", delta: "ref2 advice" }, { type: "done", reason: "stop" }],
      [{ type: "text_delta", delta: "aggregated answer" }, { type: "done", reason: "stop" }],
    ]);

    const events: AgentEvent[] = [];
    const outcome = await runTurn(
      devin, "default-model", 1_000_000, defaultSystemPrompt, [], "Hello",
      defaultBudget(), approveAll,
      async event => { events.push(event); },
      { moaPreset: dualPreset },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.assistantText).toBe("aggregated answer");

    const eventTypes = events.map(e => e.type);
    const refStartIdx = eventTypes.indexOf("moa_reference_start");
    const aggIdx = eventTypes.indexOf("moa_aggregating");
    const turnStartIdx = eventTypes.indexOf("turn_start");

    expect(refStartIdx).toBeGreaterThanOrEqual(0);
    expect(aggIdx).toBeGreaterThan(refStartIdx);
    expect(turnStartIdx).toBeGreaterThan(aggIdx);

    const refStartEvents = events.filter(e => e.type === "moa_reference_start");
    expect(refStartEvents).toHaveLength(2);
    const refEndEvents = events.filter(e => e.type === "moa_reference_end");
    expect(refEndEvents).toHaveLength(2);
    const aggEvents = events.filter(e => e.type === "moa_aggregating");
    expect(aggEvents).toHaveLength(1);
  });

  it("injects MoA guidance as a user message in the aggregator's streamChat request", async () => {
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "ref1" }, { type: "done", reason: "stop" }],
      [{ type: "text_delta", delta: "ref2" }, { type: "done", reason: "stop" }],
      [{ type: "text_delta", delta: "answer" }, { type: "done", reason: "stop" }],
    ]);

    const outcome = await runTurn(
      devin, "default-model", 1_000_000, defaultSystemPrompt, [], "Hello",
      defaultBudget(), approveAll, undefined,
      { moaPreset: dualPreset },
    );

    expect(outcome.ok).toBe(true);
    // 3 streamChat calls: ref-1, ref-2, aggregator
    expect(devin.streamChatRequests).toHaveLength(3);
    const aggRequest = devin.streamChatRequests[2];
    expect(aggRequest).toBeDefined();
    if (!aggRequest) throw new Error("no agg request");
    // Find the MoA guidance user message in the aggregator's request messages
    const guidanceMsg = aggRequest.messages.find(
      m => m.role === "user" && typeof m.content === "string" && m.content.includes("Mixture of Agents")
    );
    expect(guidanceMsg).toBeDefined();
  });

  it("completes with ok:true when one reference fails", async () => {
    const devin = fakeProvider([
      { throws: new Error("model unavailable") },
      [{ type: "text_delta", delta: "ref2 advice" }, { type: "done", reason: "stop" }],
      [{ type: "text_delta", delta: "answer despite failure" }, { type: "done", reason: "stop" }],
    ]);

    const outcome = await runTurn(
      devin, "default-model", 1_000_000, defaultSystemPrompt, [], "Hello",
      defaultBudget(), approveAll, undefined,
      { moaPreset: dualPreset },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.assistantText).toBe("answer despite failure");
    // Verify the guidance injected contains a [failed: marker
    const aggRequest = devin.streamChatRequests[2];
    if (!aggRequest) throw new Error("no agg request");
    const guidanceMsg = aggRequest.messages.find(
      m => m.role === "user" && typeof m.content === "string" && m.content.includes("[failed:")
    );
    expect(guidanceMsg).toBeDefined();
  });

  it("uses aggregator model override from preset for the acting streamChat call", async () => {
    const overridePreset: MoAPreset = {
      name: "override",
      referenceModels: [{ model: "ref-only" }],
      aggregator: { model: "override-model" },
    };

    const devin = fakeProvider([
      [{ type: "text_delta", delta: "ref" }, { type: "done", reason: "stop" }],
      [{ type: "text_delta", delta: "agg" }, { type: "done", reason: "stop" }],
    ]);

    const outcome = await runTurn(
      devin, "default-model", 1_000_000, defaultSystemPrompt, [], "Hello",
      defaultBudget(), approveAll, undefined,
      { moaPreset: overridePreset },
    );

    expect(outcome.ok).toBe(true);
    // round 0 = ref-only, round 1 = aggregator
    expect(devin.streamChatRequests).toHaveLength(2);
    expect(devin.streamChatRequests[0]?.model).toBe("ref-only");
    expect(devin.streamChatRequests[1]?.model).toBe("override-model");
  });

  it("runs normally without MoA when moaPreset is not provided", async () => {
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "normal answer" }, { type: "done", reason: "stop" }],
    ]);

    const outcome = await runTurn(
      devin, "default-model", 1_000_000, defaultSystemPrompt, [], "Hello",
      defaultBudget(), approveAll,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.assistantText).toBe("normal answer");
    expect(devin.streamChatRequests).toHaveLength(1);
    expect(devin.streamChatRequests[0]?.model).toBe("default-model");
  });
});
