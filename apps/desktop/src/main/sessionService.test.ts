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
});
