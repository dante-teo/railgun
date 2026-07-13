import { vi } from "vitest";

/**
 * Primitive WebSocket harness shared across gateway tests.
 *
 * Returns a `FakeWebSocket` class stubbed onto `globalThis.WebSocket`, plus
 * helpers for driving the socket synchronously without real network I/O.
 * Each test file composes its own higher-level helpers on top of these
 * primitives.
 */
export interface FakeSocketPrimitives {
  /** Simulate the socket becoming open and fire the `onopen` handler. */
  readonly simulateOpen: () => void;
  /** Simulate an incoming message (value is JSON-serialized before delivery). */
  readonly simulateMessage: (data: unknown) => void;
  /** Simulate the socket closing and fire the `onclose` handler. */
  readonly simulateClose: () => void;
  /** All raw JSON strings sent through `socket.send()`. */
  readonly rawSent: readonly string[];
}

/**
 * Install a `FakeWebSocket` on `globalThis.WebSocket` and return drive helpers.
 * Call `vi.unstubAllGlobals()` in `afterEach` to clean up.
 */
export const installFakeWebSocket = (): FakeSocketPrimitives => {
  let onopen: (() => void) | null = null;
  let onmessage: ((e: { data: string }) => void) | null = null;
  let onclose: (() => void) | null = null;
  let _readyState = 0;
  const sent: string[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    get readyState(): number { return _readyState; }
    set onopen(fn: (() => void) | null) { onopen = fn; }
    set onmessage(fn: ((e: { data: string }) => void) | null) { onmessage = fn; }
    set onclose(fn: (() => void) | null) { onclose = fn; }
    set onerror(_fn: unknown) { /* onerror is always followed by onclose */ }
    send(data: string): void { sent.push(data); }
    close(): void { _readyState = 3; }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);

  return {
    simulateOpen: () => { _readyState = 1; onopen?.(); },
    simulateMessage: (data: unknown) => onmessage?.({ data: JSON.stringify(data) }),
    simulateClose: () => { _readyState = 3; onclose?.(); },
    rawSent: sent,
  };
};
