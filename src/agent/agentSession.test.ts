import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import { DevinApiError } from "widevin";
import { createAgentSession } from "./agentSession.js";
import type { AgentSessionEvent } from "./agentSession.js";

type FakeRound = readonly DevinStreamEvent[] | { throws: unknown };

const fakeProvider = (rounds: readonly FakeRound[]): DevinProvider => {
  let callIndex = 0;
  return {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(),
    streamChat: async function* () {
      const round = rounds[callIndex++];
      if (!round) throw new Error(`streamChat called more times (call ${callIndex}) than scripted (${rounds.length})`);
      if ("throws" in round) throw round.throws;
      for (const event of round) yield event;
    },
  };
};

const dependencies = (devin: DevinProvider) => ({
  devin, model: "model", contextWindow: 100_000, systemPrompt: [] as const,
  confirmShellCommand: async () => true,
});

describe("createAgentSession", () => {
  describe("multi-subscriber event fan-out", () => {
    let dir: string;

    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "railgun-agentsession-test-")); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it("delivers the identical ordered event sequence to two independent subscribers", async () => {
      const filePath = join(dir, "secret.txt");
      await writeFile(filePath, "the secret is 42", "utf-8");
      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "call-1", delta: JSON.stringify({ path: filePath }) },
          { type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: filePath } }
        ],
        [{ type: "text_delta", delta: "The secret is 42." }]
      ]);
      const session = createAgentSession(dependencies(devin));
      const loggerEvents: AgentSessionEvent[] = [];
      const collectorEvents: AgentSessionEvent[] = [];
      session.subscribe(e => { loggerEvents.push(e); });
      session.subscribe(e => { collectorEvents.push(e); });

      const outcome = await session.run("What is the secret?");

      expect(outcome.ok).toBe(true);
      expect(loggerEvents.map(e => e.type)).toEqual(collectorEvents.map(e => e.type));
      const types = loggerEvents.map(e => e.type);
      const requiredOrder: readonly AgentSessionEvent["type"][] = [
        "agent_start", "turn_start", "message_start", "message_update", "message_end",
        "tool_execution_start", "tool_execution_end", "turn_end", "agent_end", "agent_settled"
      ];
      let cursor = 0;
      for (const required of requiredOrder) {
        const found = types.indexOf(required, cursor);
        expect(found, `expected "${required}" at or after index ${cursor} in ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
        cursor = found + 1;
      }
      expect(types).not.toContain("tool_execution_update");
    });

    it("keeps delivering to a still-subscribed listener after another unsubscribes", async () => {
      const devin = fakeProvider([[{ type: "text_delta", delta: "ok" }]]);
      const session = createAgentSession(dependencies(devin));
      const loggerEvents: AgentSessionEvent[] = [];
      const collectorEvents: AgentSessionEvent[] = [];
      const unsubscribeLogger = session.subscribe(e => { loggerEvents.push(e); });
      session.subscribe(e => { collectorEvents.push(e); });
      unsubscribeLogger();

      const outcome = await session.run("hello");

      expect(outcome.ok).toBe(true);
      expect(loggerEvents).toHaveLength(0);
      expect(collectorEvents.map(e => e.type)).toContain("agent_start");
      expect(collectorEvents.map(e => e.type)).toContain("agent_end");
      expect(collectorEvents.map(e => e.type)).toContain("agent_settled");
    });
  });

  it("emits queue_update on steer enqueue and again once the injection dequeues it", async () => {
    const gate = Promise.withResolvers<void>();
    let call = 0;
    const devin: DevinProvider = {
      ...fakeProvider([]),
      streamChat: async function* () {
        if (call++ === 0) await gate.promise;
        yield { type: "text_delta", delta: "done" };
      },
    };
    const session = createAgentSession(dependencies(devin));
    const events: AgentSessionEvent[] = [];
    session.subscribe(e => { events.push(e); });

    const running = session.run("hello");
    await Promise.resolve();
    session.steer("steer me");

    const enqueueUpdate = events.filter(e => e.type === "queue_update").at(-1);
    expect(enqueueUpdate).toEqual({ type: "queue_update", steering: ["steer me"], followUp: [] });

    gate.resolve();
    await running;

    const dequeueUpdate = events.filter(e => e.type === "queue_update").at(-1);
    expect(dequeueUpdate).toEqual({ type: "queue_update", steering: [], followUp: [] });
  });

  describe("agent_settled fires exactly once per run() call", () => {
    it("on normal completion", async () => {
      const devin = fakeProvider([[{ type: "text_delta", delta: "ok" }]]);
      const session = createAgentSession(dependencies(devin));
      const events: AgentSessionEvent[] = [];
      session.subscribe(e => { events.push(e); });

      const outcome = await session.run("hello");

      expect(outcome.ok).toBe(true);
      expect(events.filter(e => e.type === "agent_settled")).toHaveLength(1);
    });

    it("on an aborted run", async () => {
      let calls = 0;
      const devin: DevinProvider = {
        ...fakeProvider([]),
        streamChat: async function* ({ signal }) {
          if (calls++ > 0) { yield { type: "text_delta", delta: "recovered" }; return; }
          yield { type: "text_delta", delta: "partial" };
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      };
      const session = createAgentSession(dependencies(devin));
      const events: AgentSessionEvent[] = [];
      session.subscribe(e => { events.push(e); });

      const running = session.run("stop me");
      await Promise.resolve();
      session.abort();
      const outcome = await running;

      expect(outcome).toMatchObject({ ok: false, aborted: true });
      expect(events.filter(e => e.type === "agent_settled")).toHaveLength(1);
    });

    it("on a fatal non-recoverable error", async () => {
      const err = new DevinApiError("unauthorized", 401);
      const devin = fakeProvider([{ throws: err }]);
      const session = createAgentSession(dependencies(devin));
      const events: AgentSessionEvent[] = [];
      session.subscribe(e => { events.push(e); });

      const outcome = await session.run("hello");

      expect(outcome).toEqual({ ok: false, error: err });
      expect(events.filter(e => e.type === "agent_settled")).toHaveLength(1);
    });
  });

  it("rejects steer/followUp on an idle session without mutating the queue mirror or emitting queue_update", () => {
    const devin = fakeProvider([]);
    const session = createAgentSession(dependencies(devin));
    const events: AgentSessionEvent[] = [];
    session.subscribe(e => { events.push(e); });

    expect(() => session.steer("idle")).toThrow(/not running/i);
    expect(() => session.followUp("idle")).toThrow(/not running/i);
    expect(events.filter(e => e.type === "queue_update")).toHaveLength(0);
  });
});
