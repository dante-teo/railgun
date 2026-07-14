import { describe, expect, it, vi } from "vitest";
import { createSessionService } from "./sessionService";

const state = {
  running: false, model: "mock-model", messageCount: 4, todos: [{ id: "todo-1", content: "Verify", status: "completed" }],
  protocolVersion: 1, sessionId: "saved-1", startedAt: "2026-07-14T08:00:00.000Z", persistence: "saved",
} as const;

describe("desktop session service", () => {
  it("lists, loads, and snapshots authoritative session state", async () => {
    const call = vi.fn(async (command: { type: string }) => {
      if (command.type === "session_list") return { sessions: [{ id: "saved-1", model: "mock-model", startedAtLocal: "today", messageCount: 4, firstUserPreview: "Hello" }] };
      if (command.type === "session_load") return { sessionId: "saved-1" };
      if (command.type === "get_state") return state;
      if (command.type === "session_transcript") return { sessionId: "saved-1", messages: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi" }] };
      throw new Error(`unexpected ${command.type}`);
    });
    const service = createSessionService((command, validate) => call(command).then(validate));
    await expect(service.list()).resolves.toHaveLength(1);
    await expect(service.resume("saved-1")).resolves.toMatchObject({ id: "saved-1", checkpoint: { state: "saved" }, transcript: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi" }] });
    expect(call).toHaveBeenCalledWith({ type: "session_load", sessionId: "saved-1", includeMessages: false });
  });

  it("rejects mismatched session activation", async () => {
    const service = createSessionService(async (command, validate) => validate(command.type === "session_load" ? { sessionId: "other" } : {}));
    await expect(service.resume("expected")).rejects.toThrow(/mismatched/u);
  });

  it("rejects malformed persisted todos instead of leaking backend fields", async () => {
    const service = createSessionService(async (command, validate) => validate(command.type === "get_state"
      ? { ...state, todos: [{ id: "todo", content: "Visible", status: "pending", providerPayload: "private" }] }
      : { sessionId: "saved-1", messages: [] }));
    await expect(service.snapshot()).rejects.toThrow();
  });

  it("loads transcript pages without accepting raw provider fields or stalled cursors", async () => {
    const pages = [
      { sessionId: "saved-1", messages: [{ role: "user", text: "One" }], nextCursor: 1 },
      { sessionId: "saved-1", messages: [{ role: "assistant", text: "Two" }] },
    ];
    const service = createSessionService(async (command, validate) => validate(command.type === "get_state" ? state : pages.shift()));
    await expect(service.snapshot()).resolves.toMatchObject({ transcript: [{ role: "user", text: "One" }, { role: "assistant", text: "Two" }] });

    const unsafe = createSessionService(async (command, validate) => validate(command.type === "get_state"
      ? state
      : { sessionId: "saved-1", messages: [{ role: "assistant", text: "Visible", toolCall: { token: "private" } }] }));
    await expect(unsafe.snapshot()).rejects.toThrow();

    const stalled = createSessionService(async (command, validate) => validate(command.type === "get_state"
      ? state
      : { sessionId: "saved-1", messages: [], nextCursor: 0 }));
    await expect(stalled.snapshot()).rejects.toThrow(/cursor/u);
  });

  it("branches and forks through message-free mutations before returning authoritative snapshots", async () => {
    const forkState = { ...state, sessionId: "saved-1-fork", startedAt: "2026-07-14T09:00:00.000Z" };
    let forked = false;
    const call = vi.fn(async (command: { type: string; [key: string]: unknown }) => {
      if (command.type === "session_branch") return { recentMessages: [{ id: 9, role: "user", preview: "One" }] };
      if (command.type === "session_fork") { forked = true; return { sessionId: "saved-1-fork" }; }
      if (command.type === "get_state") return forked ? forkState : state;
      if (command.type === "session_transcript") return { sessionId: forked ? forkState.sessionId : state.sessionId, messages: [{ role: "user", text: "One", messageId: 9 }] };
      throw new Error(`unexpected ${command.type}`);
    });
    const service = createSessionService((command, validate) => call(command).then(validate));

    await expect(service.branch(9, true)).resolves.toMatchObject({ id: "saved-1", transcript: [{ messageId: 9 }] });
    expect(call).toHaveBeenCalledWith({ type: "session_branch", messageId: 9, summarize: true, includeMessages: false });
    await expect(service.fork("saved-1")).resolves.toMatchObject({ id: "saved-1-fork" });
    expect(call).toHaveBeenCalledWith({ type: "session_fork", sessionId: "saved-1", includeMessages: false });
  });

  it("rejects malformed branch mutation responses and mismatched fork activation", async () => {
    const malformed = createSessionService(async (command, validate) => validate(command.type === "session_branch"
      ? { messages: [{ role: "tool", content: "private" }] }
      : {}));
    await expect(malformed.branch(1, false)).rejects.toThrow();

    const mismatched = createSessionService(async (command, validate) => validate(command.type === "session_fork"
      ? { sessionId: "fork" }
      : command.type === "get_state" ? state : { sessionId: "saved-1", messages: [] }));
    await expect(mismatched.fork("saved-1")).rejects.toThrow(/mismatched fork/u);
  });
});
