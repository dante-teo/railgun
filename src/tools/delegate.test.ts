import { describe, expect, it } from "vitest";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import { registry } from "./index.js";
import "./delegate.js";
import type { ToolContext } from "./registry.js";
import type { AgentEvent } from "../agent/events.js";
import { createRuntimeContext } from "../runtime.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

type StreamChatRequest = Parameters<DevinProvider["streamChat"]>[0];
type FakeRound = readonly DevinStreamEvent[] | { throws: unknown };

const fakeProvider = (rounds: readonly FakeRound[]): DevinProvider & { streamChatRequests: StreamChatRequest[] } => {
  let callIndex = 0;
  const streamChatRequests: StreamChatRequest[] = [];
  const provider: DevinProvider & { streamChatRequests: StreamChatRequest[] } = {
    login: async () => "fake-token",
    setToken: async () => {},
    clearToken: async () => {},
    listModels: async () => [],
    streamChatRequests,
    streamChat: async function* (request: StreamChatRequest) {
      streamChatRequests.push(request);
      const round = rounds[callIndex++];
      if (!round) throw new Error(`streamChat called more times (call ${callIndex}) than scripted (${rounds.length})`);
      if ("throws" in round) throw round.throws;
      for (const event of round) yield event;
    },
  };
  return provider;
};

const textRound = (text: string): readonly DevinStreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "done", reason: "stop" },
];

const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  commandApprovalMode: "manual",
  sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => { throw new Error("confirmShellCommand should not be called"); },
  devin: fakeProvider([textRound("default child answer")]),
  model: "test-model",
  contextWindow: 1_000_000,
  delegationDepth: 0,
  ...overrides,
});

