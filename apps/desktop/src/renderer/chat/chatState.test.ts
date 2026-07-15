import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, reconcileQueue, shouldShowThinking } from "./chatState";
import type { QueuedMessage } from "./chatState";

const queued = (id: string, text: string): QueuedMessage => ({
  id,
  role: "user",
  text,
  status: "queued",
  kind: "steering",
});

describe("chat event reduction", () => {
  it("creates assistant boundaries only after completion", () => {
    let state = chatReducer(initialChatState, { type: "initial-submit", id: "user-1", text: "hello" });
    state = chatReducer(state, { type: "assistant-delta", id: "assistant-1", text: "one" });
    state = chatReducer(state, { type: "assistant-delta", id: "unused", text: " two" });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ text: "one two", status: "streaming" });
    state = chatReducer(state, { type: "assistant-complete" });
    state = chatReducer(state, { type: "assistant-delta", id: "assistant-2", text: "three" });
    expect(state.messages.filter(message => message.role === "assistant")).toEqual([
      expect.objectContaining({ id: "assistant-1", text: "one two", status: "complete" }),
      expect.objectContaining({ id: "assistant-2", text: "three", status: "streaming" }),
    ]);
  });

  it("reconciles duplicate queue text by FIFO identity and injects it once", () => {
    const current = [queued("first", "same"), queued("second", "same")];
    expect(reconcileQueue(current, ["same"])).toEqual({
      injected: [current[0]],
      remaining: [current[1]],
    });

    let state = { ...initialChatState, running: true };
    state = chatReducer(state, { type: "queue-accepted", id: "first", kind: "steering", text: "same" });
    state = chatReducer(state, { type: "queue-accepted", id: "second", kind: "steering", text: "same" });
    state = chatReducer(state, { type: "queue-update", steering: ["same"], followUp: [] });
    expect(state.queue.map(item => item.id)).toEqual(["second"]);
    expect(state.messages.map(message => message.text)).toEqual(["same"]);
  });

  it("preserves local queue identity when a backend snapshot cannot be reconciled", () => {
    const current = [queued("first", "one"), queued("second", "two")];
    expect(reconcileQueue(current, ["unexpected"])).toEqual({
      injected: [],
      remaining: current,
    });
  });

  it("retains one failed initial user message for retry and settles stop only at run-end", () => {
    let failed = chatReducer(initialChatState, { type: "initial-submit", id: "user-1", text: "try this" });
    failed = chatReducer(failed, { type: "request-failed", userId: "user-1", text: "try this", error: "offline" });
    failed = chatReducer(failed, { type: "retry-start" });
    expect(failed.messages).toHaveLength(1);
    expect(failed.messages[0]).toMatchObject({ text: "try this", status: "complete" });

    let stopped = chatReducer(failed, { type: "assistant-delta", id: "assistant-1", text: "partial" });
    stopped = chatReducer(stopped, { type: "queue-accepted", id: "queued-1", kind: "follow-up", text: "later" });
    stopped = chatReducer(stopped, { type: "stop-request" });
    stopped = chatReducer(stopped, { type: "stop-acknowledged" });
    expect(stopped).toMatchObject({ running: true, stopping: true, queue: [] });
    expect(stopped.messages.at(-1)).toMatchObject({ text: "partial", status: "streaming" });
    stopped = chatReducer(stopped, { type: "queue-accepted", id: "late-queue", kind: "steering", text: "too late" });
    expect(stopped.queue).toEqual([]);
    stopped = chatReducer(stopped, { type: "assistant-delta", id: "unused", text: " output" });
    stopped = chatReducer(stopped, { type: "run-end" });
    expect(stopped.messages.at(-1)).toMatchObject({ text: "partial output", status: "stopped" });
    expect(stopped.queue).toEqual([]);
  });

  it("clears unconsumed queue entries at a normal run boundary", () => {
    let state = chatReducer(initialChatState, { type: "initial-submit", id: "user-1", text: "hello" });
    state = chatReducer(state, { type: "queue-accepted", id: "queued-1", kind: "steering", text: "too late" });
    state = chatReducer(state, { type: "run-end" });
    expect(state).toMatchObject({ running: false, stopping: false, queue: [] });
    expect(chatReducer(state, { type: "stop-failed", error: "late abort error" })).toBe(state);
  });

  it("ignores a stale request failure after chat reset", () => {
    const state = chatReducer(initialChatState, {
      type: "request-failed",
      userId: "old-user",
      text: "old request",
      error: "late failure",
    });
    expect(state).toBe(initialChatState);
  });

  it("completes MoA aggregation even when the assistant response is empty", () => {
    let state = chatReducer(initialChatState, {
      type: "activity",
      event: { type: "moa-aggregating", model: "aggregator", refCount: 2 },
    });
    state = chatReducer(state, { type: "assistant-complete" });
    expect(state.activity.entries).toEqual([
      expect.objectContaining({ kind: "moa-aggregation", status: "success" }),
    ]);
  });

  it("restores persisted tool uses between conversation messages", () => {
    const state = chatReducer(initialChatState, {
      type: "hydrate",
      messages: [
        { role: "user", text: "Inspect the retry loop" },
        { role: "tool", id: "tool-1", name: "list_directory", failed: false, target: "renderer" },
        { role: "tool", id: "tool-2", name: "read_file", failed: true, target: "retry.ts" },
        { role: "assistant", text: "The retry loop is unbounded." },
      ],
      todos: [],
    });

    expect(state.messages.map(message => [message.text, message.order])).toEqual([
      ["Inspect the retry loop", 1],
      ["The retry loop is unbounded.", 4],
    ]);
    expect(state.activity.entries).toEqual([
      expect.objectContaining({ kind: "tool", name: "list_directory", status: "success", target: "renderer", order: 2 }),
      expect.objectContaining({ kind: "tool", name: "read_file", status: "error", target: "retry.ts", order: 3 }),
    ]);
  });

  it("keeps simultaneous prompts in arrival order and settles them at lifecycle boundaries", () => {
    let state = chatReducer(initialChatState, { type: "initial-submit", id: "user-1", text: "hello" });
    state = chatReducer(state, { type: "interaction-request", request: { type: "approval", id: "11111111-1111-4111-8111-111111111111", command: "echo one" } });
    state = chatReducer(state, { type: "interaction-request", request: { type: "clarification", id: "22222222-2222-4222-8222-222222222222", question: "Which?", choices: ["A", "B"] } });
    expect(state.interactions.map(prompt => prompt.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    state = chatReducer(state, { type: "interaction-submit", id: state.interactions[0]!.id });
    state = chatReducer(state, { type: "interaction-failed", id: state.interactions[0]!.id, error: "temporary" });
    expect(state.interactions[0]).toMatchObject({ submitting: false, error: "temporary" });
    state = chatReducer(state, { type: "run-end" });
    expect(state.interactions).toEqual([]);
    state = chatReducer(state, { type: "interaction-request", request: { type: "approval", id: "33333333-3333-4333-8333-333333333333", command: "late" } });
    expect(state.interactions).toEqual([]);
  });
});

