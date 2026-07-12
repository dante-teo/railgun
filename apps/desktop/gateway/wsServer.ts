import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import type { DevinSession } from "@railgun/core/session.js";
import type { AppConfig } from "@railgun/core/config.js";
import type { GatewayEvent, GatewayCommand } from "./protocol.js";
import { parseGatewayCommand } from "./protocol.js";
import { createSessionManager } from "./sessionManager.js";

export interface WsServerOptions {
  readonly port?: number;
  readonly devinSession: DevinSession;
  readonly config: AppConfig;
}

export interface WsServerHandle {
  readonly port: number;
  readonly close: () => void;
}

export const startWsServer = (options: WsServerOptions): Promise<WsServerHandle> => {
  const { port = 0, devinSession, config } = options;

  const { promise, resolve, reject } = Promise.withResolvers<WsServerHandle>();

  const wss = new WebSocketServer({ host: "localhost", port });

  // One active client at a time
  let activeClient: WebSocket | null = null;

  const send = (event: GatewayEvent): void => {
    if (activeClient?.readyState === WebSocket.OPEN) {
      activeClient.send(JSON.stringify(event));
    }
  };

  const manager = createSessionManager({ devinSession, config, onEvent: send });

  wss.on("error", (err: Error) => {
    reject(err);
  });

  wss.on("listening", () => {
    const addr = wss.address();
    const listenPort = typeof addr === "object" && addr !== null ? addr.port : port;

    resolve({
      port: listenPort,
      close: () => { wss.close(); },
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    // Disconnect previous client if any
    if (activeClient !== null && activeClient.readyState === WebSocket.OPEN) {
      activeClient.close();
    }
    activeClient = ws;

    ws.on("message", (data: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      const cmd = parseGatewayCommand(parsed);
      if (cmd === null) return;

      dispatchCommand(cmd);
    });

    ws.on("close", () => {
      if (activeClient === ws) activeClient = null;
    });
  });

  const dispatchCommand = (cmd: GatewayCommand): void => {
    switch (cmd.type) {
      case "prompt":
        manager.runPrompt(cmd.id, cmd.message);
        break;
      case "steer":
        manager.steer(cmd.id, cmd.message);
        break;
      case "follow_up":
        manager.followUp(cmd.id, cmd.message);
        break;
      case "abort":
        manager.abort(cmd.id);
        break;
      case "get_state":
        manager.getState(cmd.id);
        break;
      case "get_available_models":
        manager.getAvailableModels(cmd.id);
        break;
      case "set_model":
        manager.setModel(cmd.id, cmd.modelId);
        break;
      case "compact":
        manager.compact(cmd.id);
        break;
      case "approve":
        manager.resolveApproval(cmd.approved);
        break;
      case "clarify_response":
        manager.resolveClarify(cmd.answer);
        break;
      case "trust_response":
        // trust decisions are handled by the renderer; gateway just acknowledges
        break;
      default: {
        const _exhaustive: never = cmd;
        void _exhaustive;
      }
    }
  };

  return promise;
};