// Context without devin — used to test the "missing devin" error path.
const makeContextWithoutDevin = (): Omit<ToolContext, "devin"> => ({
  signal: new AbortController().signal,
  commandApprovalMode: "manual",
  sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => { throw new Error("confirmShellCommand should not be called"); },
  model: "test-model",
  contextWindow: 1_000_000,
  delegationDepth: 0,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegate_task", () => {
  it("1. is registered in the 'delegation' toolset schema", () => {
    const schemas = registry.getSchemas(["delegation"]);
    expect(schemas.some(s => s.name === "delegate_task")).toBe(true);
  });

  it("2. single child completes and returns result", async () => {
    const devin = fakeProvider([textRound("child answer")]);
    const ctx = makeContext({ devin });

    const result = await registry.run("delegate_task", { goal: "summarize foo" }, ctx);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as { task: string; result: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.task).toBe("summarize foo");
    expect(parsed[0]?.result).toBe("child answer");
  });

  it("3. multiple tasks run concurrently and both complete", async () => {
    const devin = fakeProvider([textRound("result A"), textRound("result B")]);
    const ctx = makeContext({ devin });

    const result = await registry.run(
      "delegate_task",
      { tasks: [{ goal: "task A" }, { goal: "task B" }] },
      ctx,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as { task: string; result: string }[];
    expect(parsed).toHaveLength(2);
    const taskA = parsed.find(p => p.task === "task A");
    const taskB = parsed.find(p => p.task === "task B");
    expect(taskA?.result).toBe("result A");
    expect(taskB?.result).toBe("result B");
  });

  it("4. leaf child toolset excludes 'delegation'", async () => {
    const devin = fakeProvider([textRound("leaf done")]);
    const ctx = makeContext({ devin });

    await registry.run("delegate_task", { goal: "leaf task", role: "leaf" }, ctx);

    const childRequest = devin.streamChatRequests[0];
    expect(childRequest).toBeDefined();
    const toolNames = (childRequest?.tools ?? []).map(t => t.name);
    expect(toolNames).not.toContain("delegate_task");
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("web_fetch");
    expect(toolNames).toContain("railgun_inspect");
  });

  it("retains the parent's runtime surface in delegated prompts and tool context", async () => {
    const devin = fakeProvider([textRound("child done")]);
    const runtime = createRuntimeContext("desktop", "/tmp/delegated-railgun");
    await registry.run("delegate_task", { goal: "inspect" }, makeContext({ devin, runtime }));
    const systemPrompt = devin.streamChatRequests[0]?.systemPrompt;
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt?.join("\n")).toContain('Surface: "desktop"');
    expect(systemPrompt?.join("\n")).toContain('Railgun home: "/tmp/delegated-railgun"');
  });

  it("5. orchestrator child at depth 0 gets 'delegation' toolset", async () => {
    // depth 0 parent → child depth 1, below MAX_SPAWN_DEPTH (2) → gets delegation
    const devin = fakeProvider([textRound("orchestrator done")]);
    const ctx = makeContext({ devin, delegationDepth: 0 });

    await registry.run("delegate_task", { goal: "orchestrate task", role: "orchestrator" }, ctx);

    const childRequest = devin.streamChatRequests[0];
    expect(childRequest).toBeDefined();
    const toolNames = (childRequest?.tools ?? []).map(t => t.name);
    expect(toolNames).toContain("delegate_task");
  });

  it("6. max depth exceeded returns error", async () => {
    const ctx = makeContext({ delegationDepth: 2 });

    const result = await registry.run("delegate_task", { goal: "too deep" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Maximum delegation depth/);
  });

  it("7. missing devin in context returns error", async () => {
    const ctx = makeContextWithoutDevin() as ToolContext;

    const result = await registry.run("delegate_task", { goal: "some task" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/DevinProvider/);
  });

  it("8. parent abort propagates to child — child signal aborted when parent signal aborts", async () => {
    const parentController = new AbortController();
    let childSignalObserved: AbortSignal | undefined;
    let childReceivedAbort = false;

    // Provider that triggers the parent abort synchronously then checks child signal.
    // No real timers needed: Promise.resolve() is a single microtask boundary.
    const abortCapturingProvider: DevinProvider & { streamChatRequests: StreamChatRequest[] } = {
      login: async () => "fake-token",
      setToken: async () => {},
      clearToken: async () => {},
      listModels: async () => [],
      streamChatRequests: [],
      streamChat: async function* (request: StreamChatRequest) {
        abortCapturingProvider.streamChatRequests.push(request);
        childSignalObserved = request.signal;

        // Abort the parent — the listener in runOneChild forwards to childController.
        parentController.abort(new DOMException("Stopped", "AbortError"));

        // Yield to the microtask queue so the abort event listener fires.
        await Promise.resolve();

        childReceivedAbort = request.signal?.aborted ?? false;

        if (request.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield { type: "text_delta" as const, delta: "never" };
        yield { type: "done" as const, reason: "stop" as const };
      },
    };

    const ctx = makeContext({
      devin: abortCapturingProvider,
      signal: parentController.signal,
    });

    const result = await registry.run("delegate_task", { goal: "long running" }, ctx);

    expect(childSignalObserved).toBeDefined();
    expect(childReceivedAbort).toBe(true);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as { task: string; result: string }[];
    expect(parsed[0]?.result).toMatch(/subagent aborted|subagent error/);
  });

  it("9. concurrency cap: no more than 3 children run simultaneously", async () => {
    let concurrent = 0;
    let peakConcurrent = 0;
    let totalStarted = 0;

    // Yield a single microtask boundary between concurrent starts so siblings can
    // accumulate before the first one finishes. No real wall-clock delay needed.
    const timingProvider: DevinProvider & { streamChatRequests: StreamChatRequest[] } = {
      login: async () => "fake-token",
      setToken: async () => {},
      clearToken: async () => {},
      listModels: async () => [],
      streamChatRequests: [],
      streamChat: async function* (request: StreamChatRequest) {
        timingProvider.streamChatRequests.push(request);
        totalStarted++;
        concurrent++;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        await Promise.resolve();
        concurrent--;
        yield { type: "text_delta" as const, delta: "done" };
        yield { type: "done" as const, reason: "stop" as const };
      },
    };

    const ctx = makeContext({ devin: timingProvider });

    await registry.run(
      "delegate_task",
      { tasks: [
        { goal: "t1" }, { goal: "t2" }, { goal: "t3" },
        { goal: "t4" }, { goal: "t5" },
      ]},
      ctx,
    );

    expect(totalStarted).toBe(5);
    expect(peakConcurrent).toBeLessThanOrEqual(3);
  });

  it("10. invalid args — no goal and no tasks — returns error", async () => {
    const ctx = makeContext();

    const result = await registry.run("delegate_task", {}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/requires either/);
  });

  it("10b. invalid args — both goal and tasks — returns error", async () => {
    const ctx = makeContext();

    const result = await registry.run(
      "delegate_task",
      { goal: "foo", tasks: [{ goal: "bar" }] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/either.*or.*not both/i);
  });

  it("emits subagent_start and subagent_end events", async () => {
    const devin = fakeProvider([textRound("result")]);
    const events: AgentEvent[] = [];
    const ctx = makeContext({
      devin,
      emit: async (event) => { events.push(event); },
    });

    await registry.run("delegate_task", { goal: "emit test" }, ctx);

    const startEvent = events.find(e => e.type === "subagent_start");
    const endEvent = events.find(e => e.type === "subagent_end");
    expect(startEvent).toBeDefined();
    expect(endEvent).toBeDefined();
    if (startEvent?.type === "subagent_start") {
      expect(startEvent.goal).toBe("emit test");
      expect(startEvent.index).toBe(0);
      expect(startEvent.count).toBe(1);
    }
    if (endEvent?.type === "subagent_end") {
      expect(endEvent.goal).toBe("emit test");
      expect(endEvent.result).toBe("result");
    }
  });
});
