import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import type { DevinSession } from "../session.js";
import type { AppConfig } from "../config.js";
import { runRpcMode } from "./rpcMode.js";

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

const fakeConfig = (): AppConfig => ({ model: null, defaultProjectTrust: "ask", approvalMode: "off" });

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

describe("runRpcMode", () => {
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
