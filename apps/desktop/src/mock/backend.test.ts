import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopAgentEventSchema } from "../shared/schemas";
import { toDesktopAgentEvent } from "../main/agentBoundary";
import { createLineReader } from "./testLineReader";

const entry = resolve(import.meta.dirname, "backend.ts");

const startMock = (scenario: string): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ["--import", "tsx", entry, scenario], { stdio: ["pipe", "pipe", "pipe"] });

const lineReaders = new WeakMap<ChildProcessWithoutNullStreams, ReturnType<typeof createLineReader>>();
const nextLine = (child: ChildProcessWithoutNullStreams): Promise<{ readonly line: string; readonly chunks: number }> => {
  const existing = lineReaders.get(child);
  if (existing !== undefined) return existing();
  const reader = createLineReader(child.stdout);
  lineReaders.set(child, reader);
  return reader();
};

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
  it("emits authentication-required and exits", async () => {
    const child = startMock("authentication-required");
    expect(JSON.parse((await nextLine(child)).line)).toEqual({
      type: "startup_status",
      status: "authentication_required",
      credential_source: "file",
    });
    expect(await waitForExit(child)).toBe(1);
  });

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
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "message_update" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "message_update" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "message_end" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "turn_end", usage: { inputTokens: 1_200, outputTokens: 300 } });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "agent_end" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "prompt-1", success: true });
      send(child, { id: "state-2", type: "get_state" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "state-2", data: { messageCount: 2, persistence: "saved" } });

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

  it("keeps populated rich session navigation aligned with desktop restoration", async () => {
    const child = startMock("ready-idle");
    try {
      send(child, { id: "list", type: "session_list" });
      const list = JSON.parse((await nextLine(child)).line) as { data: { sessions: Array<{ id: string }> } };
      expect(list.data.sessions[0]?.id).toBe("mock-session-rich-history");
      expect(list.data.sessions).toHaveLength(3);

      send(child, { id: "load", type: "session_load", sessionId: "mock-session-rich-history", includeMessages: false });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "load", success: true, data: { sessionId: "mock-session-rich-history" } });
      send(child, { id: "state", type: "get_state" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ data: { sessionId: "mock-session-rich-history", persistence: "saved", todos: expect.arrayContaining([expect.objectContaining({ status: "in_progress" })]) } });
      send(child, { id: "transcript", type: "session_transcript", sessionId: "mock-session-rich-history", cursor: 0, limit: 100 });
      const transcript = JSON.parse((await nextLine(child)).line) as { data: { messages: unknown[] } };
      expect(transcript.data.messages.length).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(transcript)).not.toMatch(/must-not-cross-boundary|sensitive raw provider payload/u);

      send(child, { id: "model", type: "set_model", modelId: "mock-reference" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "model", success: true });
      send(child, { id: "fork-state", type: "get_state" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({
        data: { sessionId: expect.not.stringMatching(/^mock-session-rich-history$/u), model: "mock-reference", persistence: "unsaved" },
      });
    } finally { child.kill(); }
  });

  it("branches by projected persistence ID and creates independent active forks", async () => {
    const child = startMock("ready-idle");
    try {
      send(child, { id: "load", type: "session_load", sessionId: "mock-session-older", includeMessages: false });
      await nextLine(child);
      send(child, { id: "transcript", type: "session_transcript", sessionId: "mock-session-older" });
      const transcript = JSON.parse((await nextLine(child)).line) as { data: { messages: Array<{ messageId: number }> } };
      expect(transcript.data.messages.every(message => Number.isInteger(message.messageId))).toBe(true);

      send(child, { id: "fork", type: "session_fork", sessionId: "mock-session-older", includeMessages: false });
      const fork = JSON.parse((await nextLine(child)).line) as { data: { sessionId: string } };
      expect(fork.data.sessionId).toMatch(/^mock-fork-/u);
      send(child, { id: "fork-transcript", type: "session_transcript", sessionId: fork.data.sessionId });
      const forkTranscript = JSON.parse((await nextLine(child)).line) as { data: { messages: Array<{ messageId: number; branchable?: true }> } };
      const forkPoint = forkTranscript.data.messages.find(message => message.branchable)?.messageId;
      if (forkPoint === undefined) throw new Error("mock transcript has no complete branch boundary");
      send(child, { id: "branch", type: "session_branch", messageId: forkPoint, summarize: true, includeMessages: false });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "branch", success: true, data: { recentMessages: expect.arrayContaining([expect.objectContaining({ id: forkPoint })]) } });
      send(child, { id: "state", type: "get_state" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ data: { sessionId: fork.data.sessionId, messageCount: 2 } });
      send(child, { id: "list-after-branch", type: "session_list" });
      const afterBranch = JSON.parse((await nextLine(child)).line) as { data: { sessions: Array<{ id: string; messageCount: number }> } };
      expect(afterBranch.data.sessions.find(session => session.id === fork.data.sessionId)?.messageCount).toBe(2);

      send(child, { id: "reload-source", type: "session_load", sessionId: "mock-session-older", includeMessages: false });
      await nextLine(child);
      send(child, { id: "source-state", type: "get_state" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ data: { sessionId: "mock-session-older", messageCount: 2 } });
    } finally { child.kill(); }
  });

  it("keeps empty and error session-store scenarios aligned", async () => {
    const empty = startMock("empty-stores");
    try {
      send(empty, { id: "list-empty", type: "session_list" });
      expect(JSON.parse((await nextLine(empty)).line)).toMatchObject({ id: "list-empty", success: true, data: { sessions: [] } });
    } finally { empty.kill(); }
    const failed = startMock("store-error");
    try {
      send(failed, { id: "list-error", type: "session_list" });
      expect(JSON.parse((await nextLine(failed)).line)).toMatchObject({ id: "list-error", success: false, error: "mock store error: session_list" });
    } finally { failed.kill(); }
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

  it("exposes deterministic approval allow/deny and choice/free-text clarification flows", async () => {
    const approvalChild = startMock("approval");
    try {
      send(approvalChild, { id: "prompt-allow", type: "prompt", message: "approve" });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ type: "agent_start" });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ type: "approval_request", requestId: "mock-approval-1" });
      send(approvalChild, { id: "approval-allow", type: "approval_response", requestId: "mock-approval-1", approved: true });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ id: "approval-allow", success: true });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ type: "agent_end" });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ id: "prompt-allow", success: true });
      send(approvalChild, { id: "prompt-deny", type: "prompt", message: "deny" });
      await nextLine(approvalChild);
      await nextLine(approvalChild);
      send(approvalChild, { id: "approval-deny", type: "approval_response", requestId: "mock-approval-1", approved: false });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ id: "approval-deny", success: true });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ type: "agent_end" });
      expect(JSON.parse((await nextLine(approvalChild)).line)).toMatchObject({ id: "prompt-deny", success: false, error: "shell command denied" });
    } finally {
      approvalChild.kill();
    }

    const choiceChild = startMock("clarification-choice");
    try {
      send(choiceChild, { id: "prompt-choice", type: "prompt", message: "choose" });
      await nextLine(choiceChild);
      expect(JSON.parse((await nextLine(choiceChild)).line)).toMatchObject({
        type: "clarification_request", choices: ["Use the fast path", "Use the safe path"],
      });
      send(choiceChild, { id: "clarification-choice", type: "clarification_response", requestId: "mock-clarification-1", answer: "Use the safe path" });
      expect(JSON.parse((await nextLine(choiceChild)).line)).toMatchObject({ id: "clarification-choice", success: true });
      expect(JSON.parse((await nextLine(choiceChild)).line)).toMatchObject({ type: "agent_end" });
      expect(JSON.parse((await nextLine(choiceChild)).line)).toMatchObject({ id: "prompt-choice", success: true });
    } finally {
      choiceChild.kill();
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
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "queue_update", steering: [], followUp: [] });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "agent_end" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "prompt", success: true });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ id: "abort", success: true });
      await expectNoOutput(child);
    } finally {
      child.kill();
    }
  });

  it("mirrors steering and follow-up queues through injection boundaries", async () => {
    const child = startMock("cancellation");
    try {
      send(child, { id: "prompt", type: "prompt", message: "keep running" });
      expect(JSON.parse((await nextLine(child)).line)).toMatchObject({ type: "agent_start" });
      send(child, { id: "steer", type: "steer", message: "same" });
      send(child, { id: "follow", type: "follow_up", message: "same" });

      const frames: Record<string, unknown>[] = [];
      for (let index = 0; index < 16; index += 1) {
        const frame = JSON.parse((await nextLine(child)).line) as Record<string, unknown>;
        frames.push(frame);
        const responses = new Set(frames.filter(item => item.type === "response").map(item => item.id));
        const emptied = frames.some(item => item.type === "queue_update" &&
          Array.isArray(item.steering) && item.steering.length === 0 &&
          Array.isArray(item.followUp) && item.followUp.length === 0);
        if (responses.has("steer") && responses.has("follow") && emptied) break;
      }

      expect(frames).toContainEqual(expect.objectContaining({ type: "queue_update", steering: ["same"] }));
      expect(frames).toContainEqual(expect.objectContaining({ type: "queue_update", followUp: ["same"] }));
      expect(frames).toContainEqual(expect.objectContaining({ id: "steer", success: true }));
      expect(frames).toContainEqual(expect.objectContaining({ id: "follow", success: true }));
    } finally {
      child.kill();
    }
  });

  it("emits a deterministic schema-valid agent activity sequence including an error", async () => {
    const child = startMock("agent-activity");
    try {
      send(child, { id: "prompt", type: "prompt", message: "show activity" });
      const frames: Record<string, unknown>[] = [];
      while (!frames.some(frame => frame.id === "prompt" && frame.type === "response")) {
        frames.push(JSON.parse((await nextLine(child)).line) as Record<string, unknown>);
      }
      const events = frames.filter(frame => frame.type !== "response").map(toDesktopAgentEvent);
      expect(events.every(event => event !== undefined && DesktopAgentEventSchema.safeParse(event).success)).toBe(true);
      expect(events.map(event => event?.type)).toEqual([
        "run-start", "tool-start", "subagent-start", "tool-start", "tool-start", "moa-reference-start",
        "tool-end", "tool-end", "tool-end", "moa-reference-end", "moa-aggregating", "advisor-note",
        "subagent-end", "assistant-delta", "assistant-complete", "context-usage", "run-end",
      ]);
      expect(events).toContainEqual(expect.objectContaining({ type: "tool-end", id: "shell-1", failed: true }));
    } finally {
      child.kill();
    }
  });
});
