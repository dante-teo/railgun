# 0014. Persistent memory via SQLite in Phase 25

Date: 2026-07-12

## Status

Accepted

## Context

Phase 25's goal is cross-session memory: the agent remembers facts ("I am
vegetarian"), preferences ("I prefer concise answers"), and project details
("My project is called Railgun") across completely independent sessions — no
`--resume` required. Hermes Agent implements this as a retrieval-augmented
prompt injection: facts are persisted to a store and the most relevant ones
are injected into every new session's system prompt.

The codebase already has a SQLite database (`~/.railgun/state.db`) for
session checkpoints. Adding a `memories` table there is zero-overhead for
the user and keeps the persistence story in one file and one connection. The
session store already has `better-sqlite3` prepared statements and WAL mode;
memory reads/writes share both.

Two design choices needed recording:

1. **How to search memories at tool call time**: full-text search (FTS5) vs.
   simple `LIKE`. FTS5 is correct long-term but requires a virtual table and
   vocabulary to explain its tokenizer behavior. `LIKE` is a two-line query,
   case-insensitive for ASCII, and correct for Phase 25's purpose — the corpus
   is small (user-authored personal notes, not documents). FTS5 is deferred to
   Phase 26.

2. **How to share the SQLite connection**: open a second connection (WAL
   supports concurrent readers), or expose the existing handle. A second
   connection from the same process to the same WAL database is safe but adds
   an unnecessary file descriptor and a second `PRAGMA` setup. Exposing the
   handle as `readonly db` on `SessionStore` is cleaner. The leakage surface
   is bounded: `MemoryStore` only prepares three statements and never closes
   the connection (lifecycle remains with `SessionStore`).

## Decision

Add a `memories` table to the existing `state.db` SQLite database (schema v3,
migrating v1 databases transparently). Expose `readonly db: Database.Database`
on the `SessionStore` interface so a `MemoryStore` can share the connection.

`createMemoryStore(db)` owns three prepared statements:
- `insertMemory`: UUID id, content, category, Unix epoch seconds as REAL.
- `selectRecent`: `ORDER BY created_at DESC, rowid DESC LIMIT ?` — `rowid`
  as tiebreaker ensures stable insertion order when two saves happen within
  the same millisecond (common in tests, possible in fast tool bursts).
- `selectSearch`: `WHERE content LIKE '%' || ? || '%' COLLATE NOCASE ORDER BY
  created_at DESC, rowid DESC LIMIT ?`. `COLLATE NOCASE` is technically
  redundant (SQLite LIKE is ASCII-case-insensitive by default) but makes
  the intent explicit.

Memory injection uses a hard limit of 20 recent memories (`recent(20)`)
formatted as a bullet list by `formatMemoriesForPrompt`, returning `null`
for empty stores (no `# Memories` block added). The limit is a constant, not
configurable — Phase 26 will replace whole-list injection with on-demand
`memory_search` calls once the corpus grows large enough to matter.

Two tools registered under the new `"memory"` toolset (always enabled):
- `memory_write` — saves a fact; category enum: `"preference"`, `"fact"`,
  `"project"`. The tool rules block instructs the agent when to call it.
- `memory_search` — keyword search; returns `[category] content` lines or
  the no-match sentinel.

All three session modes (fresh REPL, resume, one-shot/print) open the
database and create a `MemoryStore` via the new `withStores` helper in
`cli.ts`. The `--list-sessions` mode is unchanged (no agent, no memories).

## Consequences

- **Schema migration**: existing v1/v2 databases are migrated transparently on
  first open via the `MIGRATIONS` array in `sessionStore.ts`. The `memories`
  table is created as part of the v1→v2 migration (index 1). Each migration
  step runs inside a transaction that atomically bumps `user_version`, so a
  crash mid-migration cannot leave the schema and the version stamp out of sync.

- **All modes open the DB**: `--print` mode now opens `state.db` to read
  memories, which was previously a no-op. This is a small behavior change
  but consistent: one-shot queries benefit from memory context the same way
  interactive sessions do.

- **`SessionStore.db` exposure**: the `db` handle is typed `readonly` on the
  interface. Callers that only receive `SessionStore` (e.g. `cli.test.ts`
  mocks) must supply a `db` field. The test mock uses an in-memory SQLite DB
  with only the `memories` table, sufficient for `withStores` to call
  `createMemoryStore`.

- **No categorization enforcement at the handler level**: the category value
  is constrained by the JSON schema `enum` sent to the model but not validated
  server-side in the handler. This matches the `todo` tool's status handling
  (schema-level only). A future hardening pass could add a server-side check.

- **20-memory hard limit and LIKE search**: both are intentional simplifications
  for Phase 25. Phase 26 replaces with FTS5 and on-demand retrieval as the
  memory store grows.

- **No `close()` on `MemoryStore`**: lifecycle stays with `SessionStore`.
  `MemoryStore` prepares statements but never owns the connection.
