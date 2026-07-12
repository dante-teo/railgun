import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DevinAssistantContentPart, DevinContentPart, DevinMessage, DevinProvider } from "widevin";
import { normalizeTodoState } from "../tools/todo.js";
import type { TodoState, TodoStatus } from "../tools/todo.js";
import { STATE_PATH } from "../paths.js";
import { summarizeMessages } from "./branchSummarizer.js";

const PREVIEW_LIMIT = 71;
const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

export const DEFAULT_STATE_PATH = STATE_PATH;

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

export interface RecentMessage {
  id: number;
  role: string;
  preview: string;
}

export interface SessionStore {
  readonly db: Database.Database;
  loadSession(id: string): PersistedSession | undefined;
  listSessions(): readonly SessionSummary[];
  saveCheckpoint(checkpoint: SessionCheckpoint): PersistedSession;
  branch(sessionId: string, messageId: number): void;
  branchWithSummary(sessionId: string, messageId: number, devin: DevinProvider, model: string): Promise<void>;
  forkSession(sessionId: string): string;
  getRecentMessages(sessionId: string, limit?: number): readonly RecentMessage[];
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
  current_leaf_id: number | null;
}

interface MessageRow {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
  content_json: string;
  tool_call_id: string | null;
  tool_error: number | null;
  response_id: string | null;
  created_at: string;
  parent_id: number | null;
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
  const label = `message id=${row.id} ordinal=${row.ordinal}`;
  const content = parseJson(row.content_json, label);
  if (row.role === "branch_summary") {
    // Decoded as a user message with a prefix so the transcript validator sees it as user.
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return { role: "user", content: `[Branch summary]\n${text}` };
  }
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

const encodeMessage = (
  sessionId: string,
  ordinal: number,
  message: DevinMessage,
  createdAt: string,
  parentId: number | null,
): Omit<MessageRow, "id"> => {
  if (message.role === "developer") throw new Error("developer messages cannot be persisted");
  const content = message.role === "assistant"
    ? message.content.map(decodeAssistantPart)
    : decodeGeneralContent(message.content);
  const contentJson = JSON.stringify(content);
  if (message.role === "user") {
    return { session_id: sessionId, ordinal, role: "user", content_json: contentJson, tool_call_id: null, tool_error: null, response_id: null, created_at: createdAt, parent_id: parentId };
  }
  if (message.role === "assistant") {
    if (message.responseId !== undefined && typeof message.responseId !== "string") throw new Error("invalid assistant response id");
    return { session_id: sessionId, ordinal, role: "assistant", content_json: contentJson, tool_call_id: null, tool_error: null, response_id: message.responseId ?? null, created_at: createdAt, parent_id: parentId };
  }
  if (message.role !== "tool") throw new Error(`unsupported message role ${message.role}`);
  if (typeof message.toolCallId !== "string" || message.toolCallId === "" || (message.isError !== undefined && typeof message.isError !== "boolean")) {
    throw new Error("invalid tool message");
  }
  return { session_id: sessionId, ordinal, role: "tool", content_json: contentJson, tool_call_id: message.toolCallId, tool_error: message.isError === undefined ? null : message.isError ? 1 : 0, response_id: null, created_at: createdAt, parent_id: parentId };
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

const decodePersistedSession = (session: SessionRow, rows: readonly MessageRow[]): PersistedSession => {
  try {
    assertSessionMetadata({ ...session, startedAt: session.started_at, messages: [], todos: [] });
    rows.forEach((row, index) => {
      if (row.session_id !== session.id) throw new Error(`message at position ${index} belongs to another session`);
      if (!Number.isFinite(Date.parse(row.created_at))) throw new Error(`message at position ${index} has an invalid timestamp`);
    });
    // branch_summary rows are DB-internal routing nodes, never part of the conversation.
    // Filter them out entirely — they may appear anywhere in the path (as intermediate
    // "pivot points" that new messages chain from after branchWithSummary).
    const visibleRows = rows.filter(r => r.role !== "branch_summary");
    const visibleMessages = visibleRows.map(decodeMessageRow);
    if (visibleMessages.length > 0) validateTranscript(visibleMessages);
    return {
      id: session.id,
      model: session.model,
      startedAt: session.started_at,
      messages: visibleMessages,
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

interface SessionIdRow { id: string }
interface MessageIdRow { id: number }

/** Wire linear parent_id chains and set current_leaf_id for every session. */
const wireParentChains = (db: Database.Database): void => {
  const sessions = db.prepare("SELECT id FROM sessions").all() as SessionIdRow[];
  const updateParent   = db.prepare("UPDATE messages SET parent_id = ? WHERE id = ?");
  const updateLeafStmt = db.prepare("UPDATE sessions SET current_leaf_id = ? WHERE id = ?");
  const wire = db.transaction(() => {
    for (const session of sessions) {
      const rows = db.prepare(
        "SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC",
      ).all(session.id) as MessageIdRow[];
      let prevId: number | null = null;
      for (const row of rows) {
        updateParent.run(prevId, row.id);
        prevId = row.id;
      }
      updateLeafStmt.run(prevId, session.id);
    }
  });
  wire();
};

/** Each entry migrates from index N to N+1. user_version is bumped automatically. */
const MIGRATIONS: ReadonlyArray<(db: Database.Database) => void> = [
  // 0 → 1: historical initial schema (no parent_id, no INTEGER PK on messages, no current_leaf_id)
  (db) => db.exec(`
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
  `),

  // 1 → 2: add parent_id + current_leaf_id; rebuild messages with INTEGER PK; add memories
  (db) => {
    db.exec(`
      CREATE TABLE messages_v2 (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'branch_summary')),
        content_json TEXT NOT NULL,
        tool_call_id TEXT,
        tool_error INTEGER CHECK (tool_error IN (0, 1)),
        response_id TEXT,
        created_at TEXT NOT NULL,
        parent_id INTEGER NULL
      );
      INSERT INTO messages_v2 (session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at)
        SELECT session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at
        FROM messages ORDER BY session_id, ordinal;
      DROP TABLE messages;
      ALTER TABLE messages_v2 RENAME TO messages;
      CREATE INDEX messages_session ON messages(session_id);
      CREATE INDEX messages_parent ON messages(parent_id);
      ALTER TABLE sessions ADD COLUMN current_leaf_id INTEGER NULL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at REAL NOT NULL
      );
    `);
    wireParentChains(db);
  },

  // 2 → 3: repair — v2 DBs came in two shapes depending on when they were created:
  //   (a) old shape: no parent_id, no INTEGER PK on messages, no current_leaf_id → needs full rebuild
  //   (b) new shape: messages already has parent_id + INTEGER PK, but current_leaf_id may still be missing
  (db) => {
    interface ColInfo { name: string }
    const msgCols  = db.pragma("table_info(messages)")  as ColInfo[];
    const sessCols = db.pragma("table_info(sessions)") as ColInfo[];
    const hasParentId       = msgCols.some(c => c.name === "parent_id");
    const hasCurrentLeafId  = sessCols.some(c => c.name === "current_leaf_id");

    if (!hasParentId) {
      // Full rebuild identical to migration[1]: introduce INTEGER PK + parent_id, add memories.
      db.exec(`
        CREATE TABLE messages_v2 (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'branch_summary')),
          content_json TEXT NOT NULL,
          tool_call_id TEXT,
          tool_error INTEGER CHECK (tool_error IN (0, 1)),
          response_id TEXT,
          created_at TEXT NOT NULL,
          parent_id INTEGER NULL
        );
        INSERT INTO messages_v2 (session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at)
          SELECT session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at
          FROM messages ORDER BY session_id, ordinal;
        DROP TABLE messages;
        ALTER TABLE messages_v2 RENAME TO messages;
        CREATE INDEX messages_session ON messages(session_id);
        CREATE INDEX messages_parent ON messages(parent_id);
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          category TEXT NOT NULL,
          created_at REAL NOT NULL
        );
      `);
    }
    if (!hasCurrentLeafId) {
      db.exec(`ALTER TABLE sessions ADD COLUMN current_leaf_id INTEGER NULL;`);
    }
    wireParentChains(db);
  },

  // 3 → 4: add notes table + FTS5 virtual table for full-text search
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT,
      content TEXT NOT NULL,
      created_at REAL NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(content);

    CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
      DELETE FROM notes_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
      DELETE FROM notes_fts WHERE rowid = old.id;
      INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `),
];

const initializeSchema = (db: Database.Database): void => {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > MIGRATIONS.length)
    throw new Error(`Session database schema ${version} is newer than supported version ${MIGRATIONS.length}`);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
};

export const createSessionStore = (path = DEFAULT_STATE_PATH): SessionStore => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  chmodSync(path, 0o600);
  initializeSchema(db);

  const selectSession   = db.prepare("SELECT id, model, started_at, todos_json, current_leaf_id FROM sessions WHERE id = ?");
  const selectAllSessions = db.prepare(`
    SELECT s.id, s.model, s.started_at, s.todos_json, s.current_leaf_id, COUNT(m.id) AS message_count
    FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC`);
  const insertSession   = db.prepare("INSERT INTO sessions (id, model, started_at, todos_json) VALUES (?, ?, ?, ?)");
  const updateTodos     = db.prepare("UPDATE sessions SET todos_json = ? WHERE id = ?");
  const updateLeaf      = db.prepare("UPDATE sessions SET current_leaf_id = ? WHERE id = ?");
  const selectMessage   = db.prepare("SELECT id FROM messages WHERE id = ? AND session_id = ?");
  // Recursive CTE: walks the parent_id chain from a given leaf id, returns all ancestors in
  // chronological order (root first). A single query replaces the O(n) per-row prepare loop.
  const selectBranchFromLeaf = db.prepare(`
    WITH RECURSIVE branch(id, session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at, parent_id) AS (
      SELECT id, session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at, parent_id
        FROM messages WHERE id = @leafId AND session_id = @sessionId
      UNION ALL
      SELECT m.id, m.session_id, m.ordinal, m.role, m.content_json, m.tool_call_id, m.tool_error, m.response_id, m.created_at, m.parent_id
        FROM messages m JOIN branch b ON m.id = b.parent_id AND m.session_id = @sessionId
    )
    SELECT id, session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at, parent_id
    FROM branch ORDER BY id ASC`);
  const insertMessage   = db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at, parent_id)
    VALUES (@session_id, @ordinal, @role, @content_json, @tool_call_id, @tool_error, @response_id, @created_at, @parent_id)`);

  // Walk the parent_id chain from the current leaf back to root, return in chronological order.
  const getBranch = (sessionId: string, leafId?: number): MessageRow[] => {
    const session = selectSession.get(sessionId) as SessionRow | undefined;
    if (!session) return [];
    const startId: number | null = leafId !== undefined ? leafId : session.current_leaf_id;
    if (startId === null) return [];
    return selectBranchFromLeaf.all({ leafId: startId, sessionId }) as MessageRow[];
  };

  const loadSession = (id: string): PersistedSession | undefined => {
    const session = selectSession.get(id) as SessionRow | undefined;
    if (!session) return undefined;
    return decodePersistedSession(session, getBranch(id));
  };

  const saveTransaction = db.transaction((
    checkpoint: SessionCheckpoint,
    encoded: readonly Omit<MessageRow, "id">[],
    todosJson: string,
  ) => {
    const existing = selectSession.get(checkpoint.id) as SessionRow | undefined;
    if (!existing) {
      insertSession.run(checkpoint.id, checkpoint.model, checkpoint.startedAt, todosJson);
    } else if (existing.model !== checkpoint.model || existing.started_at !== checkpoint.startedAt) {
      throw new SessionCorruptionError(checkpoint.id, "checkpoint metadata does not match the saved session");
    }

    // Compare against the active branch, not all rows.
    // branch_summary rows are DB-internal routing nodes invisible to the checkpoint.
    // Filter them out for comparison purposes, but remember the last DB row's id (which
    // may be a summary) as the parent for any newly inserted messages.
    const allBranchRows = getBranch(checkpoint.id);
    const lastDbRow = allBranchRows[allBranchRows.length - 1];
    const realBranchRows = allBranchRows.filter(r => r.role !== "branch_summary");

    if (realBranchRows.length > encoded.length) {
      throw new SessionCorruptionError(checkpoint.id, "checkpoint would discard saved messages");
    }
    realBranchRows.forEach((row, index) => {
      const candidate = encoded[index];
      if (!candidate) {
        throw new SessionCorruptionError(checkpoint.id, `checkpoint diverges at branch position ${index}`);
      }
      if (
        row.role !== candidate.role ||
        row.content_json !== candidate.content_json ||
        row.tool_call_id !== candidate.tool_call_id ||
        row.tool_error !== candidate.tool_error ||
        row.response_id !== candidate.response_id
      ) {
        throw new SessionCorruptionError(checkpoint.id, `checkpoint diverges at branch position ${index}`);
      }
    });

    // New messages chain from the last DB row (may be a summary row acting as pivot).
    let lastId: number | null = lastDbRow?.id ?? null;
    for (const row of encoded.slice(realBranchRows.length)) {
      const result = insertMessage.run({ ...row, parent_id: lastId });
      lastId = result.lastInsertRowid as number;
    }

    // Update leaf pointer.
    if (lastId !== null) updateLeaf.run(lastId, checkpoint.id);
    updateTodos.run(todosJson, checkpoint.id);
  });

  interface ListSessionRow extends SessionRow { message_count: number }

  return {
    db,
    loadSession,

    listSessions: () => {
      const sessions = selectAllSessions.all() as ListSessionRow[];
      return sessions.map(session => {
        const persisted = decodePersistedSession(session, getBranch(session.id));
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
      // parentId is null on initial encode; saveTransaction resolves actual ids from branchRows.
      const encoded = checkpoint.messages.map((message, ordinal) => encodeMessage(checkpoint.id, ordinal, message, now, null));
      validateTranscript(checkpoint.messages);
      const todosJson = encodeTodos(checkpoint.todos);
      saveTransaction(checkpoint, encoded, todosJson);
      return loadSession(checkpoint.id)!;
    },

    branch: (sessionId, messageId) => {
      if (!selectMessage.get(messageId, sessionId)) {
        throw new Error(`message ${messageId} does not exist in session ${sessionId}`);
      }
      updateLeaf.run(messageId, sessionId);
    },

    branchWithSummary: async (sessionId, messageId, devin, model) => {
      const currentBranch = getBranch(sessionId);
      const branchPointIndex = currentBranch.findIndex(r => r.id === messageId);
      if (branchPointIndex === -1) {
        throw new Error(`message ${messageId} is not on the active branch of session ${sessionId}`);
      }

      // Messages after the branch point are the abandoned segment.
      const abandonedRows = currentBranch.slice(branchPointIndex + 1);
      if (abandonedRows.length > 0) {
        const summaryText = await summarizeMessages(abandonedRows.map(decodeMessageRow), devin, model);
        // Wrap the two DB writes in a transaction: an orphaned row without a leaf update
        // on crash would be unreachable and leave the session in an inconsistent state.
        db.transaction(() => {
          const result = insertMessage.run({
            session_id: sessionId,
            ordinal: branchPointIndex + 1,
            role: "branch_summary",
            content_json: JSON.stringify(summaryText),
            tool_call_id: null,
            tool_error: null,
            response_id: null,
            created_at: new Date().toISOString(),
            parent_id: messageId,
          });
          updateLeaf.run(result.lastInsertRowid as number, sessionId);
        })();
      } else {
        // No messages to summarize; just move the leaf pointer.
        updateLeaf.run(messageId, sessionId);
      }
    },

    forkSession: (sessionId) => {
      const sourceBranch = getBranch(sessionId);
      const sourceSession = selectSession.get(sessionId) as SessionRow | undefined;
      if (!sourceSession) throw new Error(`session ${sessionId} not found`);

      const newId = `${sessionId}-fork-${Date.now()}`;
      db.transaction(() => {
        insertSession.run(newId, sourceSession.model, new Date().toISOString(), sourceSession.todos_json);
        let lastId: number | null = null;
        for (const [ordinal, row] of sourceBranch.entries()) {
          const result = insertMessage.run({
            session_id: newId,
            ordinal,
            role: row.role,
            content_json: row.content_json,
            tool_call_id: row.tool_call_id,
            tool_error: row.tool_error,
            response_id: row.response_id,
            created_at: row.created_at,
            parent_id: lastId,
          });
          lastId = result.lastInsertRowid as number;
        }
        if (lastId !== null) updateLeaf.run(lastId, newId);
      })();
      return newId;
    },

    getRecentMessages: (sessionId, limit = 10) => {
      const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string";

      return getBranch(sessionId).slice(-limit).map(row => {
        const rawContent = parseJson(row.content_json, `message id=${row.id}`);
        let preview: string;
        if (typeof rawContent === "string") {
          preview = rawContent.slice(0, 80);
        } else if (Array.isArray(rawContent)) {
          preview = rawContent.filter(isTextPart).map(p => p.text).join(" ").slice(0, 80);
        } else {
          preview = JSON.stringify(rawContent).slice(0, 80);
        }
        return { id: row.id, role: row.role, preview };
      });
    },

    close: () => db.close(),
  };
};
