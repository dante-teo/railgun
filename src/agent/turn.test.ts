import { describe, expect, it, vi } from "vitest";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import { runTurn } from "./turn.js";

const fakeProvider = (events: DevinStreamEvent[], throwError?: unknown): DevinProvider => ({
  login: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  listModels: vi.fn(),
  streamChat: async function* () {
    if (throwError) throw throwError;
    for (const event of events) yield event;
  }
});

describe("runTurn", () => {
  it("accumulates text_delta events, streams via onDelta, and appends user+assistant messages", async () => {
    const devin = fakeProvider([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      { type: "done", reason: "stop" }
    ]);
    const deltas: string[] = [];

    const outcome = await runTurn(devin, "model-1", [], "Hi", d => deltas.push(d));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.assistantText).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(outcome.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] }
    ]);
  });

  it("keeps prior history intact and appends the new turn on success", async () => {
    const devin = fakeProvider([{ type: "text_delta", delta: "Alex" }]);
    const priorHistory = [
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: [{ type: "text", text: "Nice to meet you, Alex" }] }
    ] as const;

    const outcome = await runTurn(devin, "model-1", priorHistory, "What is my name?");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.messages.slice(0, 2)).toEqual(priorHistory);
    expect(outcome.messages).toHaveLength(4);
  });

  it("returns ok:false and leaves the caller's history untouched when streamChat throws", async () => {
    const boom = new Error("network blip");
    const devin = fakeProvider([], boom);

    const outcome = await runTurn(devin, "model-1", [], "Hi");

    expect(outcome).toEqual({ ok: false, error: boom });
  });
});
