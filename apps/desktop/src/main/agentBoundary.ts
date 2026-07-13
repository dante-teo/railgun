import { DesktopAgentEventSchema } from "../shared/schemas";
import type { DesktopAgentEvent } from "../shared/types";

export const toDesktopAgentEvent = (value: unknown): DesktopAgentEvent | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  let event: DesktopAgentEvent | undefined;
  switch (record.type) {
    case "agent_start":
      event = { type: "run-start" };
      break;
    case "agent_end":
      event = { type: "run-end" };
      break;
    case "message_update": {
      const streamEvent = record.streamEvent;
      if (typeof streamEvent === "object" && streamEvent !== null) {
        const streamRecord = streamEvent as Record<string, unknown>;
        if (streamRecord.type === "text_delta" && typeof streamRecord.delta === "string") {
          event = { type: "assistant-delta", text: streamRecord.delta };
        }
      }
      break;
    }
    case "tool_execution_start":
      if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
        event = { type: "tool-start", id: record.toolCallId, name: record.toolName };
      }
      break;
    case "tool_execution_end":
      if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
        const result = record.result;
        event = {
          type: "tool-end",
          id: record.toolCallId,
          name: record.toolName,
          failed: typeof result === "object" && result !== null &&
            (result as Record<string, unknown>).isError === true,
        };
      }
      break;
  }
  if (event === undefined) return undefined;
  const parsed = DesktopAgentEventSchema.safeParse(event);
  return parsed.success ? parsed.data : undefined;
};
