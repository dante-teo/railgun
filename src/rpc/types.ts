import type { DevinMessage, DevinModel } from "widevin";
import type { TodoState } from "../tools/todo.js";

export const RPC_PROTOCOL_VERSION = 1 as const;

export const RPC_PROTOCOL_CAPABILITIES = Object.freeze([
  "sessions",
  "interaction.approval",
  "interaction.clarification",
  "config",
  "mcp",
  "cron",
  "memory",
  "notes",
  "dream",
  "instructions",
  "skills",
] as const);

export type RpcCapability = typeof RPC_PROTOCOL_CAPABILITIES[number];
export type RpcPersistenceStatus = "unsaved" | "saved" | "error";

export type RpcCommand =
  | { id?: string; type: "initialize"; version: number; clientName?: string }
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "set_model"; modelId: string }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "compact" }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "approval_response"; requestId: string; approved: boolean }
  | { id?: string; type: "clarification_response"; requestId: string; answer: string }
  | { id?: string; type: "session_new"; modelId?: string }
  | { id?: string; type: "session_list" }
  | { id?: string; type: "session_list_archived" }
  | { id?: string; type: "session_load"; sessionId: string; includeMessages?: boolean }
  | { id?: string; type: "session_archive"; sessionId: string }
  | { id?: string; type: "session_unarchive"; sessionId: string }
  | { id?: string; type: "session_save" }
  | { id?: string; type: "session_branch"; messageId: number; summarize?: boolean; includeMessages?: boolean }
  | { id?: string; type: "session_fork"; sessionId?: string; includeMessages?: boolean }
  | { id?: string; type: "session_recent_messages"; sessionId?: string; limit?: number }
  | { id?: string; type: "session_transcript"; sessionId: string; cursor?: number; limit?: number }
  | { id?: string; type: "config_get" }
  | { id?: string; type: "config_update"; patch: Record<string, unknown> }
  | { id?: string; type: "mcp_list" }
  | { id?: string; type: "mcp_upsert"; name: string; command: string; args?: readonly string[]; env?: Record<string, string | null> }
  | { id?: string; type: "mcp_remove"; name: string }
  | { id?: string; type: "cron_list"; cursor?: number; limit?: number; editableOnly?: boolean; maxPromptLength?: number }
  | { id?: string; type: "cron_add"; schedule: string; prompt: string; jobId?: string; includeJob?: boolean }
  | { id?: string; type: "cron_update"; jobId: string; patch: { schedule?: string; prompt?: string }; includeJob?: boolean }
  | { id?: string; type: "cron_remove"; jobId: string }
  | { id?: string; type: "memory_list"; limit?: number }
  | { id?: string; type: "memory_search"; query: string; limit?: number }
  | { id?: string; type: "memory_create"; content: string; category: string }
  | { id?: string; type: "memory_update"; memoryId: string; patch: { content?: string; category?: string } }
  | { id?: string; type: "memory_delete"; memoryId: string }
  | { id?: string; type: "notes_import"; folderPath: string; semantic?: boolean }
  | { id?: string; type: "notes_search"; query: string; mode?: "keyword" | "semantic"; limit?: number }
  | { id?: string; type: "dream_run" }
  | { id?: string; type: "instruction_files_list" }
  | { id?: string; type: "instruction_file_get"; fileId: string }
  | { id?: string; type: "instruction_file_update"; fileId: string; content: string }
  | { id?: string; type: "skills_list" }
  | { id?: string; type: "skill_get"; name: string };

export interface RpcInitializeResult {
  readonly version: typeof RPC_PROTOCOL_VERSION;
  readonly capabilities: readonly RpcCapability[];
}

export type RpcSuccessResponse =
  | { id?: string; type: "response"; command: "prompt" | "steer" | "follow_up" | "abort" | "set_model" | "compact" | "set_auto_compaction"; success: true }
  | { id?: string; type: "response"; command: "initialize"; success: true; data: RpcInitializeResult }
  | { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
  | { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: readonly DevinMessage[] } }
  | { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: readonly DevinModel[] } }
  | { id?: string; type: "response"; command: string; success: true; data?: unknown };

export type RpcErrorResponse = { id?: string; type: "response"; command: string; success: false; error: string };
export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export interface RpcSessionState {
  readonly running: boolean;
  readonly model: string;
  readonly messageCount: number;
  readonly todos: TodoState;
  readonly protocolVersion?: typeof RPC_PROTOCOL_VERSION;
  readonly sessionId?: string;
  readonly startedAt?: string;
  readonly persistence?: RpcPersistenceStatus;
  readonly checkpointError?: string;
}

export interface RpcApprovalRequest {
  readonly type: "approval_request";
  readonly requestId: string;
  readonly command: string;
}

export interface RpcClarificationRequest {
  readonly type: "clarification_request";
  readonly requestId: string;
  readonly question: string;
  readonly choices?: readonly string[];
}

export type RpcInteractionRequest = RpcApprovalRequest | RpcClarificationRequest;
