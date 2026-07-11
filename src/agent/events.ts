import type { DevinMessage, DevinStreamEvent } from "widevin";

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: readonly DevinMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: DevinMessage; toolResults: readonly ToolResult[] }
  | { type: "message_start"; message: DevinMessage }
  | { type: "message_update"; streamEvent: DevinStreamEvent }
  | { type: "message_end"; message: DevinMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult }
  | { type: "compaction_start"; reason: "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "threshold" | "overflow" };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
