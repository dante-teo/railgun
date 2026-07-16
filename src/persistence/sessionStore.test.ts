import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevinMessage } from "widevin";
import {
  SessionCorruptionError,
  createSessionStore,
  type SessionCheckpoint,
} from "./sessionStore.js";

const startedAt = "2026-07-10T01:02:03.000Z";
const todos = [{ id: "phase-12", content: "Persist sessions", status: "in_progress" }] as const;
const messages: readonly DevinMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "  Remember   this session  " },
      { type: "image", data: "base64-data", mimeType: "image/png" },
    ],
  },
  {
    role: "assistant",
    responseId: "response-1",
    content: [
      { type: "thinking", thinking: "inspect", thinkingSignature: "sig" },
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "notes.txt" } },
    ],
  },
  { role: "tool", toolCallId: "call-1", content: "contents", isError: true },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
];

const checkpoint = (overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint => ({
  id: "session-a",
  model: "model-a",
  startedAt,
  messages,
  todos,
  ...overrides,
});

describe("createSessionStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-session-store-"));
    path = join(dir, "nested", "state.db");
  });

  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("initializes the versioned schema, owner-only database, and reopens cleanly", async () => {
    const store = createSessionStore(path);
    expect(store.listSessions()).toEqual([]);
    store.close();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const db = new Database(path, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'notes\\_vec\\_%' ESCAPE '\\' AND name != 'sqlite_sequence' ORDER BY name").pluck().all())
      .toEqual(["memories", "messages", "notes", "notes_vec", "sessions"]);
    db.close();

    const reopened = createSessionStore(path);
    expect(reopened.listSessions()).toEqual([]);
    reopened.close();
  });

  it("round-trips every supported message field and normalized todos exactly", () => {
    const store = createSessionStore(path);
    const saved = store.saveCheckpoint(checkpoint());

    expect(saved.id).toBe("session-a");
    expect(store.loadSession("session-a")).toEqual({
      id: "session-a",
      model: "model-a",
      startedAt,
      messages,
      todos,
    });
    store.close();
  });

  it("preserves an omitted optional tool error flag and tool content parts", () => {
    const store = createSessionStore(path);
    const optionalMessages: readonly DevinMessage[] = [
      { role: "user", content: "show image" },
      { role: "assistant", content: [{ type: "toolCall", id: "image-1", name: "image", arguments: null }] },
      { role: "tool", toolCallId: "image-1", content: [{ type: "image", data: "abc", mimeType: "image/webp" }] },
      { role: "assistant", content: [{ type: "text", text: "shown" }] },
    ];

    store.saveCheckpoint(checkpoint({ id: "optional", messages: optionalMessages }));

    expect(store.loadSession("optional")?.messages).toEqual(optionalMessages);
    store.close();
  });

  it("creates no session before the first checkpoint and preserves its model while appending", () => {
    const store = createSessionStore(path);
    expect(store.listSessions()).toEqual([]);

    store.saveCheckpoint(checkpoint({ messages: messages.slice(0, 4) }));
    const appended = [...messages, { role: "user", content: "Again" }, { role: "assistant", content: [{ type: "text", text: "Yes" }] }] satisfies DevinMessage[];
    store.saveCheckpoint(checkpoint({ messages: appended, todos: [] }));

    expect(store.loadSession("session-a")?.model).toBe("model-a");
    expect(store.loadSession("session-a")?.messages).toEqual(appended);
    expect(store.loadSession("session-a")?.todos).toEqual([]);
    store.close();
  });

  it("makes complete-snapshot retries idempotent", () => {
    const store = createSessionStore(path);
    store.saveCheckpoint(checkpoint());
    store.saveCheckpoint(checkpoint());

    expect(store.listSessions()[0]?.messageCount).toBe(messages.length);
    store.close();
  });

  it("rolls back the lazy session row and all messages when a transaction fails", () => {
    const store = createSessionStore(path);
    const external = new Database(path);
    external.exec(`CREATE TRIGGER reject_second_message BEFORE INSERT ON messages
      WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    external.close();

    expect(() => store.saveCheckpoint(checkpoint())).toThrow(/injected failure/);
    expect(store.listSessions()).toEqual([]);
    store.close();
  });

  it("lists newest sessions first with counts and collapsed, truncated previews", () => {
    const store = createSessionStore(path);
    store.saveCheckpoint(checkpoint({ id: "older", startedAt: "2026-07-09T00:00:00.000Z" }));
    store.saveCheckpoint(checkpoint({
      id: "newer",
      startedAt: "2026-07-10T00:00:00.000Z",
      messages: [
        { role: "user", content: "  A   preview\nthat is deliberately much longer than the configured display limit for session summaries.  " },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    }));

    const summaries = store.listSessions();
    expect(summaries.map(summary => summary.id)).toEqual(["newer", "older"]);
    expect(summaries[0]).toMatchObject({ model: "model-a", messageCount: 2 });
    expect(summaries[0]?.firstUserPreview).toBe("A preview that is deliberately much longer than the configured display…");
    expect(summaries[0]?.startedAtLocal).toBe(new Date("2026-07-10T00:00:00.000Z").toLocaleString());
    store.close();
  });

  it("returns undefined for a missing session", () => {
    const store = createSessionStore(path);
    expect(store.loadSession("missing")).toBeUndefined();
    store.close();
  });

  it("archives and restores sessions while keeping active and archived listings isolated", () => {
    let current = new Date("2026-07-10T10:00:00.000Z");
    const store = createSessionStore(path, { now: () => current });
    store.saveCheckpoint(checkpoint({ id: "older", startedAt: "2026-07-09T00:00:00.000Z" }));
    store.saveCheckpoint(checkpoint({ id: "newer" }));

    store.archiveSession("older");
    current = new Date("2026-07-10T11:00:00.000Z");
    store.archiveSession("newer");

    expect(store.listSessions()).toEqual([]);
    expect(store.loadSession("newer")).toBeUndefined();
    expect(store.listArchivedSessions().map(session => session.id)).toEqual(["newer", "older"]);
    expect(store.listArchivedSessions()[0]?.archivedAt).toBe("2026-07-10T11:00:00.000Z");
    expect(() => store.forkSession("newer")).toThrow(/archived/u);

    store.unarchiveSession("older");
    expect(store.listSessions().map(session => session.id)).toEqual(["older"]);
    expect(store.listArchivedSessions().map(session => session.id)).toEqual(["newer"]);
    store.close();
  });

  it("prunes archives at the inclusive retention boundary and cascades their messages", () => {
    let current = new Date("2026-07-17T10:00:00.000Z");
    const store = createSessionStore(path, { now: () => current });
    store.saveCheckpoint(checkpoint());
    store.archiveSession("session-a");
    current = new Date("2026-07-24T10:00:00.000Z");

    expect(store.pruneArchivedSessions(7)).toBe(1);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get("session-a")).toEqual({ count: 0 });
    expect(store.listArchivedSessions()).toEqual([]);
    store.close();
  });

  it("fails closed with a session-specific corruption error", () => {
    const store = createSessionStore(path);
    store.saveCheckpoint(checkpoint());
    store.close();

    const db = new Database(path);
    db.prepare("UPDATE messages SET content_json = ? WHERE session_id = ? AND ordinal = 0")
      .run("{broken", "session-a");
    db.close();

    const reopened = createSessionStore(path);
    expect(() => reopened.loadSession("session-a")).toThrow(SessionCorruptionError);
    expect(() => reopened.loadSession("session-a")).toThrow(/session-a/);
    reopened.close();
  });

  it("rejects a structurally valid transcript with an impossible role sequence", () => {
    const store = createSessionStore(path);
    store.saveCheckpoint(checkpoint());
    store.close();

    const db = new Database(path);
    db.prepare(`UPDATE messages SET role = 'assistant', content_json = ?, response_id = NULL
      WHERE session_id = ? AND ordinal = 0`)
      .run(JSON.stringify([{ type: "text", text: "assistant cannot start a transcript" }]), "session-a");
    db.close();

    const reopened = createSessionStore(path);
    expect(() => reopened.loadSession("session-a")).toThrow(/session-a.*role sequence/i);
    reopened.close();
  });

  it("rejects duplicate tool-call IDs in one assistant message", () => {
    const store = createSessionStore(path);
    const duplicateCalls: readonly DevinMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [
        { type: "toolCall", id: "duplicate", name: "first", arguments: {} },
        { type: "toolCall", id: "duplicate", name: "second", arguments: {} },
      ] },
      { role: "tool", toolCallId: "duplicate", content: "done" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    expect(() => store.saveCheckpoint(checkpoint({ id: "duplicate", messages: duplicateCalls })))
      .toThrow(/duplicate tool call id/i);
    expect(store.loadSession("duplicate")).toBeUndefined();
    store.close();
  });

  it("rejects todo JSON that is valid but not normalized", () => {
    const store = createSessionStore(path);
    store.saveCheckpoint(checkpoint());
    store.close();

    const db = new Database(path);
    db.prepare("UPDATE sessions SET todos_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: " spaced ", content: "todo", status: "pending" }]), "session-a");
    db.close();

    const reopened = createSessionStore(path);
    expect(() => reopened.loadSession("session-a")).toThrow(/session-a.*normalized todo/i);
    reopened.close();
  });
});

describe("schema migration", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-session-store-migration-"));
    path = join(dir, "state.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("migrates a v1 database to v6 by adding the memories table, branching columns, notes tables, notes_vec, and archiving", () => {
    // Bootstrap a v1-era database manually (no memories table, user_version = 1).
    const bootstrap = new Database(path);
    bootstrap.exec(`
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
      PRAGMA user_version = 1;
      COMMIT;
    `);
    bootstrap.close();

    // Open with the current createSessionStore — should migrate transparently.
    const store = createSessionStore(path);
    store.close();

    const db = new Database(path, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").pluck().all()
    ).toEqual(["memories"]);
    interface ColInfo { name: string }
    const msgCols = db.pragma("table_info(messages)") as ColInfo[];
    expect(msgCols.some(c => c.name === "parent_id")).toBe(true);
    const sessCols = db.pragma("table_info(sessions)") as ColInfo[];
    expect(sessCols.some(c => c.name === "current_leaf_id")).toBe(true);
    expect(sessCols.some(c => c.name === "archived_at")).toBe(true);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_archived_at'").pluck().all()).toEqual(["sessions_archived_at"]);
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes', 'notes_fts', 'notes_vec')")
      .pluck().all() as string[];
    expect(tableNames).toContain("notes");
    expect(tableNames).toContain("notes_fts");
    expect(tableNames).toContain("notes_vec");
    db.close();
  });
});

describe("notes schema migration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-notes-migration-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("migrates a fresh database to v6 with notes, notes_fts, notes_vec, and archive metadata", () => {
    const path = join(dir, "state.db");
    const store = createSessionStore(path);
    store.close();

    const db = new Database(path);
    try {
      const version = db.pragma("user_version", { simple: true }) as number;
      expect(version).toBe(6);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow') AND name IN ('notes', 'notes_fts', 'notes_vec')")
        .pluck()
        .all() as string[];
      expect(tables).toContain("notes");
      expect(tables).toContain("notes_fts");
      expect(tables).toContain("notes_vec");
      expect((db.pragma("table_info(sessions)") as { name: string }[]).some(column => column.name === "archived_at")).toBe(true);
    } finally {
      db.close();
    }
  });
});
