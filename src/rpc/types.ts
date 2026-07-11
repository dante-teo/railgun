import type { DevinMessage, DevinModel } from "widevin";
import type { TodoState } from "../tools/todo.js";

export type RpcCommand =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "set_model"; modelId: string }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "compact" }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean };

export type RpcSuccessResponse =
  | { id?: string; type: "response"; command: "prompt"; success: true }
  | { id?: string; type: "response"; command: "steer"; success: true }
  | { id?: string; type: "response"; command: "follow_up"; success: true }
  | { id?: string; type: "response"; command: "abort"; success: true }
  | { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
  | { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: readonly DevinMessage[] } }
  | { id?: string; type: "response"; command: "set_model"; success: true }
  | { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: readonly DevinModel[] } }
  | { id?: string; type: "response"; command: "compact"; success: true }
  | { id?: string; type: "response"; command: "set_auto_compaction"; success: true };

export type RpcErrorResponse = { id?: string; type: "response"; command: string; success: false; error: string };

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export interface RpcSessionState {
  readonly running: boolean;
  readonly model: string;
  readonly messageCount: number;
  readonly todos: TodoState;
}
