import { describe, expect, it, vi } from "vitest";
import { client, methods } from "@agentclientprotocol/sdk";
import type { AgentApp, ClientContext } from "@agentclientprotocol/sdk";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import type { DevinSession } from "../session.js";
import type { AppConfig } from "../config.js";
import { createAcpApp } from "./acpMode.js";

type FakeRound = readonly DevinStreamEvent[];

const fakeProvider = (rounds: readonly FakeRound[]): DevinProvider => {
  let callIndex = 0;
  return {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(),
    listModels: vi.fn(async () => []),
    streamChat: async function* () {
      const round = rounds[callIndex++];
      if (!round) return;
      for (const event of round) yield event;
    },
  };
};

/** A provider whose streamChat blocks until `release()` is called; signals entry via the returned promise. Yields nothing when aborted before release. */
const makeGatedProvider = (): { devin: DevinProvider; entered: Promise<void>; release: () => void } => {
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  const { promise: releaseGate, resolve: release } = Promise.withResolvers<void>();
  const devin: DevinProvider = {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), listModels: vi.fn(async () => []),
    streamChat: async function* (req) {
      signalEntered();
      await releaseGate;
      // Do not yield if aborted — causes the agent to return an aborted outcome
      if (req.signal?.aborted) return;
      yield { type: "done", reason: "stop" } as const;
    },
  };
  return { devin, entered, release };
};

const fakeSession = (devin: DevinProvider): DevinSession => ({
  devin,
  model: {
    id: "test-model", name: "Test Model", provider: "devin" as const,
    baseUrl: "https://api.example.com", input: ["text"] as const,
    supportsTools: true as const, contextWindow: 100_000, maxTokens: 4096, reasoning: false,
  },
  systemPrompt: [],
});

const fakeConfig = (): AppConfig => ({ model: null, defaultProjectTrust: "ask", approvalMode: "off" });

/** Connects an in-process client to the agent app and runs `op`, then closes. */
const withClient = <T>(
  agentApp: AgentApp,
  op: (ctx: ClientContext) => Promise<T>,
): Promise<T> =>
  client({ name: "test-client" }).connectWith(agentApp, op);

describe("createAcpApp", () => {
  it("initialize returns protocolVersion 1 and loadSession: false", async () => {
    const devin = fakeProvider([]);
    const agentApp = createAcpApp({ session: fakeSession(devin), config: fakeConfig() });

    const result = await withClient(agentApp, (ctx) =>
      ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }),
    );

    expect(result).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
    });
  });

  it("session/new returns a non-empty sessionId string", async () => {
    const devin = fakeProvider([]);
    const agentApp = createAcpApp({ session: fakeSession(devin), config: fakeConfig() });

    const result = await withClient(agentApp, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      return ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    });

    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it("session/prompt with text-only prompt returns stopReason end_turn and streams agent_message_chunk", async () => {
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "Hello" }, { type: "text_delta", delta: " world" }, { type: "done", reason: "stop" }],
    ]);
    const agentApp = createAcpApp({ session: fakeSession(devin), config: fakeConfig() });

    const updateKinds: string[] = [];

    const result = await withClient(agentApp, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });

      // ActiveSession handles session/new and routes notifications for its sessionId
      using session = await ctx.buildSession({ cwd: process.cwd(), mcpServers: [] }).start();

      const [promptResult] = await Promise.all([
        session.prompt([{ type: "text", text: "What is 2+2?" }]),
        (async () => {
          while (true) {
            const msg = await session.nextUpdate();
            if (msg.kind === "stop") break;
            updateKinds.push(msg.update.sessionUpdate);
          }
        })(),
      ]);

      return promptResult;
    });

    expect(result).toMatchObject({ stopReason: "end_turn" });
    expect(updateKinds).toContain("agent_message_chunk");
  });

  it("session/prompt against unknown sessionId throws a JSON-RPC error", async () => {
    const devin = fakeProvider([]);
    const agentApp = createAcpApp({ session: fakeSession(devin), config: fakeConfig() });

    await expect(
      withClient(agentApp, async (ctx) => {
        await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
        return ctx.request(methods.agent.session.prompt, {
          sessionId: "nonexistent-id",
          prompt: [{ type: "text", text: "hello" }],
        });
      }),
    ).rejects.toThrow();
  });

  it("session/prompt streams tool_call and tool_call_update for tool executions", async () => {
    const devin = fakeProvider([
      [
        { type: "toolcall_start", id: "tc1", name: "readFile" },
        { type: "toolcall_delta", id: "tc1", delta: "" },
        { type: "toolcall_end", id: "tc1", name: "readFile", arguments: { path: "/some/file.ts" } },
        { type: "done", reason: "toolUse" },
        { type: "done", reason: "stop" },
      ],
    ]);
    const agentApp = createAcpApp({ session: fakeSession(devin), config: fakeConfig() });

    const updateKinds: string[] = [];

    await withClient(agentApp, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });

      using session = await ctx.buildSession({ cwd: process.cwd(), mcpServers: [] }).start();

      await Promise.all([
        session.prompt([{ type: "text", text: "read a file" }]),
        (async () => {
          while (true) {
            const msg = await session.nextUpdate();
            if (msg.kind === "stop") break;
            updateKinds.push(msg.update.sessionUpdate);
          }
        })(),
      ]);
    });

    expect(updateKinds).toContain("tool_call");
    expect(updateKinds).toContain("tool_call_update");
  });

  it("session/cancel aborts a running prompt and the response has stopReason cancelled", async () => {
    const { devin, entered, release } = makeGatedProvider();
    const agentApp = createAcpApp({ session: fakeSession(devin), config: fakeConfig() });

    const result = await withClient(agentApp, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });

      const [promptResult] = await Promise.all([
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "long task" }],
        }),
        (async () => {
          await entered;
          await ctx.notify(methods.agent.session.cancel, { sessionId });
          release();
        })(),
      ]);

      return promptResult;
    });

    expect(result).toMatchObject({ stopReason: "cancelled" });
  });
});
