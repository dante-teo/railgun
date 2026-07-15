import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import type { DevinSession } from "../session.js";
import type { AppConfig } from "../config.js";
import { configuredAgentActivity, runRpcMode } from "./rpcMode.js";
import type { SessionStore } from "../persistence/sessionStore.js";

type FakeRound = readonly DevinStreamEvent[];
type OutputLine = Record<string, unknown>;

const fakeProvider = (rounds: readonly FakeRound[]): DevinProvider => {
  let callIndex = 0;
  return {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(),
    listModels: vi.fn(async () => []),
    streamChat: async function* () {
      const round = rounds[callIndex++];
      if (!round) return;
      for (const event of round) yield event;
    },
  };
};

/** A provider whose streamChat blocks until `release()` is called; signals entry via the returned promise. */
const makeGatedProvider = (opts: { signal?: boolean } = {}): {
  devin: DevinProvider;
  entered: Promise<void>;
  release: () => void;
} => {
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  const { promise: releaseGate, resolve: release } = Promise.withResolvers<void>();
  const devin: DevinProvider = {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(async () => []),
    streamChat: async function* (req) {
      signalEntered();
      await releaseGate;
      if (opts.signal && req.signal?.aborted) return;
      yield { type: "done", reason: "stop" } as const;
    },
  };
  return { devin, entered, release };
};

const fakeSession = (devin: DevinProvider): DevinSession => ({
  devin,
  model: {
    id: "test-model", name: "Test Model", provider: "devin" as const,
    baseUrl: "https://api.example.com", input: ["text"] as const,
    supportsTools: true as const, contextWindow: 100_000, maxTokens: 4096, reasoning: false,
  },
  systemPrompt: [],
});

const fakeConfig = (): AppConfig => ({ model: null, approvalMode: "off" });

describe("RPC configured agent activity", () => {
  it("forwards the active MoA preset and enabled advisor", () => {
    expect(configuredAgentActivity({
      ...fakeConfig(), activeMoaPreset: "desktop", moaPresets: {
        desktop: { referenceModels: [{ model: "ref-a" }, { model: "ref-b" }], aggregator: { model: "agg" } },
      }, advisor: { enabled: true, model: "reviewer" },
    })).toEqual({
      moaPreset: { name: "desktop", referenceModels: [{ model: "ref-a" }, { model: "ref-b" }], aggregator: { model: "agg" } },
      advisor: { model: "reviewer" },
    });
  });

  it("preserves existing behavior when activity configuration is absent or disabled", () => {
    expect(configuredAgentActivity(fakeConfig())).toEqual({});
    expect(configuredAgentActivity({ ...fakeConfig(), advisor: { enabled: false, model: "reviewer" } })).toEqual({});
  });
});

/** Collects all JSONL output from a PassThrough and parses them on demand. */
const collectOutput = (stream: PassThrough): (() => OutputLine[]) => {
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => { chunks.push(chunk.toString("utf-8")); });
  return () => chunks.join("").split("\n").filter(l => l.length > 0).map(l => JSON.parse(l) as OutputLine);
};

/** Pushes a single JSONL command line onto stdin. */
const send = (stdin: PassThrough, cmd: object): void => {
  stdin.push(Buffer.from(JSON.stringify(cmd) + "\n"));
};

/** Pushes JSONL commands then closes stdin with EOF. */
const sendAndClose = (stdin: PassThrough, ...commands: object[]): void => {
  for (const cmd of commands) send(stdin, cmd);
  stdin.push(null);
};

const waitForLine = async (getLines: () => OutputLine[], predicate: (line: OutputLine) => boolean): Promise<OutputLine> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const line = getLines().find(predicate);
    if (line !== undefined) return line;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for RPC output");
};

const fakeSessionStore = (): SessionStore => ({
  db: {} as SessionStore["db"],
  loadSession: vi.fn(),
  listSessions: vi.fn(() => []),
  saveCheckpoint: vi.fn(checkpoint => checkpoint),
  branch: vi.fn(),
  branchWithSummary: vi.fn(async () => {}),
  forkSession: vi.fn(() => "fork-id"),
  getActiveBranchMessageIds: vi.fn(() => []),
  getRecentMessages: vi.fn(() => []),
  close: vi.fn(),
});