describe("thinking indicator predicate", () => {
  it("shows thinking immediately after user submits (no assistant message yet)", () => {
    const state = chatReducer(initialChatState, { type: "initial-submit", id: "u1", text: "hi" });
    expect(shouldShowThinking(state)).toBe(true);
  });

  it("hides thinking while assistant is streaming", () => {
    let state = chatReducer(initialChatState, { type: "initial-submit", id: "u1", text: "hi" });
    state = chatReducer(state, { type: "assistant-delta", id: "a1", text: "hello" });
    expect(shouldShowThinking(state)).toBe(false);
  });

  it("shows thinking again after assistant-complete while still running (post-turn work)", () => {
    let state = chatReducer(initialChatState, { type: "initial-submit", id: "u1", text: "hi" });
    state = chatReducer(state, { type: "assistant-delta", id: "a1", text: "hello" });
    state = chatReducer(state, { type: "assistant-complete" });
    expect(state.running).toBe(true);
    expect(shouldShowThinking(state)).toBe(true);
  });

  it("hides thinking after run-end", () => {
    let state = chatReducer(initialChatState, { type: "initial-submit", id: "u1", text: "hi" });
    state = chatReducer(state, { type: "assistant-delta", id: "a1", text: "hello" });
    state = chatReducer(state, { type: "assistant-complete" });
    state = chatReducer(state, { type: "run-end" });
    expect(shouldShowThinking(state)).toBe(false);
  });
});
