import type { AgentEvent } from "@railgun/core/agent/events.js";
import type { TodoState } from "@railgun/core/tools/todo.js";

// Client → Server (commands)
export type GatewayCommand =
  | { id: string; type: "prompt"; message: string }
  | { id: string; type: "steer"; message: string }
  | { id: string; type: "follow_up"; message: string }
  | { id: string; type: "abort" }
  | { id: string; type: "get_state" }
  | { id: string; type: "get_available_models" }
  | { id: string; type: "set_model"; modelId: string }
  | { id: string; type: "compact" }
  | { id: string; type: "approve"; approved: boolean }
  | { id: string; type: "clarify_response"; answer: string }
  | { id: string; type: "update_config"; patch: Record<string, unknown> }
  | { id: string; type: "trust_response"; choice: string };

// Server → Client (events + responses)
export type GatewayEvent =
  | { type: "event"; event: AgentEvent }
  | { type: "response"; id: string; command: string; success: boolean; data?: unknown; error?: string }
  | { type: "approval_request"; command: string }
  | { type: "clarify_request"; question: string; choices?: string[] }
  | { type: "state_update"; state: GatewaySessionState };

export interface GatewaySessionState {
  readonly running: boolean;
  readonly model: string;
  readonly messageCount: number;
  readonly todos: TodoState;
}

export const parseGatewayCommand = (raw: unknown): GatewayCommand | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["id"] !== "string") return null;
  if (typeof obj["type"] !== "string") return null;
  return raw as GatewayCommand;
};
