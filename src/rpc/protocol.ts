import type { RpcCommand } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`invalid command: ${field} must be a non-empty string`);
  return value;
};

const optionalId = (record: Record<string, unknown>): { id?: string } => {
  if (record.id === undefined) return {};
  return { id: nonEmpty(record.id, "id") };
};

const positiveLimit = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new Error("invalid command: limit must be an integer between 1 and 100");
  }
  return value as number;
};

const positiveInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`invalid command: ${field} must be a positive integer`);
  }
  return value as number;
};

const nonNegativeCursor = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("invalid command: cursor must be a non-negative integer");
  }
  return value as number;
};

const stringArray = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`invalid command: ${field} must be an array of strings`);
  }
  return value;
};

const patch = (value: unknown, field = "patch"): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`invalid command: ${field} must be an object`);
  return value;
};

/** Runtime parser shared by legacy and v1 so malformed input never reaches a handler. */
export const parseRpcCommand = (value: unknown): RpcCommand => {
  if (!isRecord(value) || typeof value.type !== "string" || value.type === "") {
    throw new Error("invalid command: missing type field");
  }
  const base = optionalId(value);
  const type = value.type;
  switch (type) {
    case "initialize": {
      if (!Number.isInteger(value.version)) throw new Error("invalid command: version must be an integer");
      if (value.clientName !== undefined && typeof value.clientName !== "string") throw new Error("invalid command: clientName must be a string");
      return { ...base, type, version: value.version as number, ...(value.clientName === undefined ? {} : { clientName: value.clientName }) };
    }
    case "prompt": case "steer": case "follow_up":
      return { ...base, type, message: nonEmpty(value.message, "message") };
    case "abort": case "get_state": case "get_messages": case "get_available_models": case "compact":
    case "session_list": case "session_save": case "config_get": case "mcp_list": case "skills_list":
    case "dream_run": case "instruction_files_list":
      return { ...base, type };
    case "set_model": return { ...base, type, modelId: nonEmpty(value.modelId, "modelId") };
    case "set_auto_compaction": {
      if (typeof value.enabled !== "boolean") throw new Error("invalid command: enabled must be a boolean");
      return { ...base, type, enabled: value.enabled };
    }
    case "approval_response": {
      if (typeof value.approved !== "boolean") throw new Error("invalid command: approved must be a boolean");
      return { ...base, type, requestId: nonEmpty(value.requestId, "requestId"), approved: value.approved };
    }
    case "clarification_response": return { ...base, type, requestId: nonEmpty(value.requestId, "requestId"), answer: nonEmpty(value.answer, "answer") };
    case "session_new": return { ...base, type, ...(value.modelId === undefined ? {} : { modelId: nonEmpty(value.modelId, "modelId") }) };
    case "session_load": {
      if (value.includeMessages !== undefined && typeof value.includeMessages !== "boolean") {
        throw new Error("invalid command: includeMessages must be a boolean");
      }
      return {
        ...base,
        type,
        sessionId: nonEmpty(value.sessionId, "sessionId"),
        ...(value.includeMessages === undefined ? {} : { includeMessages: value.includeMessages }),
      };
    }
    case "session_branch": {
      if (!Number.isInteger(value.messageId) || (value.messageId as number) < 1) throw new Error("invalid command: messageId must be a positive integer");
      if (value.summarize !== undefined && typeof value.summarize !== "boolean") throw new Error("invalid command: summarize must be a boolean");
      if (value.includeMessages !== undefined && typeof value.includeMessages !== "boolean") throw new Error("invalid command: includeMessages must be a boolean");
      return { ...base, type, messageId: value.messageId as number, ...(value.summarize === undefined ? {} : { summarize: value.summarize }), ...(value.includeMessages === undefined ? {} : { includeMessages: value.includeMessages }) };
    }
    case "session_fork": {
      if (value.includeMessages !== undefined && typeof value.includeMessages !== "boolean") throw new Error("invalid command: includeMessages must be a boolean");
      return { ...base, type, ...(value.sessionId === undefined ? {} : { sessionId: nonEmpty(value.sessionId, "sessionId") }), ...(value.includeMessages === undefined ? {} : { includeMessages: value.includeMessages }) };
    }
    case "session_recent_messages": return { ...base, type, ...(value.sessionId === undefined ? {} : { sessionId: nonEmpty(value.sessionId, "sessionId") }), ...(positiveLimit(value.limit) === undefined ? {} : { limit: positiveLimit(value.limit)! }) };
    case "session_transcript": return {
      ...base,
      type,
      sessionId: nonEmpty(value.sessionId, "sessionId"),
      ...(nonNegativeCursor(value.cursor) === undefined ? {} : { cursor: nonNegativeCursor(value.cursor)! }),
      ...(positiveLimit(value.limit) === undefined ? {} : { limit: positiveLimit(value.limit)! }),
    };
    case "config_update": return { ...base, type, patch: patch(value.patch) };
    case "mcp_upsert": {
      const envRaw = value.env === undefined ? undefined : patch(value.env, "env");
      if (envRaw !== undefined && Object.values(envRaw).some(item => typeof item !== "string" && item !== null)) throw new Error("invalid command: env values must be strings or null");
      return { ...base, type, name: nonEmpty(value.name, "name"), command: nonEmpty(value.command, "command"), ...(value.args === undefined ? {} : { args: stringArray(value.args, "args") }), ...(envRaw === undefined ? {} : { env: envRaw as Record<string, string | null> }) };
    }
    case "mcp_remove": return { ...base, type, name: nonEmpty(value.name, "name") };
    case "cron_list": {
      if (value.editableOnly !== undefined && typeof value.editableOnly !== "boolean") throw new Error("invalid command: editableOnly must be a boolean");
      const cursor = nonNegativeCursor(value.cursor);
      const limit = positiveLimit(value.limit);
      const maxPromptLength = positiveInteger(value.maxPromptLength, "maxPromptLength");
      return {
        ...base,
        type,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(value.editableOnly === undefined ? {} : { editableOnly: value.editableOnly }),
        ...(maxPromptLength === undefined ? {} : { maxPromptLength }),
      };
    }
    case "cron_add": {
      if (value.includeJob !== undefined && typeof value.includeJob !== "boolean") throw new Error("invalid command: includeJob must be a boolean");
      return { ...base, type, schedule: nonEmpty(value.schedule, "schedule"), prompt: nonEmpty(value.prompt, "prompt"), ...(value.jobId === undefined ? {} : { jobId: nonEmpty(value.jobId, "jobId") }), ...(value.includeJob === undefined ? {} : { includeJob: value.includeJob }) };
    }
    case "cron_update": {
      if (value.includeJob !== undefined && typeof value.includeJob !== "boolean") throw new Error("invalid command: includeJob must be a boolean");
      return { ...base, type, jobId: nonEmpty(value.jobId, "jobId"), patch: patch(value.patch) as { schedule?: string; prompt?: string }, ...(value.includeJob === undefined ? {} : { includeJob: value.includeJob }) };
    }
    case "cron_remove": return { ...base, type, jobId: nonEmpty(value.jobId, "jobId") };
    case "memory_list": return { ...base, type, ...(positiveLimit(value.limit) === undefined ? {} : { limit: positiveLimit(value.limit)! }) };
    case "memory_search": return { ...base, type, query: nonEmpty(value.query, "query"), ...(positiveLimit(value.limit) === undefined ? {} : { limit: positiveLimit(value.limit)! }) };
    case "memory_create": return { ...base, type, content: nonEmpty(value.content, "content"), category: nonEmpty(value.category, "category") };
    case "memory_update": return { ...base, type, memoryId: nonEmpty(value.memoryId, "memoryId"), patch: patch(value.patch) as { content?: string; category?: string } };
    case "memory_delete": return { ...base, type, memoryId: nonEmpty(value.memoryId, "memoryId") };
    case "notes_import": {
      if (value.semantic !== undefined && typeof value.semantic !== "boolean") throw new Error("invalid command: semantic must be a boolean");
      return { ...base, type, folderPath: nonEmpty(value.folderPath, "folderPath"), ...(value.semantic === undefined ? {} : { semantic: value.semantic }) };
    }
    case "notes_search": {
      if (value.mode !== undefined && value.mode !== "keyword" && value.mode !== "semantic") throw new Error("invalid command: mode must be keyword or semantic");
      return { ...base, type, query: nonEmpty(value.query, "query"), ...(value.mode === undefined ? {} : { mode: value.mode }), ...(positiveLimit(value.limit) === undefined ? {} : { limit: positiveLimit(value.limit)! }) };
    }
    case "instruction_file_get": return { ...base, type, fileId: nonEmpty(value.fileId, "fileId") };
    case "instruction_file_update": {
      if (typeof value.content !== "string") throw new Error("invalid command: content must be a string");
      return { ...base, type, fileId: nonEmpty(value.fileId, "fileId"), content: value.content };
    }
    case "skill_get": return { ...base, type, name: nonEmpty(value.name, "name") };
    default: throw new Error(`unknown command: ${type}`);
  }
};
