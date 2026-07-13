import type { GatewayCommand, GatewayEvent } from "../../gateway/protocol.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface GatewayResponse {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface GatewayClient {
  readonly send: (cmd: GatewayCommand) => void;
  readonly request: (cmd: GatewayCommand) => Promise<GatewayResponse>;
  readonly subscribe: (listener: (event: GatewayEvent) => void) => () => void;
  readonly close: () => void;
  readonly status: () => ConnectionStatus;
}

interface PendingRequest {
  readonly resolve: (response: GatewayResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export const createGatewayClient = (url: string): GatewayClient => {
  let ws: WebSocket | null = null;
  let connectionStatus: ConnectionStatus = "connecting";
  let closed = false;
  let backoffIndex = 0;

  const listeners = new Set<(event: GatewayEvent) => void>();
  const pending = new Map<string, PendingRequest>();

  const broadcast = (event: GatewayEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const connect = (): void => {
    if (closed) return;
    connectionStatus = "connecting";
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      if (closed) { socket.close(); return; }
      connectionStatus = "connected";
      backoffIndex = 0;
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let gatewayEvent: GatewayEvent;
      try {
        gatewayEvent = JSON.parse(event.data) as GatewayEvent;
      } catch {
        return;
      }

      if (gatewayEvent.type === "response") {
        const entry = pending.get(gatewayEvent.id);
        if (entry !== undefined) {
          clearTimeout(entry.timer);
          pending.delete(gatewayEvent.id);
          entry.resolve({ success: gatewayEvent.success, data: gatewayEvent.data, error: gatewayEvent.error });
        }
        return;
      }

      broadcast(gatewayEvent);
    };

    socket.onclose = () => {
      if (socket !== ws) return; // superseded
      connectionStatus = "disconnected";
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onerror is always followed by onclose; let onclose drive reconnect
    };
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = BACKOFF_DELAYS_MS[Math.min(backoffIndex, BACKOFF_DELAYS_MS.length - 1)] ?? 8000;
    backoffIndex = Math.min(backoffIndex + 1, BACKOFF_DELAYS_MS.length - 1);
    setTimeout(connect, delay);
  };

  const send = (cmd: GatewayCommand): void => {
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    }
  };

  const request = (cmd: GatewayCommand): Promise<GatewayResponse> =>
    new Promise<GatewayResponse>(resolve => {
      const timer = setTimeout(() => {
        pending.delete(cmd.id);
        resolve({ success: false, error: "Request timed out" });
      }, REQUEST_TIMEOUT_MS);

      pending.set(cmd.id, { resolve, timer });
      send(cmd);
    });

  const subscribe = (listener: (event: GatewayEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  const close = (): void => {
    closed = true;
    connectionStatus = "disconnected";
    ws?.close();
    ws = null;
    // Reject all pending requests; snapshot keys first to avoid mutating while iterating
    const pendingEntries = [...pending.entries()];
    pending.clear();
    for (const [, entry] of pendingEntries) {
      clearTimeout(entry.timer);
      entry.resolve({ success: false, error: "Client closed" });
    }
  };

  const status = (): ConnectionStatus => connectionStatus;

  connect();

  return { send, request, subscribe, close, status };
};

/** Generate a monotonic command id. */
let globalSeq = 0;
export const nextCmdId = (): string => `cmd-${++globalSeq}`;
