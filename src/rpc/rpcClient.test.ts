import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { serializeJsonLine } from "./jsonl.js";

// ESM modules are not reconfigurable — vi.mock must hoist a factory before imports resolve.
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

// Import after mocking so the mock is in place.
// dynamic import acceptable here: test-boundary module loading exercise
const { spawn } = await import("node:child_process");
const { RpcClient } = await import("./rpcClient.js");

// Build a fake child process with controllable stdin/stdout streams.
const fakeChild = (): {
  child: ChildProcess;
  childStdout: PassThrough;
} => {
  const childStdin = new PassThrough();
  const childStdout = new PassThrough();

  const child = {
    stdin: childStdin,
    stdout: childStdout,
    stderr: null,
    kill: vi.fn(),
    on: vi.fn(),
    pid: 12345,
  } as unknown as ChildProcess;

  return { child, childStdout };
};

describe("RpcClient", () => {
  let fake: { child: ChildProcess; childStdout: PassThrough };

  beforeEach(() => {
    fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawns the child with --mode rpc appended to the args", () => {
    new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });
    expect(spawn).toHaveBeenCalledWith("node", ["dist/cli.js", "--mode", "rpc"], expect.any(Object));
  });

  it("resolves call() when a matching success response arrives on stdout", async () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });

    const callPromise = client.call({ type: "get_state" });

    const response = { id: "1", type: "response", command: "get_state", success: true, data: { running: false } };
    fake.childStdout.push(Buffer.from(serializeJsonLine(response)));

    const result = await callPromise;
    expect(result).toEqual({ running: false });

    client.stop();
  });

  it("rejects call() when a matching error response arrives", async () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });

    const callPromise = client.call({ type: "prompt", message: "hello" });

    const response = { id: "1", type: "response", command: "prompt", success: false, error: "agent is already running" };
    fake.childStdout.push(Buffer.from(serializeJsonLine(response)));

    await expect(callPromise).rejects.toThrow("agent is already running");
    client.stop();
  });

  it("forwards non-response lines to event listeners", async () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });
    const events: unknown[] = [];
    client.onEvent(event => events.push(event));

    fake.childStdout.push(Buffer.from(serializeJsonLine({ type: "agent_start" })));

    // Let the data event propagate through the stream
    await Promise.resolve();

    expect(events).toEqual([{ type: "agent_start" }]);
    client.stop();
  });

  it("initializes only when requested and exposes interactive request subscriptions", async () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });
    const approvals: unknown[] = [];
    const clarifications: unknown[] = [];
    client.onApprovalRequest(request => approvals.push(request));
    client.onClarificationRequest(request => clarifications.push(request));

    const initialized = client.initialize("test-client");
    fake.childStdout.push(Buffer.from(serializeJsonLine({ id: "1", type: "response", command: "initialize", success: true, data: { version: 1, capabilities: [] } })));
    await expect(initialized).resolves.toEqual({ version: 1, capabilities: [] });
    fake.childStdout.push(Buffer.from(
      serializeJsonLine({ type: "approval_request", requestId: "a", command: "sudo x" }) +
      serializeJsonLine({ type: "clarification_request", requestId: "c", question: "Which?" }),
    ));
    await Promise.resolve();
    expect(approvals).toEqual([{ type: "approval_request", requestId: "a", command: "sudo x" }]);
    expect(clarifications).toEqual([{ type: "clarification_request", requestId: "c", question: "Which?" }]);
    client.stop();
  });

  it("unsubscribes event listener when cleanup callback is called", async () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });
    const events: unknown[] = [];
    const unsubscribe = client.onEvent(event => events.push(event));

    unsubscribe();

    fake.childStdout.push(Buffer.from(serializeJsonLine({ type: "agent_start" })));
    await Promise.resolve();

    expect(events).toHaveLength(0);
    client.stop();
  });

  it("kills the child process when stop() is called", () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });
    client.stop();
    expect(fake.child.kill).toHaveBeenCalled();
  });

  it("resolves sequential calls independently, regardless of response order", async () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });

    const p1 = client.call({ type: "get_state" });
    const p2 = client.call({ type: "get_messages" });

    // Respond to id "2" first, then "1"
    fake.childStdout.push(Buffer.from(
      serializeJsonLine({ id: "2", type: "response", command: "get_messages", success: true, data: { messages: [] } }) +
      serializeJsonLine({ id: "1", type: "response", command: "get_state", success: true, data: { running: false } }),
    ));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ running: false });
    expect(r2).toEqual({ messages: [] });

    client.stop();
  });

  it("ignores malformed JSON lines silently", async () => {
    const client = new RpcClient({ cliPath: "node", args: ["dist/cli.js"] });
    const events: unknown[] = [];
    client.onEvent(e => events.push(e));

    fake.childStdout.push(Buffer.from("not json\n"));
    await Promise.resolve();

    expect(events).toHaveLength(0);
    client.stop();
  });
});
