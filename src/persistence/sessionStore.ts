import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { DevinAssistantContentPart, DevinContentPart, DevinMessage } from "widevin";
import { normalizeTodoState } from "../tools/todo.js";
import type { TodoState, TodoStatus } from "../tools/todo.js";

const SCHEMA_VERSION = 1;
const PREVIEW_LIMIT = 71;
const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

export const DEFAULT_STATE_PATH = join(homedir(), ".railgun", "state.db");

export interface SessionCheckpoint {
  id: string;
  model: string;
  startedAt: string;
  messages: readonly DevinMessage[];
  todos: TodoState;
}

export interface PersistedSession extends SessionCheckpoint {}

export interface SessionSummary {
  id: string;
  model: string;
  startedAtLocal: string;
  messageCount: number;
  firstUserPreview: string;
}

export interface SessionStore {
  loadSession(id: string): PersistedSession | undefined;
  listSessions(): readonly SessionSummary[];
  saveCheckpoint(checkpoint: SessionCheckpoint): PersistedSession;
  close(): void;
}

export class SessionCorruptionError extends Error {
  constructor(readonly sessionId: string, detail: string) {
    super(`Saved session ${sessionId} is corrupt: ${detail}`);
    this.name = "SessionCorruptionError";
  }
}

interface SessionRow {
  id: string;
  model: string;
  started_at: string;
  todos_json: string;
}

interface MessageRow {
  session_id: string;
  ordinal: number;
  role: string;
  content_json: string;
  tool_call_id: string | null;
  tool_error: number | null;
  response_id: string | null;
  created_at: string;
}

type UserMessage = DevinMessage & { role: "user" };
const isUserMessage = (message: DevinMessage): message is UserMessage => message.role === "user";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));

const parseJson = (json: string, label: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`${label} contains malformed JSON`);
  }
};

const isJsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const decodeContentPart = (value: unknown): DevinContentPart => {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("invalid content part");
  if (value.type === "text" && hasOnlyKeys(value, ["type", "text"]) && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (
    value.type === "image" &&
    hasOnlyKeys(value, ["type", "data", "mimeType"]) &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  ) {
    return { type: "image", data: value.data, mimeType: value.mimeType };
  }
  throw new Error("invalid user/tool content part");
};

const decodeAssistantPart = (value: unknown): DevinAssistantContentPart => {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("invalid assistant content part");
  if (value.type === "text" && hasOnlyKeys(value, ["type", "text"]) && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (
    value.type === "thinking" &&
    hasOnlyKeys(value, ["type", "thinking", "thinkingSignature"]) &&
    typeof value.thinking === "string" &&
    (value.thinkingSignature === undefined || typeof value.thinkingSignature === "string")
  ) {
    return value.thinkingSignature === undefined
      ? { type: "thinking", thinking: value.thinking }
      : { type: "thinking", thinking: value.thinking, thinkingSignature: value.thinkingSignature };
  }
  if (
    value.type === "toolCall" &&
    hasOnlyKeys(value, ["type", "id", "name", "arguments"]) &&
    typeof value.id === "string" && value.id !== "" &&
    typeof value.name === "string" && value.name !== "" &&
    "arguments" in value && isJsonValue(value.arguments)
  ) {
    return { type: "toolCall", id: value.id, name: value.name, arguments: value.arguments };
  }
  throw new Error("invalid assistant content part");
};

const decodeGeneralContent = (value: unknown): string | readonly DevinContentPart[] => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(decodeContentPart);
  throw new Error("invalid message content");
};

const decodeMessageRow = (row: MessageRow): DevinMessage => {
  const content = parseJson(row.content_json, `message ${row.ordinal}`);
  if (row.role === "user") {
    if (row.tool_call_id !== null || row.tool_error !== null || row.response_id !== null) {
      throw new Error(`user message ${row.ordinal} has role-incompatible fields`);
    }
    return { role: "user", content: decodeGeneralContent(content) };
  }
  if (row.role === "assistant") {
    if (row.tool_call_id !== null || row.tool_error !== null || !Array.isArray(content)) {
      throw new Error(`assistant message ${row.ordinal} has role-incompatible fields`);
    }
    const decoded = content.map(decodeAssistantPart);
    return row.response_id === null
      ? { role: "assistant", content: decoded }
      : { role: "assistant", content: decoded, responseId: row.response_id };
  }
  if (row.role === "tool") {
    if (row.tool_call_id === null || row.response_id !== null || (row.tool_error !== null && ![0, 1].includes(row.tool_error))) {
      throw new Error(`tool message ${row.ordinal} has role-incompatible fields`);
    }
    return {
      role: "tool",
      toolCallId: row.tool_call_id,
      content: decodeGeneralContent(content),
      ...(row.tool_error === null ? {} : { isError: row.tool_error === 1 }),
    };
  }
  throw new Error(`message ${row.ordinal} has invalid role ${JSON.stringify(row.role)}`);
};

const encodeMessage = (sessionId: string, ordinal: number, message: DevinMessage, createdAt: string): MessageRow => {
  if (message.role === "developer") throw new Error("developer messages cannot be persisted");
  const content = message.role === "assistant"
    ? message.content.map(decodeAssistantPart)
    : decodeGeneralContent(message.content);
  const contentJson = JSON.stringify(content);
  if (message.role === "user") {
    return { session_id: sessionId, ordinal, role: "user", content_json: contentJson, tool_call_id: null, tool_error: null, response_id: null, created_at: createdAt };
  }
  if (message.role === "assistant") {
    if (message.responseId !== undefined && typeof message.responseId !== "string") throw new Error("invalid assistant response id");
    return { session_id: sessionId, ordinal, role: "assistant", content_json: contentJson, tool_call_id: null, tool_error: null, response_id: message.responseId ?? null, created_at: createdAt };
  }
  if (message.role !== "tool") throw new Error(`unsupported message role ${message.role}`);
  if (typeof message.toolCallId !== "string" || message.toolCallId === "" || (message.isError !== undefined && typeof message.isError !== "boolean")) {
    throw new Error("invalid tool message");
  }
  return { session_id: sessionId, ordinal, role: "tool", content_json: contentJson, tool_call_id: message.toolCallId, tool_error: message.isError === undefined ? null : message.isError ? 1 : 0, response_id: null, created_at: createdAt };
};

const validateTranscript = (messages: readonly DevinMessage[]): void => {
  type TranscriptState = {
    expected: "user" | "assistant" | "tool";
    pending: readonly string[];
    answered: readonly string[];
  };
  if (messages.length === 0) throw new Error("role sequence cannot be empty");
  const final = messages.reduce<TranscriptState>((state, message, ordinal) => {
    if (message.role === "developer") throw new Error(`role sequence contains developer message at ${ordinal}`);
    if (message.role === "user") {
      if (state.expected !== "user") throw new Error(`invalid role sequence at message ${ordinal}: expected ${state.expected}`);
      return { ...state, expected: "assistant" };
    }
    if (message.role === "assistant") {
      if (state.expected !== "assistant") throw new Error(`invalid role sequence at message ${ordinal}: expected ${state.expected}`);
      const calls = message.content.filter(part => part.type === "toolCall").map(part => part.id);
      if (new Set(calls).size !== calls.length) throw new Error(`duplicate tool call id in message ${ordinal}`);
      calls.forEach(id => {
        if (state.pending.includes(id) || state.answered.includes(id)) throw new Error(`duplicate tool call id ${id}`);
      });
      return calls.length === 0
        ? { ...state, expected: "user" }
        : { expected: "tool", pending: calls, answered: state.answered };
    }
    if (message.role !== "tool") throw new Error(`invalid role sequence at message ${ordinal}`);
    if (state.expected !== "tool" || !state.pending.includes(message.toolCallId)) {
      throw new Error(`invalid role sequence at message ${ordinal}: unmatched tool result ${message.toolCallId}`);
    }
    const pending = state.pending.filter(id => id !== message.toolCallId);
    return {
      expected: pending.length === 0 ? "assistant" : "tool",
      pending,
      answered: [...state.answered, message.toolCallId],
    };
  }, { expected: "user", pending: [], answered: [] });
  if (final.expected !== "user") throw new Error(`incomplete role sequence: expected ${final.expected}`);
};

const decodeTodos = (json: string): TodoState => {
  const value = parseJson(json, "todo snapshot");
  if (!Array.isArray(value)) throw new Error("todo snapshot is not an array");
  const ids = new Set<string>();
  const decoded = value.map(item => {
    if (
      !isRecord(item) || !hasOnlyKeys(item, ["id", "content", "status"]) ||
      typeof item.id !== "string" || item.id === "" || ids.has(item.id) ||
      typeof item.content !== "string" || !TODO_STATUSES.has(item.status as TodoStatus)
    ) throw new Error("todo snapshot contains an invalid item");
    ids.add(item.id);
    return { id: item.id, content: item.content, status: item.status as TodoStatus };
  });
  if (JSON.stringify(normalizeTodoState(decoded)) !== JSON.stringify(decoded)) {
    throw new Error("normalized todo snapshot does not match stored JSON");
  }
  return decoded;
};

const encodeTodos = (todos: TodoState): string => JSON.stringify(decodeTodos(JSON.stringify(todos)));

const assertSessionMetadata = (checkpoint: SessionCheckpoint): void => {
  if (checkpoint.id.trim() === "") throw new Error("session id cannot be empty");
  if (checkpoint.model.trim() === "") throw new Error("session model cannot be empty");
  if (!Number.isFinite(Date.parse(checkpoint.startedAt))) throw new Error("session start time is invalid");
};

const assertOrdinalSequence = (rows: readonly MessageRow[]): void => {
  rows.forEach((row, index) => {
    if (row.ordinal !== index) throw new Error(`message ordinals are not contiguous at ${index}`);
  });
};

const decodePersistedSession = (session: SessionRow, rows: readonly MessageRow[]): PersistedSession => {
  try {
    assertSessionMetadata({ ...session, startedAt: session.started_at, messages: [], todos: [] });
    assertOrdinalSequence(rows);
    rows.forEach((row, ordinal) => {
      if (row.session_id !== session.id) throw new Error(`message ${ordinal} belongs to another session`);
      if (!Number.isFinite(Date.parse(row.created_at))) throw new Error(`message ${ordinal} has an invalid timestamp`);
    });
    const messages = rows.map(decodeMessageRow);
    validateTranscript(messages);
    return {
      id: session.id,
      model: session.model,
      startedAt: session.started_at,
      messages,
      todos: decodeTodos(session.todos_json),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionCorruptionError(session.id, detail);
  }
};

const contentText = (content: string | readonly DevinContentPart[]): string =>
  typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join(" ");

export const makeSessionPreview = (messages: readonly DevinMessage[]): string => {
  const firstUser = messages.find(isUserMessage);
  const collapsed = firstUser ? contentText(firstUser.content).replace(/\s+/g, " ").trim() : "";
  return collapsed.length <= PREVIEW_LIMIT ? collapsed : `${collapsed.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`;
};

const initializeSchema = (db: Database.Database): void => {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) throw new Error(`Session database schema ${version} is newer than supported version ${SCHEMA_VERSION}`);
  if (version === 0) {
    db.exec(`
      BEGIN;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        todos_json TEXT NOT NULL
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content_json TEXT NOT NULL,
        tool_call_id TEXT,
        tool_error INTEGER CHECK (tool_error IN (0, 1)),
        response_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, ordinal)
      );
      CREATE INDEX messages_session_ordinal ON messages(session_id, ordinal);
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  }
};

export const createSessionStore = (path = DEFAULT_STATE_PATH): SessionStore => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  chmodSync(path, 0o600);
  initializeSchema(db);

  const selectSession = db.prepare("SELECT id, model, started_at, todos_json FROM sessions WHERE id = ?");
  const selectMessages = db.prepare("SELECT session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at FROM messages WHERE session_id = ? ORDER BY ordinal");
  const insertSession = db.prepare("INSERT INTO sessions (id, model, started_at, todos_json) VALUES (?, ?, ?, ?)");
  const updateTodos = db.prepare("UPDATE sessions SET todos_json = ? WHERE id = ?");
  const insertMessage = db.prepare(`INSERT INTO messages
    (session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at)
    VALUES (@session_id, @ordinal, @role, @content_json, @tool_call_id, @tool_error, @response_id, @created_at)`);

  const loadSession = (id: string): PersistedSession | undefined => {
    const session = selectSession.get(id) as SessionRow | undefined;
    if (!session) return undefined;
    return decodePersistedSession(session, selectMessages.all(id) as MessageRow[]);
  };

  const saveTransaction = db.transaction((checkpoint: SessionCheckpoint, encoded: readonly MessageRow[], todosJson: string) => {
    const existing = selectSession.get(checkpoint.id) as SessionRow | undefined;
    if (!existing) {
      insertSession.run(checkpoint.id, checkpoint.model, checkpoint.startedAt, todosJson);
    } else if (existing.model !== checkpoint.model || existing.started_at !== checkpoint.startedAt) {
      throw new SessionCorruptionError(checkpoint.id, "checkpoint metadata does not match the saved session");
    }

    const savedRows = selectMessages.all(checkpoint.id) as MessageRow[];
    assertOrdinalSequence(savedRows);
    if (savedRows.length > encoded.length) throw new SessionCorruptionError(checkpoint.id, "checkpoint would discard saved messages");
    savedRows.forEach((row, ordinal) => {
      const candidate = encoded[ordinal];
      if (!candidate || row.role !== candidate.role || row.content_json !== candidate.content_json ||
        row.tool_call_id !== candidate.tool_call_id || row.tool_error !== candidate.tool_error || row.response_id !== candidate.response_id) {
        throw new SessionCorruptionError(checkpoint.id, `checkpoint diverges at message ${ordinal}`);
      }
    });
    encoded.slice(savedRows.length).forEach(row => insertMessage.run(row));
    updateTodos.run(todosJson, checkpoint.id);
  });

  return {
    loadSession,
    listSessions: () => {
      const sessions = db.prepare(`SELECT s.id, s.model, s.started_at, s.todos_json, COUNT(m.ordinal) AS message_count
        FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC`).all() as Array<SessionRow & { message_count: number }>;
      return sessions.map(session => {
        const persisted = decodePersistedSession(session, selectMessages.all(session.id) as MessageRow[]);
        return {
          id: session.id,
          model: session.model,
          startedAtLocal: new Date(session.started_at).toLocaleString(),
          messageCount: session.message_count,
          firstUserPreview: makeSessionPreview(persisted.messages),
        };
      });
    },
    saveCheckpoint: checkpoint => {
      assertSessionMetadata(checkpoint);
      const now = new Date().toISOString();
      const encoded = checkpoint.messages.map((message, ordinal) => encodeMessage(checkpoint.id, ordinal, message, now));
      validateTranscript(checkpoint.messages);
      const todosJson = encodeTodos(checkpoint.todos);
      saveTransaction(checkpoint, encoded, todosJson);
      return loadSession(checkpoint.id)!;
    },
    close: () => db.close(),
  };
};
