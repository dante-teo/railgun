import type { DevinMessage, DevinStreamEvent } from "widevin";
import type { UsageTotals } from "./compaction.js";

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: readonly DevinMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: DevinMessage; toolResults: readonly ToolResult[]; usage?: UsageTotals }
  | { type: "message_start"; message: DevinMessage }
  | { type: "message_update"; streamEvent: DevinStreamEvent }
  | { type: "message_end"; message: DevinMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult }
  | { type: "compaction_start"; reason: "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "threshold" | "overflow" }
  | { type: "moa_reference_start"; index: number; count: number; model: string }
  | { type: "moa_reference_end"; index: number; model: string; text: string }
  | { type: "moa_aggregating"; aggregator: string; refCount: number }
  | { type: "subagent_start"; goal: string; index: number; count: number }
  | { type: "subagent_end"; goal: string; index: number; result: string };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
