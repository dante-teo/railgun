import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BackendSupervisor, createBackendSpawnSpec } from "./backendSupervisor";
import type { BackendChild } from "./backendSupervisor";

class FakeChild extends EventEmitter implements BackendChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

const readinessResponse = (generation: number): string => JSON.stringify({
  id: `desktop-ready-${generation}`,
  type: "response",
  command: "get_state",
  success: true,
  data: { running: false },
});

const initializationResponse = (generation: number, overrides: Record<string, unknown> = {}): string => JSON.stringify({
  id: `desktop-init-${generation}`,
  type: "response",
  command: "initialize",
  success: true,
  data: { version: 1, capabilities: ["sessions", "interaction.approval", "interaction.clarification"] },
  ...overrides,
});

const makeReady = (child: FakeChild, generation: number): void => {
  child.stdin.read();
  child.stdout.write(`${initializationResponse(generation)}\n`);
  child.stdin.read();
  child.stdout.write(`${readinessResponse(generation)}\n`);
};

describe("BackendSupervisor", () => {
  it("correlates a fragmented readiness response and transitions to ready", () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    supervisor.start();

    expect(child.stdin.read()?.toString()).toContain('"type":"initialize"');
    const initResponse = initializationResponse(1);
    child.stdout.write(initResponse.slice(0, 20));
    expect(supervisor.getSnapshot().phase).toBe("starting");
    child.stdout.write(`${initResponse.slice(20)}\n`);
    expect(child.stdin.read()?.toString()).toContain('"type":"get_state"');
    const response = readinessResponse(1);
    child.stdout.write(response.slice(0, 20));
    expect(supervisor.getSnapshot().phase).toBe("starting");
    child.stdout.write(`${response.slice(20)}\n`);

    expect(supervisor.getSnapshot().phase).toBe("ready");
    expect(supervisor.getSnapshot().transportLog.at(-1)).toMatchObject({ direction: "stdout" });
    supervisor.shutdown();
  });

  it("drains coalesced complete frames before enforcing the residual buffer limit", () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({
      mode: "real",
      spawnChild: () => child,
      maxBufferLength: 32,
    });
    supervisor.start();
    child.stdin.read();
    child.stdout.write(`${initializationResponse(1)}\n${readinessResponse(1)}\n`);
    expect(supervisor.getSnapshot().phase).toBe("ready");
    supervisor.shutdown();
  });

  it("reports rejected probes and malformed output", () => {
    const rejectedChild = new FakeChild();
    const rejected = new BackendSupervisor({ mode: "mock", spawnChild: () => rejectedChild });
    rejected.start("command-rejection");
    rejectedChild.stdin.read();
    rejectedChild.stdout.write(`${initializationResponse(1)}\n`);
    rejectedChild.stdout.write(`${JSON.stringify({
      id: "desktop-ready-1",
      type: "response",
      command: "get_state",
      success: false,
      error: "mock rejected get_state",
    })}\n`);
    expect(rejected.getSnapshot()).toMatchObject({ phase: "failed", error: "mock rejected get_state" });

    const malformedChild = new FakeChild();
    const malformed = new BackendSupervisor({ mode: "mock", spawnChild: () => malformedChild });
    malformed.start("malformed-output");
    malformedChild.stdout.write("{not-json\n");
    expect(malformed.getSnapshot()).toMatchObject({ phase: "failed", error: "Backend emitted malformed JSONL output" });
  });

  it("fails clearly on protocol version or capability mismatch", () => {
    const versionChild = new FakeChild();
    const versionSupervisor = new BackendSupervisor({ mode: "real", spawnChild: () => versionChild });
    versionSupervisor.start();
    versionChild.stdout.write(`${initializationResponse(1, { data: { version: 2, capabilities: ["sessions", "interaction.approval", "interaction.clarification"] } })}\n`);
    expect(versionSupervisor.getSnapshot()).toMatchObject({ phase: "failed", error: expect.stringContaining("version mismatch") });

    const capabilityChild = new FakeChild();
    const capabilitySupervisor = new BackendSupervisor({ mode: "real", spawnChild: () => capabilityChild });
    capabilitySupervisor.start();
    capabilityChild.stdout.write(`${initializationResponse(1, { data: { version: 1, capabilities: ["sessions"] } })}\n`);
    expect(capabilitySupervisor.getSnapshot()).toMatchObject({ phase: "failed", error: expect.stringContaining("missing required capabilities") });
  });

  it("bounds diagnostics and transport entries", () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({
      mode: "real",
      spawnChild: () => child,
      maxDiagnostics: 2,
      maxTransportEntries: 3,
    });
    supervisor.start();
    child.stderr.write("one\n");
    child.stderr.write("two\n");
    child.stderr.write("three\n");

    expect(supervisor.getSnapshot().diagnostics).toEqual(["two", "three"]);
    expect(supervisor.getSnapshot().transportLog).toHaveLength(3);
    supervisor.shutdown();
  });

  it("redacts and truncates diagnostics and records only safe frame summaries", async () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({
      mode: "real",
      spawnChild: () => child,
      maxLogTextLength: 120,
    });
    supervisor.start();
    makeReady(child, 1);
    const call = supervisor.call({ type: "prompt", message: "private user prompt" });
    child.stdin.read();
    child.stderr.write(`DEVIN_TOKEN=super-secret Bearer another-secret ${"x".repeat(100)}\n`);
    child.stdout.write(`${JSON.stringify({ type: "approval_request", command: "curl secret.example" })}\n`);
    child.stdout.write(`${JSON.stringify({
      id: "desktop-rpc-1", type: "response", command: "prompt", success: false,
      error: "password=hunter2",
    })}\n`);

    await expect(call).rejects.toThrow("password=[REDACTED]");
    const mismatched = supervisor.call({ type: "prompt", message: "another private prompt" });
    child.stdin.read();
    child.stdout.write(`${JSON.stringify({
      id: "desktop-rpc-2", type: "response", command: "DEVIN_TOKEN=leaked", success: true,
    })}\n`);
    await expect(mismatched).rejects.toThrow("DEVIN_TOKEN=[REDACTED]");
    const serialized = JSON.stringify(supervisor.getSnapshot());
    expect(serialized).not.toContain("private user prompt");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("curl secret.example");
    expect(serialized).not.toContain("leaked");
    expect(supervisor.getSnapshot().diagnostics.every(text => text.length <= 120)).toBe(true);
    supervisor.shutdown();
  });

  it("recognizes authentication-required before the handshake and preserves it on exit", () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    supervisor.start();
    child.stdout.write('{"type":"startup_status","status":"authentication_required"}\n');
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: "authentication-required",
      error: expect.stringContaining("railgun login"),
    });
    child.exit(1);
    expect(supervisor.getSnapshot().phase).toBe("authentication-required");
  });

  it("provides effective recovery guidance for a rejected environment credential", () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    supervisor.start();
    child.stdout.write(`${JSON.stringify({
      type: "startup_status",
      status: "authentication_required",
      credential_source: "environment",
    })}\n`);

    expect(supervisor.getSnapshot()).toMatchObject({
      phase: "authentication-required",
      error: expect.stringMatching(/DEVIN_TOKEN.*remove or replace.*relaunch Railgun/i),
    });
  });

  it("keeps authentication-required terminal until an explicit restart", () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    supervisor.start();
    child.stdout.write([
      '{"type":"startup_status","status":"authentication_required"}',
      initializationResponse(1),
      readinessResponse(1),
      "",
    ].join("\n"));

    expect(supervisor.getSnapshot().phase).toBe("authentication-required");
    expect(child.stdin.read()?.toString()).not.toContain('"type":"get_state"');
  });

  it("rejects oversized frames and buffers", () => {
    const frameChild = new FakeChild();
    const frameSupervisor = new BackendSupervisor({ mode: "real", spawnChild: () => frameChild, maxFrameLength: 40 });
    frameSupervisor.start();
    frameChild.stdout.write(`${JSON.stringify({ type: "event", content: "x".repeat(100) })}\n`);
    expect(frameSupervisor.getSnapshot().error).toContain("frame exceeded");

    const bufferChild = new FakeChild();
    const bufferSupervisor = new BackendSupervisor({
      mode: "real", spawnChild: () => bufferChild, maxFrameLength: 200, maxBufferLength: 50,
    });
    bufferSupervisor.start();
    bufferChild.stdout.write("x".repeat(51));
    expect(bufferSupervisor.getSnapshot().error).toContain("buffer exceeded");
  });

  it("terminates children and ignores stale events after a restart", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const queue = [first, second];
    const supervisor = new BackendSupervisor({ mode: "mock", spawnChild: () => queue.shift()! });

    supervisor.start("ready-idle");
    supervisor.restartWithScenario("delayed-startup");
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");

    first.stdout.write(`${initializationResponse(1)}\n${readinessResponse(1)}\n`);
    expect(supervisor.getSnapshot().phase).toBe("starting");
    makeReady(second, 2);
    expect(supervisor.getSnapshot().phase).toBe("ready");

    supervisor.shutdown();
    expect(second.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects pending calls when restarting and escalates termination after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeChild();
      const second = new FakeChild();
      const supervisor = new BackendSupervisor({
        mode: "real", spawnChild: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second), terminationGraceMs: 25,
      });
      supervisor.start();
      makeReady(first, 1);
      const pending = supervisor.call({ type: "prompt", message: "wait" });
      supervisor.restartBackend();
      await expect(pending).rejects.toThrow("Backend stopped");
      expect(first.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(25);
      expect(first.kill).toHaveBeenCalledWith("SIGKILL");
      second.exit(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes failure before ready from disconnection after ready", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const queue = [first, second];
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => queue.shift()! });

    supervisor.start();
    first.exit(17);
    expect(supervisor.getSnapshot()).toMatchObject({ phase: "failed", error: "Backend exited with exit code 17" });

    supervisor.start();
    makeReady(second, 2);
    second.exit(23);
    expect(supervisor.getSnapshot()).toMatchObject({ phase: "disconnected", error: "Backend exited with exit code 23" });
  });

  it("fails a readiness timeout", () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child, readinessTimeoutMs: 50 });
    supervisor.start();
    vi.advanceTimersByTime(50);
    expect(supervisor.getSnapshot()).toMatchObject({ phase: "failed", error: "Backend readiness probe timed out" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });

  it("correlates RPC calls and forwards non-response backend events", async () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    const listener = vi.fn();
    supervisor.subscribeBackendEvents(listener);
    supervisor.start();
    makeReady(child, 1);

    const call = supervisor.call({ type: "prompt", message: "hello" });
    const written = child.stdin.read()?.toString() ?? "";
    expect(written).toContain('"type":"prompt"');
    expect(written).toContain('"message":"hello"');
    child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    expect(listener).toHaveBeenCalledWith({ type: "agent_start" });
    child.stdout.write(`${JSON.stringify({
      id: "desktop-rpc-1",
      type: "response",
      command: "prompt",
      success: true,
    })}\n`);
    await expect(call).resolves.toBeUndefined();
    supervisor.shutdown();
  });

  it("returns correlated RPC response data", async () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    supervisor.start();
    makeReady(child, 1);
    const call = supervisor.call({ type: "session_save" }, data => {
      if (typeof data !== "object" || data === null || (data as Record<string, unknown>).saved !== true) throw new Error("expected saved response");
      return data as { saved: true };
    });
    child.stdin.read();
    child.stdout.write(`${JSON.stringify({ id: "desktop-rpc-1", type: "response", command: "session_save", success: true, data: { saved: true } })}\n`);
    await expect(call).resolves.toEqual({ saved: true });
    supervisor.shutdown();
  });

  it("rejects a call cleanly when writing to backend stdin throws", async () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    supervisor.start();
    makeReady(child, 1);
    vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
      throw new Error("pipe closed");
    });

    await expect(supervisor.call({ type: "prompt", message: "hello" })).rejects.toThrow(
      "Unable to write to backend: pipe closed",
    );
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: "disconnected",
      error: "Unable to write to backend: pipe closed",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    supervisor.shutdown();
  });

  it("turns a synchronous readiness write failure into a startup failure", () => {
    const child = new FakeChild();
    vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
      throw new Error("readiness pipe closed");
    });
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });

    expect(() => supervisor.start()).not.toThrow();
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: "failed",
      error: "Unable to write backend initialization request: readiness pipe closed",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("handles asynchronous stdin errors without leaving an RPC call pending", async () => {
    const child = new FakeChild();
    const supervisor = new BackendSupervisor({ mode: "real", spawnChild: () => child });
    supervisor.start();
    makeReady(child, 1);

    const call = supervisor.call({ type: "prompt", message: "hello" });
    child.stdin.emit("error", new Error("write EPIPE DEVIN_TOKEN=do-not-surface"));

    await expect(call).rejects.toThrow("Backend stdin error: write EPIPE DEVIN_TOKEN=[REDACTED]");
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: "disconnected",
      error: "Backend stdin error: write EPIPE DEVIN_TOKEN=[REDACTED]",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("createBackendSpawnSpec", () => {
  it("uses pnpm and source entries during development", () => {
    expect(createBackendSpawnSpec(
      { kind: "development", repositoryRoot: "/repo" },
      "real",
    )).toMatchObject({
      command: "pnpm",
      args: ["exec", "tsx", "/repo/src/cli.ts", "--mode", "rpc"],
      cwd: "/repo",
      env: { RAILGUN_DESKTOP_RPC: "1" },
    });

    expect(createBackendSpawnSpec(
      { kind: "development", repositoryRoot: "/repo" },
      "mock",
      "delayed-startup",
    ).args).toEqual([
      "exec",
      "tsx",
      "/repo/apps/desktop/src/mock/backend.ts",
      "delayed-startup",
    ]);
  });

  it("uses packaged resources and Electron's embedded Node runtime", () => {
    const runtime = {
      kind: "packaged" as const,
      resourcesPath: "/Railgun.app/Contents/Resources",
      executablePath: "/Railgun.app/Contents/MacOS/Railgun",
      workingDirectory: "/Users/example",
    };

    expect(createBackendSpawnSpec(runtime, "real")).toMatchObject({
      command: "/Railgun.app/Contents/MacOS/Railgun",
      args: [
        "/Railgun.app/Contents/Resources/backend/railgun/dist/cli.js",
        "--mode",
        "rpc",
      ],
      cwd: "/Users/example",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(createBackendSpawnSpec(runtime, "mock", "ready-idle").args).toEqual([
      "/Railgun.app/Contents/Resources/backend/mock-backend.cjs",
      "ready-idle",
    ]);
  });
});
