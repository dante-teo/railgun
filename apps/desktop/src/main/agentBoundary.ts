import { DESKTOP_ACTIVITY_LIMITS, DesktopAgentEventSchema } from "../shared/schemas";
import type { DesktopAgentEvent } from "../shared/types";
import { parseAdvisoryMessage } from "../../../../src/advisor/advisoryMessage";
import { redactSensitiveText } from "./backendSupervisor";

const SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|token|api[_-]?key)/iu;
const TOKEN_TEXT = /\b(?:Bearer\s+)?(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9._-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;

const bounded = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;

const redactText = (value: string): string =>
  redactSensitiveText(value).replace(TOKEN_TEXT, "[REDACTED]");

const redact = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, seen)]));
};

const formatDetail = (value: unknown): string => {
  let formatted: string;
  if (typeof value === "string") {
    try { formatted = JSON.stringify(redact(JSON.parse(value)), null, 2); }
    catch { formatted = redactText(value); }
  } else {
    try { formatted = JSON.stringify(redact(value), null, 2); }
    catch { formatted = "[Unserializable detail]"; }
  }
  return bounded(formatted, DESKTOP_ACTIVITY_LIMITS.detail);
};

type Todo = NonNullable<Extract<DesktopAgentEvent, { type: "tool-end" }>["todos"]>[number];
const normalizeTodos = (content: unknown): readonly Todo[] | undefined => {
  let parsed = content;
  if (typeof content === "string") {
    try { parsed = JSON.parse(content); } catch { return undefined; }
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).todos)) return undefined;
  const values = (parsed as { todos: unknown[] }).todos;
  if (values.length > DESKTOP_ACTIVITY_LIMITS.todos) return undefined;
  const todos = values.flatMap<Todo>(value => {
    if (typeof value !== "object" || value === null) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.content !== "string") return [];
    const status = item.status === undefined ? "pending" : item.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled") return [];
    return [{
      id: bounded(item.id, DESKTOP_ACTIVITY_LIMITS.id),
      content: bounded(redactText(item.content), DESKTOP_ACTIVITY_LIMITS.content),
      status,
    }];
  });
  return todos.length === values.length ? todos : undefined;
};

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
    case "message_end": {
      const message = record.message;
      if (typeof message === "object" && message !== null &&
        (message as Record<string, unknown>).role === "assistant") {
        event = { type: "assistant-complete" };
      }
      break;
    }
    case "message_start": {
      const message = record.message;
      if (typeof message === "object" && message !== null) {
        const messageRecord = message as Record<string, unknown>;
        if (messageRecord.role === "user" && typeof messageRecord.content === "string") {
          const advisory = parseAdvisoryMessage(messageRecord.content);
          if (advisory !== null && advisory.text !== "") {
            event = { type: "advisor-note", severity: advisory.severity, text: bounded(redactText(advisory.text), DESKTOP_ACTIVITY_LIMITS.content) };
          }
        }
      }
      break;
    }
    case "queue_update":
      if (Array.isArray(record.steering) && record.steering.every(value => typeof value === "string") &&
        Array.isArray(record.followUp) && record.followUp.every(value => typeof value === "string")) {
        event = { type: "queue-update", steering: record.steering, followUp: record.followUp };
      }
      break;
    case "tool_execution_start":
      if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
        event = {
          type: "tool-start",
          id: bounded(record.toolCallId, DESKTOP_ACTIVITY_LIMITS.id),
          name: bounded(record.toolName, DESKTOP_ACTIVITY_LIMITS.toolName),
          ...(record.args === undefined ? {} : { input: formatDetail(record.args) }),
        };
      }
      break;
    case "tool_execution_end":
      if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
        const result = record.result;
        if (typeof result !== "object" || result === null) break;
        const resultRecord = result as Record<string, unknown>;
        if (typeof resultRecord.isError !== "boolean" || typeof resultRecord.content !== "string") break;
        const failed = resultRecord.isError === true;
        const content = resultRecord.content;
        const todos = record.toolName === "todo" && !failed ? normalizeTodos(content) : undefined;
        event = {
          type: "tool-end",
          id: bounded(record.toolCallId, DESKTOP_ACTIVITY_LIMITS.id),
          name: bounded(record.toolName, DESKTOP_ACTIVITY_LIMITS.toolName),
          failed,
          ...(content === undefined || (record.toolName === "todo" && !failed) ? {} : { output: formatDetail(content) }),
          ...(todos === undefined ? {} : { todos }),
        };
      }
      break;
    case "moa_reference_start":
      if (Number.isInteger(record.index) && Number.isInteger(record.count) && typeof record.model === "string") {
        event = { type: "moa-reference-start", index: record.index as number, count: record.count as number, model: bounded(record.model, DESKTOP_ACTIVITY_LIMITS.model) };
      }
      break;
    case "moa_reference_end":
      if (Number.isInteger(record.index) && typeof record.model === "string" && typeof record.text === "string") {
        event = { type: "moa-reference-end", index: record.index as number, model: bounded(record.model, DESKTOP_ACTIVITY_LIMITS.model), preview: bounded(redactText(record.text), DESKTOP_ACTIVITY_LIMITS.preview) };
      }
      break;
    case "moa_aggregating":
      if (typeof record.aggregator === "string" && Number.isInteger(record.refCount)) {
        event = { type: "moa-aggregating", model: bounded(record.aggregator, DESKTOP_ACTIVITY_LIMITS.model), refCount: record.refCount as number };
      }
      break;
    case "subagent_start":
      if (typeof record.goal === "string" && Number.isInteger(record.index) && Number.isInteger(record.count)) {
        event = { type: "subagent-start", goal: bounded(redactText(record.goal), DESKTOP_ACTIVITY_LIMITS.content), index: record.index as number, count: record.count as number };
      }
      break;
    case "subagent_end":
      if (typeof record.goal === "string" && Number.isInteger(record.index) && typeof record.result === "string") {
        event = { type: "subagent-end", goal: bounded(redactText(record.goal), DESKTOP_ACTIVITY_LIMITS.content), index: record.index as number, result: bounded(redactText(record.result), DESKTOP_ACTIVITY_LIMITS.content) };
      }
      break;
  }
  if (event === undefined) return undefined;
  const parsed = DesktopAgentEventSchema.safeParse(event);
  return parsed.success ? parsed.data : undefined;
};
