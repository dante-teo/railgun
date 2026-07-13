import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = resolve(import.meta.dirname, "backend.ts");

const startMock = (scenario: string): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ["--import", "tsx", entry, scenario], { stdio: ["pipe", "pipe", "pipe"] });

const nextLine = (child: ChildProcessWithoutNullStreams): Promise<{ readonly line: string; readonly chunks: number }> =>
  new Promise((resolveLine, reject) => {
    let buffer = "";
    let chunks = 0;
    const onData = (chunk: Buffer): void => {
      chunks += 1;
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolveLine({ line: buffer.slice(0, newline), chunks });
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`mock exited before a frame with code ${String(code)}`));
    };
    const cleanup = (): void => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });

const send = (child: ChildProcessWithoutNullStreams, value: unknown): void => {
  child.stdin.write(`${JSON.stringify(value)}\n`);
};

const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise((resolveExit) => child.once("exit", resolveExit));

const expectNoOutput = (child: ChildProcessWithoutNullStreams, durationMs = 70): Promise<void> =>
  new Promise((resolveQuiet, reject) => {
    const onData = (chunk: Buffer): void => {
      clearTimeout(timer);
      reject(new Error(`unexpected mock output: ${chunk.toString()}`));
    };
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      resolveQuiet();
    }, durationMs);
    child.stdout.once("data", onData);
  });

describe("mock backend process", () => {
  it("preserves ids, fragments frames, and maintains state", async () => {
    const child = startMock("ready-idle");
    try {
      send(child, { id: "state-1", type: "get_state" });
      const first = await nextLine(child);
      expect(first.chunks).toBeGreaterThan(1);
      expect(JSON.parse(first.line)).toMatchObject({ id: "state-1", success: true, data: { messageCount: 0 } });

      send(child, { id: "prompt-1", type: "prompt", message: "hello" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "agent_start" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "message_update" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "agent_end" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "prompt-1", success: true });
      send(child, { id: "state-2", type: "get_state" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "state-2", data: { messageCount: 2 } });

      send(child, { id: "unknown-1", type: "future_command" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({
        id: "unknown-1",
        success: false,
        error: "unknown command: future_command",
      });
    } finally {
      child.kill();
    }
  });

  it("delays startup responses", async () => {
    const child = startMock("delayed-startup");
    const startedAt = Date.now();
    try {
      send(child, { id: "delayed", type: "get_state" });
      await nextLine(child);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    } finally {
      child.kill();
    }
  });

  it("emits correlated command errors and malformed frames", async () => {
    const rejected = startMock("command-rejection");
    try {
      send(rejected, { id: "reject-me", type: "get_state" });
      expect(JSON.parse((await nextLine(rejected)).line)).toMatchObject({
        id: "reject-me",
        success: false,
        error: "mock rejected get_state",
      });
    } finally {
      rejected.kill();
    }

    const malformed = startMock("malformed-output");
    try {
      send(malformed, { id: "malformed", type: "get_state" });
      expect((await nextLine(malformed)).line).toBe("{malformed-json");
    } finally {
      malformed.kill();
    }
  });

  it("exits intentionally before and after readiness", async () => {
    const crash = startMock("crash-before-ready");
    expect(await waitForExit(crash)).toBe(17);

    const disconnect = startMock("disconnect-after-ready");
    send(disconnect, { id: "ready", type: "get_state" });
    expect(JSON.parse((await nextLine(disconnect)).line)).toMatchObject({ id: "ready", success: true });
    expect(await waitForExit(disconnect)).toBe(23);
  });

  it("cancels pending prompt output and settles both calls on abort", async () => {
    const child = startMock("ready-idle");
    try {
      send(child, { id: "ready", type: "get_state" });
      await nextLine(child);
      send(child, { id: "prompt", type: "prompt", message: "do not emit this" });
      send(child, { id: "abort", type: "abort" });

      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "agent_start" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "agent_end" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "prompt", success: true });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "abort", success: true });
      await expectNoOutput(child);
    } finally {
      child.kill();
    }
  });
});
