import { describe, expect, it, vi, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { DevinProvider } from "widevin";
import type { DevinSession } from "@railgun/core/session.js";
import type { AppConfig } from "@railgun/core/config.js";
import type { WsServerHandle } from "./wsServer.js";
import { startWsServer } from "./wsServer.js";
import type { GatewayEvent, GatewayCommand } from "./protocol.js";

// ── Fake providers ────────────────────────────────────────────────────────────

const fakeProvider = (): DevinProvider => ({
  login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(),
  listModels: vi.fn(async () => []),
  streamChat: async function* () {
    yield { type: "text_delta", delta: "Hello" } as const;
    yield { type: "done", reason: "stop" } as const;
  },
});

const makeGatedProvider = (): {
  devin: DevinProvider;
  entered: Promise<void>;
  release: () => void;
} => {
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  const { promise: releaseGate, resolve: release } = Promise.withResolvers<void>();
  const devin: DevinProvider = {
    login: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(),
    listModels: vi.fn(async () => []),
    streamChat: async function* (req) {
      signalEntered();
      await releaseGate;
      if (req.signal?.aborted) return;
      yield { type: "done", reason: "stop" } as const;
    },
  };
  return { devin, entered, release };
};

const fakeDevinSession = (devin: DevinProvider): DevinSession => ({
  devin,
  model: {
    id: "test-model", name: "Test Model", provider: "devin" as const,
    baseUrl: "https://api.example.com", input: ["text"] as const,
    supportsTools: true as const, contextWindow: 100_000, maxTokens: 4096, reasoning: false,
  },
  systemPrompt: [],
});

const fakeConfig = (): AppConfig => ({ model: null, defaultProjectTrust: "ask", approvalMode: "off" });

// ── Test client helpers ───────────────────────────────────────────────────────

const connectClient = (port: number): Promise<WebSocket> => {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
  return promise;
};

/**
 * Returns a live array of received events AND a function that resolves
 * the next event matching a predicate by listening to the "message" event —
 * no polling, no real timers.
 */
const makeEventCollector = (ws: WebSocket): {
  events: GatewayEvent[];
  next: (predicate: (e: GatewayEvent) => boolean) => Promise<GatewayEvent>;
} => {
  const events: GatewayEvent[] = [];
  const waiters: Array<{ predicate: (e: GatewayEvent) => boolean; resolve: (e: GatewayEvent) => void }> = [];

  ws.on("message", (data: RawData) => {
    const event = JSON.parse(data.toString()) as GatewayEvent;
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter && waiter.predicate(event)) {
        waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  });

  const next = (predicate: (e: GatewayEvent) => boolean): Promise<GatewayEvent> => {
    // Check already-collected events first
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<GatewayEvent>();
    waiters.push({ predicate, resolve });
    return promise;
  };

  return { events, next };
};

const send = (ws: WebSocket, cmd: GatewayCommand): void => {
  ws.send(JSON.stringify(cmd));
};

// ── Suite setup ───────────────────────────────────────────────────────────────

describe("wsServer", () => {
  const handles: WsServerHandle[] = [];
  const clients: WebSocket[] = [];

  afterEach(() => {
    for (const ws of clients) ws.terminate();
    clients.length = 0;
    for (const h of handles) h.close();
    handles.length = 0;
  });

  const startServer = async (devin: DevinProvider): Promise<{
    handle: WsServerHandle;
    ws: WebSocket;
    events: GatewayEvent[];
    next: (predicate: (e: GatewayEvent) => boolean) => Promise<GatewayEvent>;
  }> => {
    const handle = await startWsServer({ devinSession: fakeDevinSession(devin), config: fakeConfig() });
    handles.push(handle);
    const ws = await connectClient(handle.port);
    clients.push(ws);
    const { events, next } = makeEventCollector(ws);
    return { handle, ws, events, next };
  };

  // ── Tests ───────────────────────────────────────────────────────────────────

  it("responds to get_state with running=false and empty todos", async () => {
    const { ws, next } = await startServer(fakeProvider());

    send(ws, { id: "s1", type: "get_state" });
    const resp = await next(e => e.type === "response" && e.id === "s1");

    expect(resp).toMatchObject({
      type: "response", id: "s1", command: "get_state", success: true,
      data: { running: false, model: "test-model", messageCount: 0 },
    });
  });

  it("streams agent events and responds success after prompt completes", async () => {
    const { ws, next, events } = await startServer(fakeProvider());

    send(ws, { id: "p1", type: "prompt", message: "Hi" });

    const resp = await next(e => e.type === "response" && e.id === "p1");
    expect(resp).toMatchObject({ type: "response", id: "p1", command: "prompt", success: true });

    // At least one wrapped agent event must have been received
    const agentEvents = events.filter(e => e.type === "event");
    expect(agentEvents.length).toBeGreaterThan(0);
  });

  it("rejects second prompt while one is running", async () => {
    const { devin, entered } = makeGatedProvider();
    const { ws, next } = await startServer(devin);

    send(ws, { id: "p1", type: "prompt", message: "First" });
    await entered;

    send(ws, { id: "p2", type: "prompt", message: "Second" });
    const resp = await next(e => e.type === "response" && e.id === "p2");

    expect(resp).toMatchObject({ type: "response", id: "p2", command: "prompt", success: false });
  });

  it("abort stops a running prompt and responds", async () => {
    const { devin, entered, release } = makeGatedProvider();
    const { ws, next } = await startServer(devin);

    send(ws, { id: "p1", type: "prompt", message: "Run" });
    await entered;

    send(ws, { id: "a1", type: "abort" });
    const abortResp = await next(e => e.type === "response" && e.id === "a1");
    expect(abortResp).toMatchObject({ type: "response", id: "a1", command: "abort", success: true });

    release();
    // prompt eventually settles with a response (success or aborted)
    await next(e => e.type === "response" && e.id === "p1");
  });

  it("set_model updates the model returned by get_state", async () => {
    const { ws, next } = await startServer(fakeProvider());

    send(ws, { id: "sm1", type: "set_model", modelId: "new-model" });
    await next(e => e.type === "response" && e.id === "sm1");

    send(ws, { id: "gs1", type: "get_state" });
    const stateResp = await next(e => e.type === "response" && e.id === "gs1");
    expect(stateResp).toMatchObject({ type: "response", data: { model: "new-model" } });
  });

  it("get_available_models returns model list", async () => {
    const devin = fakeProvider();
    (devin.listModels as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    const { ws, next } = await startServer(devin);

    send(ws, { id: "gm1", type: "get_available_models" });
    const resp = await next(e => e.type === "response" && e.id === "gm1");
    expect(resp).toMatchObject({
      type: "response", id: "gm1", command: "get_available_models", success: true,
      data: { models: [{ id: "m1" }, { id: "m2" }] },
    });
  });

  it("sends state_update after prompt completes", async () => {
    const { ws, next } = await startServer(fakeProvider());

    send(ws, { id: "p1", type: "prompt", message: "Hi" });
    await next(e => e.type === "response" && e.id === "p1");

    const stateUpdate = await next(e => e.type === "state_update");
    expect(stateUpdate).toMatchObject({ type: "state_update", state: { running: false } });
  });

  it("update_config responds success", async () => {
    const { ws, next } = await startServer(fakeProvider());

    send(ws, { id: "uc1", type: "update_config", patch: { approvalMode: "off" } });
    const resp = await next(e => e.type === "response" && e.id === "uc1");

    expect(resp).toMatchObject({
      type: "response", id: "uc1", command: "update_config", success: true,
    });
  });
});
