import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import { DevinApiError } from "widevin";
import { runTurn } from "./turn.js";
import { registry } from "../tools/index.js";
import { CORRUPTION_MARKER } from "./toolDispatch.js";
import { IterationBudget, ITERATION_LIMIT_MESSAGE } from "./iterationBudget.js";

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
  it("accumulates text_delta events, streams via onDelta, and appends user+assistant messages", async () => {
    const devin = fakeProvider([
      [
        { type: "text_delta", delta: "Hel" },
        { type: "text_delta", delta: "lo" },
        { type: "done", reason: "stop" }
      ]
    ]);
    const deltas: string[] = [];

    const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll, {
      onDelta: d => deltas.push(d)
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

    const outcome = await runTurn(devin, "model-1", systemPrompt, [], "Hi", defaultBudget(), approveAll);

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

    const outcome = await runTurn(devin, "model-1", systemPrompt, [], "Hi", defaultBudget(), approveAll);

    expect(outcome.ok).toBe(true);
    expect(devin.streamChatRequests).toHaveLength(3);
    expect(devin.streamChatRequests.map(request => request.systemPrompt)).toEqual([
      systemPrompt,
      systemPrompt,
      systemPrompt
    ]);
  });

  it("keeps prior history intact and appends the new turn on success", async () => {
    const devin = fakeProvider([[{ type: "text_delta", delta: "Alex" }]]);
    const priorHistory = [
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: [{ type: "text", text: "Nice to meet you, Alex" }] }
    ] as const;

    const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, priorHistory, "What is my name?", defaultBudget(), approveAll);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.messages.slice(0, 2)).toEqual(priorHistory);
    expect(outcome.messages).toHaveLength(4);
  });

  it("returns ok:false and leaves the caller's history untouched when streamChat throws", async () => {
    const boom = new DevinApiError("network blip", 400);
    const devin = fakeProvider([{ throws: boom }]);

    const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

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

      const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);

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

      const outcomePromise = runTurn(devin, "model-1", defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);
      await vi.runAllTimersAsync();
      const outcome = await outcomePromise;

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up and returns ok:false after exhausting every retry attempt", async () => {
    vi.useFakeTimers();
    try {
      const err = new Error("persistent failure");
      const devin = fakeProvider([{ throws: err }, { throws: err }, { throws: err }]);

      const outcomePromise = runTurn(devin, "model-1", defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll);
      await vi.runAllTimersAsync();
      const outcome = await outcomePromise;

      expect(outcome).toEqual({ ok: false, error: err });
    } finally {
      vi.useRealTimers();
    }
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

      const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "What is the secret?", defaultBudget(), approveAll);

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

    it("passes confirmShellCommand through to a run_shell_command tool call", async () => {
      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ command: "echo turn-test" }) },
          { type: "toolcall_end", id: "call-1", name: "run_shell_command", arguments: { command: "echo turn-test" } }
        ],
        [{ type: "text_delta", delta: "Ran it." }]
      ]);
      const confirmShellCommand = vi.fn(async () => true);

      const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "Run echo turn-test", defaultBudget(), confirmShellCommand);

      expect(confirmShellCommand).toHaveBeenCalledWith("echo turn-test");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const toolMessage = outcome.messages.find(m => m.role === "tool");
      expect(toolMessage).toBeDefined();
      if (!toolMessage || toolMessage.role !== "tool") throw new Error("expected tool message");
      expect(toolMessage.isError).toBe(false);
    });

    it("stops after exhausting the iteration budget and appends the limit message", async () => {
      const budget = IterationBudget.create(3);
      const rounds: FakeRound[] = Array.from({ length: 3 }, (_, i) => [
        { type: "toolcall_delta", id: `call-${i}`, delta: "{}" },
        { type: "toolcall_end", id: `call-${i}`, name: "loop_forever", arguments: {} }
      ]);
      const devin = fakeProvider(rounds);
      const streamChatSpy = vi.spyOn(devin, "streamChat");

      const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "Loop forever", budget, approveAll);

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

      const outcomePromise = runTurn(devin, "model-1", defaultSystemPrompt, [], "Read both files", defaultBudget(), approveAll);

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

      const outcomePromise = runTurn(devin, "model-1", defaultSystemPrompt, [], "Read the same file twice", defaultBudget(), approveAll);

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

    it("fires onToolStart before onToolComplete for a sequential read_file call", async () => {
      const filePath = join(dir, "secret.txt");
      await writeFile(filePath, "the secret is 42", "utf-8");
      const onToolStart = vi.fn();
      const onToolComplete = vi.fn();

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: filePath }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: filePath } }
        ],
        [{ type: "text_delta", delta: "The secret is 42." }]
      ]);

      const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "What is the secret?", defaultBudget(), approveAll, {
        onToolStart,
        onToolComplete
      });

      expect(outcome.ok).toBe(true);
      expect(onToolStart).toHaveBeenCalledExactlyOnceWith("read_file", { path: filePath });
      expect(onToolComplete).toHaveBeenCalledExactlyOnceWith("read_file", { path: filePath }, false);
      const [startOrder] = onToolStart.mock.invocationCallOrder;
      const [completeOrder] = onToolComplete.mock.invocationCallOrder;
      expect(startOrder).toBeDefined();
      expect(completeOrder).toBeDefined();
      if (startOrder === undefined || completeOrder === undefined) throw new Error("unreachable");
      expect(startOrder).toBeLessThan(completeOrder);
    });

    it("fires onToolStart/onToolComplete with empty args and isError true for a corrupted tool call", async () => {
      const onToolStart = vi.fn();
      const onToolComplete = vi.fn();
      const runSpy = vi.spyOn(registry, "run");
      try {
        const devin = fakeProvider([
          [
            { type: "toolcall_delta", id: "call-1", delta: '{"path": "a.txt"' },
            { type: "toolcall_end", id: "call-1", name: "read_file", arguments: {} }
          ],
          [{ type: "text_delta", delta: "ok" }]
        ]);

        const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "Hi", defaultBudget(), approveAll, {
          onToolStart,
          onToolComplete
        });

        expect(outcome.ok).toBe(true);
        expect(onToolStart).toHaveBeenCalledExactlyOnceWith("read_file", {});
        expect(onToolComplete).toHaveBeenCalledExactlyOnceWith("read_file", {}, true);
        expect(runSpy).not.toHaveBeenCalled();
      } finally {
        runSpy.mockRestore();
      }
    });

    it("collapses a parallel batch into a single __batch__ onToolStart/onToolComplete pair", async () => {
      const fileA = join(dir, "a.txt");
      const fileB = join(dir, "b.txt");
      await writeFile(fileA, "AAA", "utf-8");
      await writeFile(fileB, "BBB", "utf-8");
      const onToolStart = vi.fn();
      const onToolComplete = vi.fn();

      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: fileA }) },
          { type: "toolcall_delta", id: "call-2", delta: JSON.stringify({ path: fileB }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: fileA } },
          { type: "toolcall_end", id: "call-2", name: "read_file", arguments: { path: fileB } }
        ],
        [{ type: "text_delta", delta: "done" }]
      ]);

      const outcome = await runTurn(devin, "model-1", defaultSystemPrompt, [], "Read both files", defaultBudget(), approveAll, {
        onToolStart,
        onToolComplete
      });

      expect(outcome.ok).toBe(true);
      expect(onToolStart).toHaveBeenCalledExactlyOnceWith("__batch__", { count: 2 });
      expect(onToolComplete).toHaveBeenCalledExactlyOnceWith("__batch__", { count: 2 }, false);
      expect(onToolStart).not.toHaveBeenCalledWith("read_file", expect.anything());
      expect(onToolComplete).not.toHaveBeenCalledWith("read_file", expect.anything(), expect.anything());
    });
  });
});