describe("runRpcMode", () => {
  it("finishes compaction on its original session before activating a new session", async () => {
    const { promise: compactionEntered, resolve: signalCompactionEntered } = Promise.withResolvers<void>();
    const { promise: releaseCompaction, resolve: release } = Promise.withResolvers<void>();
    let callCount = 0;
    const devin: DevinProvider = {
      login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(async () => []),
      streamChat: async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield { type: "text_delta", delta: "first answer" } as const;
          yield { type: "done", reason: "stop" } as const;
          return;
        }
        signalCompactionEntered();
        await releaseCompaction;
        yield { type: "text_delta", delta: "summary" } as const;
        yield { type: "done", reason: "stop" } as const;
      },
    };
    const store = fakeSessionStore();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);
    const ids = ["session-a", "session-b"];
    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout, sessionStore: store, randomId: () => ids.shift()! });

    send(stdin, { id: "init", type: "initialize", version: 1 });
    send(stdin, { id: "prompt", type: "prompt", message: "first" });
    await waitForLine(getLines, line => line["id"] === "prompt");
    send(stdin, { id: "compact", type: "compact" });
    await compactionEntered;
    send(stdin, { id: "new", type: "session_new" });
    await Promise.resolve();
    expect(getLines().find(line => line["id"] === "new")).toBeUndefined();
    release();
    await waitForLine(getLines, line => line["id"] === "new");
    send(stdin, { id: "state", type: "get_state" });
    await waitForLine(getLines, line => line["id"] === "state");
    stdin.push(null);
    await runPromise;

    expect(getLines().find(line => line["id"] === "state")).toMatchObject({ data: { sessionId: "session-b", messageCount: 0, persistence: "unsaved" } });
    expect(vi.mocked(store.saveCheckpoint).mock.calls.every(([checkpoint]) => checkpoint.id === "session-a")).toBe(true);
  });

  it("moves a saved transcript to new session metadata when its model changes", async () => {
    const devin = fakeProvider([[{ type: "text_delta", delta: "answer" }, { type: "done", reason: "stop" }]]);
    const store = fakeSessionStore();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);
    const ids = ["session-a", "session-b"];
    const resolveModelRuntime = vi.fn(async (modelId: string): Promise<DevinSession> => ({
      ...fakeSession(devin),
      model: { ...fakeSession(devin).model, id: modelId, contextWindow: 42_000 },
      systemPrompt: [`system:${modelId}`],
    }));
    const rpcOptions = { session: fakeSession(devin), config: fakeConfig(), stdin, stdout, sessionStore: store, randomId: () => ids.shift()!, resolveModelRuntime };
    const runPromise = runRpcMode(rpcOptions);

    send(stdin, { id: "init", type: "initialize", version: 1 });
    send(stdin, { id: "prompt", type: "prompt", message: "hello" });
    await waitForLine(getLines, line => line["id"] === "prompt");
    send(stdin, { id: "model", type: "set_model", modelId: "other-model" });
    await waitForLine(getLines, line => line["id"] === "model");
    send(stdin, { id: "save", type: "session_save" });
    await waitForLine(getLines, line => line["id"] === "save");
    send(stdin, { id: "state", type: "get_state" });
    stdin.push(null);
    await runPromise;

    expect(resolveModelRuntime).toHaveBeenCalledWith("other-model");
    expect(vi.mocked(store.saveCheckpoint).mock.calls.map(([checkpoint]) => ({ id: checkpoint.id, model: checkpoint.model })))
      .toEqual([{ id: "session-a", model: "test-model" }, { id: "session-b", model: "other-model" }]);
    expect(getLines().find(line => line["id"] === "state")).toMatchObject({ data: { sessionId: "session-b", model: "other-model", persistence: "saved" } });
  });

  it("uses resolved model metadata and system prompt after loading a session", async () => {
    const requests: Array<{ model: string; systemPrompt?: readonly string[] }> = [];
    const devin: DevinProvider = {
      login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(async () => []),
      streamChat: async function* (request) {
        requests.push({ model: request.model, ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }) });
        yield { type: "text_delta", delta: "continued" } as const;
        yield { type: "done", reason: "stop" } as const;
      },
    };
    const store = fakeSessionStore();
    vi.mocked(store.loadSession).mockReturnValue({
      id: "saved", model: "loaded-model", startedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: [{ type: "toolCall", id: "private", name: "shell", arguments: { secret: "x".repeat(100_000) } }, { type: "text", text: "answer" }] },
        { role: "tool", toolCallId: "private", content: "y".repeat(100_000), isError: false },
      ],
      todos: [],
    });
    const loadedRuntime: DevinSession = {
      ...fakeSession(devin),
      model: { ...fakeSession(devin).model, id: "loaded-model", contextWindow: 8_192 },
      systemPrompt: ["loaded-model-system"],
    };
    const resolveModelRuntime = vi.fn(async () => loadedRuntime);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);
    const rpcOptions = { session: fakeSession(devin), config: fakeConfig(), stdin, stdout, sessionStore: store, resolveModelRuntime };
    const runPromise = runRpcMode(rpcOptions);

    send(stdin, { id: "init", type: "initialize", version: 1 });
    send(stdin, { id: "load", type: "session_load", sessionId: "saved", includeMessages: false });
    const load = await waitForLine(getLines, line => line["id"] === "load");
    expect(load).toMatchObject({ success: true, data: { sessionId: "saved" } });
    expect(JSON.stringify(load)).not.toContain("messages");
    send(stdin, { id: "transcript", type: "session_transcript", sessionId: "saved", cursor: 0, limit: 100 });
    const transcript = await waitForLine(getLines, line => line["id"] === "transcript");
    expect(transcript).toMatchObject({ data: { sessionId: "saved", messages: [{ role: "user", text: "old" }, { role: "assistant", text: "answer" }] } });
    expect(JSON.stringify(transcript)).not.toMatch(/secret|private|yyyy/u);
    send(stdin, { id: "prompt", type: "prompt", message: "continue" });
    await waitForLine(getLines, line => line["id"] === "prompt");
    stdin.push(null);
    await runPromise;

    expect(resolveModelRuntime).toHaveBeenCalledWith("loaded-model");
    expect(requests[0]).toMatchObject({ model: "loaded-model", systemPrompt: expect.arrayContaining(["loaded-model-system"]) });
  });

  it("negotiates protocol v1 and reports capabilities plus active session metadata", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);
    const runPromise = runRpcMode({ session: fakeSession(fakeProvider([])), config: fakeConfig(), stdin, stdout, randomId: () => "session-1", now: () => new Date("2026-01-02T03:04:05Z") });
    sendAndClose(stdin, { id: "init", type: "initialize", version: 1 }, { id: "state", type: "get_state" });
    await runPromise;

    expect(getLines().find(line => line["id"] === "init")).toMatchObject({ success: true, data: { version: 1, capabilities: expect.arrayContaining(["sessions", "memory", "notes"]) } });
    expect(getLines().find(line => line["id"] === "state")).toMatchObject({ data: { sessionId: "session-1", startedAt: "2026-01-02T03:04:05.000Z", persistence: "unsaved" } });
  });

  it("rejects unsupported initialization without leaving legacy mode", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);
    const runPromise = runRpcMode({ session: fakeSession(fakeProvider([])), config: fakeConfig(), stdin, stdout });
    sendAndClose(stdin, { id: "bad", type: "initialize", version: 9 }, { id: "state", type: "get_state" });
    await runPromise;
    expect(getLines().find(line => line["id"] === "bad")).toMatchObject({ success: false, error: expect.stringContaining("unsupported protocol version") });
    expect((getLines().find(line => line["id"] === "state")?.["data"] as Record<string, unknown>)).not.toHaveProperty("protocolVersion");
  });

  it("automatically checkpoints a completed v1 transcript", async () => {
    const store = fakeSessionStore();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);
    const devin = fakeProvider([[{ type: "text_delta", delta: "hello" }, { type: "done", reason: "stop" }]]);
    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout, sessionStore: store, randomId: () => "session-1" });
    send(stdin, { id: "init", type: "initialize", version: 1 });
    send(stdin, { id: "prompt", type: "prompt", message: "hello" });
    await waitForLine(getLines, line => line["id"] === "prompt");
    sendAndClose(stdin, { id: "state", type: "get_state" });
    await runPromise;

    expect(store.saveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1", messages: expect.arrayContaining([expect.objectContaining({ role: "user" })]) }));
    expect(getLines().find(line => line["id"] === "state")).toMatchObject({ data: { persistence: "saved" } });
  });

  it("round-trips a v1 shell approval request and denial", async () => {
    const devin = fakeProvider([
      [{ type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ command: "sudo echo rpc-test" }) }, { type: "toolcall_end", id: "call-1", name: "run_shell_command", arguments: { command: "sudo echo rpc-test" } }],
      [{ type: "text_delta", delta: "Denied." }, { type: "done", reason: "stop" }],
    ]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);
    const ids = ["session-1", "approval-1"];
    const runPromise = runRpcMode({ session: fakeSession(devin), config: { ...fakeConfig(), approvalMode: "manual" }, stdin, stdout, sessionStore: fakeSessionStore(), randomId: () => ids.shift()! });
    send(stdin, { id: "init", type: "initialize", version: 1 });
    send(stdin, { id: "prompt", type: "prompt", message: "run it" });
    await waitForLine(getLines, line => line["type"] === "approval_request");
    send(stdin, { id: "approval-response", type: "approval_response", requestId: "approval-1", approved: false });
    await waitForLine(getLines, line => line["id"] === "prompt");
    stdin.push(null);
    await runPromise;

    expect(getLines().find(line => line["type"] === "approval_request")).toMatchObject({ requestId: "approval-1", command: "sudo echo rpc-test" });
    expect(getLines().find(line => line["id"] === "approval-response")).toMatchObject({ success: true });
  });
  it("responds to prompt command with success after agent finishes", async () => {
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "4" }, { type: "done", reason: "stop" }],
    ]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });
    sendAndClose(stdin, { id: "1", type: "prompt", message: "What is 2+2?" });

    await runPromise;
    const response = getLines().find(l => l["type"] === "response" && l["command"] === "prompt");
    expect(response).toMatchObject({ id: "1", type: "response", command: "prompt", success: true });
  });

  it("emits at least one agent_start event during a prompt run", async () => {
    const devin = fakeProvider([[{ type: "done", reason: "stop" }]]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });
    sendAndClose(stdin, { id: "1", type: "prompt", message: "hello" });

    await runPromise;
    expect(getLines().some(l => l["type"] === "agent_start")).toBe(true);
  });

  it("responds to get_state with running=false and correct model when idle", async () => {
    const devin = fakeProvider([]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });
    sendAndClose(stdin, { id: "2", type: "get_state" });

    await runPromise;
    const response = getLines().find(l => l["type"] === "response" && l["command"] === "get_state");
    expect(response).toMatchObject({
      id: "2",
      type: "response",
      command: "get_state",
      success: true,
      data: expect.objectContaining({ running: false, model: "test-model", messageCount: 0 }),
    });
  });

  it("responds to get_messages with empty array before any prompts", async () => {
    const devin = fakeProvider([]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });
    sendAndClose(stdin, { id: "3", type: "get_messages" });

    await runPromise;
    const response = getLines().find(l => l["type"] === "response" && l["command"] === "get_messages");
    expect(response).toMatchObject({ id: "3", success: true, data: { messages: [] } });
  });

  it("responds with parse_error on invalid JSON input", async () => {
    const devin = fakeProvider([]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });
    stdin.push(Buffer.from("not valid json\n"));
    stdin.push(null);

    await runPromise;
    expect(
      getLines().some(l => l["type"] === "response" && l["success"] === false && /parse_error/i.test(String(l["error"]))),
    ).toBe(true);
  });

  it("responds with error for a command with missing type field", async () => {
    const devin = fakeProvider([]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });
    sendAndClose(stdin, { id: "x", something: "else" });

    await runPromise;
    expect(getLines().some(l => l["type"] === "response" && l["success"] === false)).toBe(true);
  });

  it("rejects a second prompt command while one is already running", async () => {
    const { devin, entered, release } = makeGatedProvider();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });

    send(stdin, { id: "1", type: "prompt", message: "first" });
    await entered;

    send(stdin, { id: "2", type: "prompt", message: "second" });
    await Promise.resolve();
    release();
    stdin.push(null);

    await runPromise;
    const lines = getLines();
    expect(lines.find(l => l["command"] === "prompt" && l["id"] === "1")).toMatchObject({ success: true });
    expect(lines.find(l => l["command"] === "prompt" && l["id"] === "2")).toMatchObject({ success: false, error: expect.stringMatching(/running/i) });
  });

  it("handles abort command while prompt is running", async () => {
    const { devin, entered, release } = makeGatedProvider({ signal: true });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });

    send(stdin, { id: "1", type: "prompt", message: "long task" });
    await entered;

    send(stdin, { id: "2", type: "abort" });
    await Promise.resolve();
    release();
    stdin.push(null);

    await runPromise;
    expect(getLines().find(l => l["command"] === "abort" && l["id"] === "2")).toMatchObject({ success: true });
  });

  it("responds with error when steer is called while not running", async () => {
    const devin = fakeProvider([]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });
    sendAndClose(stdin, { id: "5", type: "steer", message: "nudge" });

    await runPromise;
    const response = getLines().find(l => l["command"] === "steer" && l["id"] === "5");
    expect(response).toMatchObject({ success: false, error: expect.stringMatching(/not running/i) });
  });

  it("handles steer while running and responds with success", async () => {
    const { devin, entered, release } = makeGatedProvider();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const getLines = collectOutput(stdout);

    const runPromise = runRpcMode({ session: fakeSession(devin), config: fakeConfig(), stdin, stdout });

    send(stdin, { id: "1", type: "prompt", message: "start" });
    await entered;

    send(stdin, { id: "2", type: "steer", message: "redirect" });
    await Promise.resolve();
    release();
    stdin.push(null);

    await runPromise;
    expect(getLines().find(l => l["command"] === "steer" && l["id"] === "2")).toMatchObject({ success: true });
  });
});
