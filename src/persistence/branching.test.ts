import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevinMessage, DevinProvider, DevinStreamEvent } from "widevin";
import {
  SessionCorruptionError,
  createSessionStore,
  type SessionCheckpoint,
  type SessionStore,
} from "./sessionStore.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const startedAt = "2026-07-10T12:00:00.000Z";
const todos = [] as const;

const userAssistantMessages: readonly DevinMessage[] = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
  { role: "user", content: "How are you?" },
  { role: "assistant", content: [{ type: "text", text: "Fine, thanks" }] },
  { role: "user", content: "Goodbye" },
  { role: "assistant", content: [{ type: "text", text: "See you" }] },
];

const checkpoint = (overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint => ({
  id: "session-branch",
  model: "model-x",
  startedAt,
  messages: userAssistantMessages,
  todos,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Fake DevinProvider
// ---------------------------------------------------------------------------

type StreamChatRequest = Parameters<DevinProvider["streamChat"]>[0];
type FakeProvider = DevinProvider & { streamChatRequests: StreamChatRequest[] };

const fakeProvider = (summary: string): FakeProvider => {
  const streamChatRequests: StreamChatRequest[] = [];
  const events: DevinStreamEvent[] = [
    { type: "text_delta", delta: summary },
  ];
  const provider: DevinProvider = {
    login: async () => "",
    setToken: async () => {},
    clearToken: async () => {},
    listModels: async () => [],
    streamChat: async function* (request: StreamChatRequest) {
      streamChatRequests.push(request);
      for (const event of events) yield event;
    },
  };
  return Object.assign(provider, { streamChatRequests });
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("branching", () => {
  let dir: string;
  let path: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-branching-"));
    path = join(dir, "branch.db");
    store = createSessionStore(path);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. v1 → v2 migration
  // -------------------------------------------------------------------------

  it("migrates a v1 database to v2 with correct parent chains", async () => {
    store.close();

    // Build a v1 schema database manually.
    const db = new Database(path);
    db.exec(`
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
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
      PRAGMA user_version = 1;
    `);
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run("s1", "m1", startedAt, "[]");
    const msgs: Array<[string, number, string, string]> = [
      ["s1", 0, "user", JSON.stringify("msg 0")],
      ["s1", 1, "assistant", JSON.stringify([{ type: "text", text: "msg 1" }])],
      ["s1", 2, "user", JSON.stringify("msg 2")],
      ["s1", 3, "assistant", JSON.stringify([{ type: "text", text: "msg 3" }])],
    ];
    for (const [sid, ord, role, content] of msgs) {
      db.prepare("INSERT INTO messages (session_id, ordinal, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(sid, ord, role, content, startedAt);
    }
    db.close();

    // Open with updated code — triggers migration.
    const migrated = createSessionStore(path);

    const db2 = new Database(path, { readonly: true });
    expect(db2.pragma("user_version", { simple: true })).toBe(2);

    interface MsgRow { id: number; parent_id: number | null; ordinal: number }
    const rows = db2.prepare("SELECT id, parent_id, ordinal FROM messages WHERE session_id = 's1' ORDER BY id ASC").all() as MsgRow[];
    expect(rows).toHaveLength(4);

    // First row: no parent.
    expect(rows[0]?.parent_id).toBeNull();
    // Each subsequent row points to the previous.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.parent_id).toBe(rows[i - 1]?.id);
    }

    interface SessionRow { current_leaf_id: number | null }
    const session = db2.prepare("SELECT current_leaf_id FROM sessions WHERE id = 's1'").get() as SessionRow;
    expect(session.current_leaf_id).toBe(rows[rows.length - 1]?.id);

    db2.close();
    migrated.close();
  });

  // -------------------------------------------------------------------------
  // 2. branch() moves leaf pointer and preserves abandoned messages
  // -------------------------------------------------------------------------

  it("branch moves the leaf pointer and preserves abandoned messages", () => {
    store.saveCheckpoint(checkpoint());

    // Load the session to get message ids via the store's internal state.
    // We need to query the DB directly for message ids.
    const db = new Database(path, { readonly: true });
    interface IdRow { id: number; ordinal: number }
    const rows = db.prepare("SELECT id, ordinal FROM messages ORDER BY id ASC").all() as IdRow[];
    db.close();

    // Branch to message at ordinal 3 (4th message, 0-indexed).
    const msg3 = rows.find(r => r.ordinal === 3);
    expect(msg3).toBeDefined();
    store.branch("session-branch", msg3!.id);

    // loadSession should return only messages 0–3.
    const loaded = store.loadSession("session-branch");
    expect(loaded?.messages).toHaveLength(4);

    // Abandoned messages 4–5 still exist in the DB.
    const db2 = new Database(path, { readonly: true });
    interface CountRow { count: number }
    const allCount = db2.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'session-branch'").get() as CountRow;
    expect(allCount.count).toBe(6);
    db2.close();
  });

  // -------------------------------------------------------------------------
  // 3. New messages after branch form a new fork
  // -------------------------------------------------------------------------

  it("new messages after branch form a new fork", () => {
    store.saveCheckpoint(checkpoint());

    const db = new Database(path, { readonly: true });
    interface IdRow { id: number; ordinal: number }
    const rows = db.prepare("SELECT id, ordinal FROM messages ORDER BY id ASC").all() as IdRow[];
    db.close();

    const msg2 = rows.find(r => r.ordinal === 2);
    expect(msg2).toBeDefined();
    store.branch("session-branch", msg2!.id);

    // Save a checkpoint with messages 0–2 + a new message 4' (ordinal 3).
    const newMessages: readonly DevinMessage[] = [
      ...userAssistantMessages.slice(0, 3),
      { role: "assistant", content: [{ type: "text", text: "A new direction" }] },
    ];
    store.saveCheckpoint(checkpoint({ messages: newMessages }));

    const loaded = store.loadSession("session-branch");
    expect(loaded?.messages).toHaveLength(4);
    expect(loaded?.messages[3]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "A new direction" }] });

    // Old messages 3–5 still exist.
    const db2 = new Database(path, { readonly: true });
    interface CountRow { count: number }
    const allCount = db2.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'session-branch'").get() as CountRow;
    expect(allCount.count).toBe(7); // original 6 + 1 new message
    db2.close();
  });

  // -------------------------------------------------------------------------
  // 4. branchWithSummary inserts a summary message
  // -------------------------------------------------------------------------

  it("branchWithSummary inserts a summary message", async () => {
    store.saveCheckpoint(checkpoint());

    const db = new Database(path, { readonly: true });
    interface IdRow { id: number; ordinal: number }
    const rows = db.prepare("SELECT id, ordinal FROM messages ORDER BY id ASC").all() as IdRow[];
    db.close();

    // Branch with summary after message 1 (ordinal 1).
    const msg1 = rows.find(r => r.ordinal === 1);
    expect(msg1).toBeDefined();

    const provider = fakeProvider("Key decisions: went with approach A.");
    await store.branchWithSummary("session-branch", msg1!.id, provider, "test-model");

    const loaded = store.loadSession("session-branch");
    // branch_summary is a DB-internal leaf marker; loadSession excludes it and returns only
    // messages 0–1 (the branch point and everything before it).
    expect(loaded?.messages).toHaveLength(2);

    // The summary row has parent_id = msg1.id.
    const db2 = new Database(path, { readonly: true });
    interface SummaryRow { id: number; role: string; parent_id: number }
    const summaryRow = db2.prepare("SELECT id, role, parent_id FROM messages WHERE role = 'branch_summary'").get() as SummaryRow | undefined;
    expect(summaryRow?.role).toBe("branch_summary");
    expect(summaryRow?.parent_id).toBe(msg1!.id);
    db2.close();
  });

  // -------------------------------------------------------------------------
  // 5. forkSession creates an independent copy
  // -------------------------------------------------------------------------

  it("forkSession creates an independent copy", () => {
    store.saveCheckpoint(checkpoint());

    const newId = store.forkSession("session-branch");
    expect(newId).not.toBe("session-branch");

    const original = store.loadSession("session-branch");
    const forked = store.loadSession(newId);

    expect(forked?.messages).toHaveLength(original?.messages.length ?? -1);
    expect(forked?.messages).toEqual(original?.messages);

    // New checkpoint on the fork does not affect the original.
    const extraMsg: readonly DevinMessage[] = [
      ...(forked?.messages ?? []),
      { role: "user", content: "Fork only" },
      { role: "assistant", content: [{ type: "text", text: "Got it" }] },
    ];
    store.saveCheckpoint({
      id: newId,
      model: forked?.model ?? "model-x",
      startedAt: forked?.startedAt ?? startedAt,
      messages: extraMsg,
      todos: [],
    });

    // Original unchanged.
    expect(store.loadSession("session-branch")?.messages).toHaveLength(6);
    // Fork has extra messages.
    expect(store.loadSession(newId)?.messages).toHaveLength(8);

    // Message ids in fork are independent from original.
    const db = new Database(path, { readonly: true });
    interface IdRow { id: number }
    const origIds = new Set((db.prepare("SELECT id FROM messages WHERE session_id = 'session-branch'").all() as IdRow[]).map(r => r.id));
    const forkIds = new Set((db.prepare(`SELECT id FROM messages WHERE session_id = ?`).all(newId) as IdRow[]).map(r => r.id));
    const intersection = [...origIds].filter(id => forkIds.has(id));
    expect(intersection).toHaveLength(0);
    db.close();
  });

  // -------------------------------------------------------------------------
  // 6. getRecentMessages returns truncated previews
  // -------------------------------------------------------------------------

  it("getRecentMessages returns truncated previews", () => {
    store.saveCheckpoint(checkpoint());

    const recent = store.getRecentMessages("session-branch");
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThanOrEqual(10);

    for (const msg of recent) {
      expect(typeof msg.id).toBe("number");
      expect(typeof msg.role).toBe("string");
      expect(typeof msg.preview).toBe("string");
      expect(msg.preview.length).toBeLessThanOrEqual(80);
    }

    // Default limit 10, but we only have 6 messages.
    expect(recent).toHaveLength(6);
    expect(recent[recent.length - 1]?.role).toBe("assistant");
  });

  it("getRecentMessages respects the limit", () => {
    store.saveCheckpoint(checkpoint());
    const recent = store.getRecentMessages("session-branch", 3);
    expect(recent).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 7. branch to nonexistent message throws
  // -------------------------------------------------------------------------

  it("branch to nonexistent message throws", () => {
    store.saveCheckpoint(checkpoint());
    expect(() => store.branch("session-branch", 99999)).toThrow(/does not exist/);
  });

  // -------------------------------------------------------------------------
  // 8. round-trips a session with branch_summary messages
  // -------------------------------------------------------------------------

  it("round-trips a session with branch_summary messages", async () => {
    store.saveCheckpoint(checkpoint());

    const db = new Database(path, { readonly: true });
    interface IdRow { id: number; ordinal: number }
    const rows = db.prepare("SELECT id, ordinal FROM messages ORDER BY id ASC").all() as IdRow[];
    db.close();

    const msg3 = rows.find(r => r.ordinal === 3);
    expect(msg3).toBeDefined();

    const provider = fakeProvider("Summary of branch.");
    await store.branchWithSummary("session-branch", msg3!.id, provider, "test-model");

    // Add two more messages on the new branch.
    const current = store.loadSession("session-branch");
    expect(current).toBeDefined();
    // branch_summary is excluded from loadSession; current.messages = messages 0–3 (4 items).
    expect(current?.messages).toHaveLength(4);
    // Appending normally: new messages chain from the branch_summary leaf via parent_id.
    const extended: readonly DevinMessage[] = [
      ...(current?.messages ?? []),
      { role: "user", content: "Continuing on new branch" },
      { role: "assistant", content: [{ type: "text", text: "Sure" }] },
    ];
    store.saveCheckpoint(checkpoint({
      messages: extended,
      startedAt: current?.startedAt ?? startedAt,
    }));

    const reloaded = store.loadSession("session-branch");
    expect(reloaded?.messages).toHaveLength(extended.length);
    expect(reloaded?.messages[4]).toMatchObject({ role: "user", content: "Continuing on new branch" });
    expect(reloaded?.messages[5]).toMatchObject({ role: "assistant" });

    // The branch_summary row exists in the DB but is not part of the returned messages.
    const db2 = new Database(path, { readonly: true });
    interface CountRow { count: number }
    const summaryCount = db2.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'branch_summary'").get() as CountRow;
    expect(summaryCount.count).toBe(1);
    db2.close();
  });
  it("schema version is 2 after creation", () => {
    store.close();
    const db = new Database(path, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
    store = createSessionStore(path); // reopen for afterEach
  });

  it("multiple messages across rounds of saveCheckpoint work correctly", () => {
    store.saveCheckpoint(checkpoint({ messages: userAssistantMessages.slice(0, 2) }));
    store.saveCheckpoint(checkpoint({ messages: userAssistantMessages.slice(0, 4) }));
    store.saveCheckpoint(checkpoint());

    const loaded = store.loadSession("session-branch");
    expect(loaded?.messages).toEqual(userAssistantMessages);
  });

  it("branch to message that's not in the session throws for branchWithSummary", async () => {
    store.saveCheckpoint(checkpoint());
    // Save a second session.
    store.saveCheckpoint({
      id: "session-other",
      model: "model-x",
      startedAt,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "text", text: "Hey" }] },
      ],
      todos: [],
    });

    // Get a message id from session-other.
    const db = new Database(path, { readonly: true });
    interface IdRow { id: number }
    const otherMsg = db.prepare("SELECT id FROM messages WHERE session_id = 'session-other' LIMIT 1").get() as IdRow | undefined;
    db.close();
    expect(otherMsg).toBeDefined();

    // branch() on a different session's message id should throw (message not found in this session).
    expect(() => store.branch("session-branch", otherMsg!.id)).toThrow(/does not exist/);

    // branchWithSummary should also throw (not on the active branch).
    const provider = fakeProvider("irrelevant");
    await expect(store.branchWithSummary("session-branch", otherMsg!.id, provider, "m")).rejects.toThrow(/not on the active branch/);
  });
});
