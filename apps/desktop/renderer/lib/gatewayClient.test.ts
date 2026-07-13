import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GatewayClient } from "./gatewayClient.js";
import { createGatewayClient } from "./gatewayClient.js";
import type { GatewayEvent } from "../../gateway/protocol.js";

// ---------------------------------------------------------------------------
// Mock WebSocket harness
// ---------------------------------------------------------------------------
// Builds a fake WebSocket class that exposes simulateOpen/simulateMessage/
// simulateClose helpers for driving tests synchronously.

interface MockHarness {
  readonly client: GatewayClient;
  readonly getSent: () => unknown[];
  readonly simulateOpen: () => void;
  readonly simulateMessage: (data: unknown) => void;
  readonly simulateClose: () => void;
}

const buildHarness = (): MockHarness => {
  let onopen: (() => void) | null = null;
  let onmessage: ((e: { data: string }) => void) | null = null;
  let onclose: (() => void) | null = null;
  let _readyState = 0;
  const sent: string[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    get readyState() { return _readyState; }
    set onopen(fn: (() => void) | null) { onopen = fn; }
    set onmessage(fn: ((e: { data: string }) => void) | null) { onmessage = fn; }
    set onclose(fn: (() => void) | null) { onclose = fn; }
    set onerror(_fn: unknown) { /* ignored */ }
    send(data: string): void { sent.push(data); }
    close(): void { _readyState = 3; }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);

  const client = createGatewayClient("ws://localhost:9400");

  return {
    client,
    getSent: () => sent.map(s => JSON.parse(s) as unknown),
    simulateOpen: () => { _readyState = 1; onopen?.(); },
    simulateMessage: (data: unknown) => onmessage?.({ data: JSON.stringify(data) }),
    simulateClose: () => { _readyState = 3; onclose?.(); },
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGatewayClient", () => {
  let h: MockHarness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.client.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("1. starts with connecting status", () => {
    expect(h.client.status()).toBe("connecting");
  });

  it("2. transitions to connected after open", () => {
    h.simulateOpen();
    expect(h.client.status()).toBe("connected");
  });

  it("3. sends command as JSON with the provided id", () => {
    h.simulateOpen();
    h.client.send({ id: "cmd-1", type: "prompt", message: "hello" });
    expect(h.getSent()).toEqual([{ id: "cmd-1", type: "prompt", message: "hello" }]);
  });

  it("4. does not send when socket is not open", () => {
    // CONNECTING state — send must be a no-op
    h.client.send({ id: "cmd-1", type: "abort" });
    expect(h.getSent()).toHaveLength(0);
  });

  it("5. subscribe receives non-response events", () => {
    const received: GatewayEvent[] = [];
    h.client.subscribe(ev => received.push(ev));
    h.simulateOpen();

    const event: GatewayEvent = { type: "approval_request", command: "rm -rf /" };
    h.simulateMessage(event);

    expect(received).toEqual([event]);
  });

  it("6. subscribe returns an unsubscribe function that stops delivery", () => {
    const received: GatewayEvent[] = [];
    const unsub = h.client.subscribe(ev => received.push(ev));
    h.simulateOpen();

    const event: GatewayEvent = { type: "approval_request", command: "ls" };
    h.simulateMessage(event);
    expect(received).toHaveLength(1);

    unsub();
    h.simulateMessage(event);
    expect(received).toHaveLength(1); // still 1 — no new deliveries
  });

  it("7. request resolves when matching response arrives", async () => {
    h.simulateOpen();

    const promise = h.client.request({ id: "cmd-42", type: "get_state" });
    h.simulateMessage({ type: "response", id: "cmd-42", command: "get_state", success: true, data: { running: false } });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ running: false });
  });

  it("8. request resolves with success=false when response carries an error", async () => {
    h.simulateOpen();

    const promise = h.client.request({ id: "cmd-99", type: "get_state" });
    h.simulateMessage({ type: "response", id: "cmd-99", command: "get_state", success: false, error: "not found" });

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("not found");
  });

  it("9. response events are not broadcast to subscribers", async () => {
    const received: GatewayEvent[] = [];
    h.client.subscribe(ev => received.push(ev));
    h.simulateOpen();

    const promise = h.client.request({ id: "cmd-1", type: "get_state" });
    h.simulateMessage({ type: "response", id: "cmd-1", command: "get_state", success: true });
    await promise;

    expect(received).toHaveLength(0);
  });

  it("10. request resolves with timeout error after 10s", async () => {
    vi.useFakeTimers();
    h.simulateOpen();

    const promise = h.client.request({ id: "cmd-timeout", type: "get_state" });
    await vi.advanceTimersByTimeAsync(10_001);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("11. status becomes disconnected after the socket closes", () => {
    h.simulateOpen();
    expect(h.client.status()).toBe("connected");
    h.simulateClose();
    expect(h.client.status()).toBe("disconnected");
  });

  it("12. close() rejects pending requests with a closed error", async () => {
    h.simulateOpen();

    const promise = h.client.request({ id: "cmd-1", type: "get_state" });
    h.client.close();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/closed/i);
  });
});
