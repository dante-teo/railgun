import { describe, expect, it, vi } from "vitest";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import { createAgent } from "./agent.js";

const provider = (rounds: readonly (readonly DevinStreamEvent[])[]): DevinProvider => {
  let index = 0;
  return {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(),
    streamChat: async function* () { for (const event of rounds[index++] ?? []) yield event; },
  };
};

const dependencies = (devin: DevinProvider) => ({
  devin, model: "model", contextWindow: 100_000, systemPrompt: [] as const,
  confirmShellCommand: async () => true,
});

describe("createAgent", () => {
  it("rejects queue operations while idle and concurrent runs", async () => {
    const gate = Promise.withResolvers<void>();
    const devin: DevinProvider = {
      ...provider([]),
      streamChat: async function* () { await gate.promise; yield { type: "text_delta", delta: "done" }; },
    };
    const agent = createAgent(dependencies(devin));

    expect(() => agent.steer("idle")).toThrow(/not running/i);
    expect(() => agent.followUp("idle")).toThrow(/not running/i);
    const first = agent.run("hello");
    await expect(agent.run("again")).rejects.toThrow(/already running/i);
    gate.resolve();
    await first;
  });

  it("injects one steering message per boundary and drains follow-ups before settling", async () => {
    const firstBoundary = Promise.withResolvers<void>();
    let call = 0;
    const requests: unknown[] = [];
    const devin: DevinProvider = {
      ...provider([]),
      streamChat: async function* (request) {
        requests.push(request.messages);
        if (call++ === 0) await firstBoundary.promise;
        yield { type: "text_delta", delta: `answer-${call}` };
      },
    };
    const agent = createAgent(dependencies(devin));
    const running = agent.run("hello");
    agent.steer("steer me");
    agent.followUp("then this");
    firstBoundary.resolve();
    const outcome = await running;

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.messages.filter(message => message.role === "user").map(message => message.content))
      .toEqual(["hello", "steer me", "then this"]);
    expect(requests).toHaveLength(3);
  });

  it("aborts an active provider stream and remains reusable", async () => {
    let calls = 0;
    const devin: DevinProvider = {
      ...provider([]),
      streamChat: async function* ({ signal }) {
        if (calls++ > 0) { yield { type: "text_delta", delta: "recovered" }; return; }
        yield { type: "text_delta", delta: "partial" };
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const agent = createAgent(dependencies(devin));
    const first = agent.run("stop me");
    await Promise.resolve();
    agent.abort();

    const aborted = await first;
    expect(aborted).toMatchObject({ ok: false, aborted: true, assistantText: "partial" });
    await expect(agent.run("again")).resolves.toMatchObject({ ok: true, assistantText: "recovered" });
  });

  it("closes an aborted user message with an empty assistant boundary when no text streamed", async () => {
    const started = Promise.withResolvers<void>();
    const devin: DevinProvider = {
      ...provider([]),
      streamChat: async function* ({ signal }) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const agent = createAgent(dependencies(devin));
    const running = agent.run("stop before output");
    await started.promise;

    agent.abort();

    await expect(running).resolves.toMatchObject({
      ok: false,
      aborted: true,
      messages: [
        { role: "user", content: "stop before output" },
        { role: "assistant", content: [] },
      ],
    });
  });
});
