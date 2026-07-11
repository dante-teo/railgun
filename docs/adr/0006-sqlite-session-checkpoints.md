# ADR 0006: SQLite session checkpoints

- Status: Accepted
- Date: 2026-07-10

## Context

Interactive history and todos previously disappeared when Railgun exited.
Phase 12 needs local durability, exact model restoration, atomic conversation
and todo updates, idempotent retry after save failures, and useful corruption
diagnostics. One-shot invocations must retain their stateless scripting
contract.

## Decision

Use synchronous `better-sqlite3` behind the factory returned by
`createSessionStore`. Store state in `~/.railgun/state.db`, enable WAL,
foreign keys, and a five-second busy timeout, version the schema with
`PRAGMA user_version`, and restrict the database to the current OS user.

The `sessions` table stores immutable session identity, model, start time,
and the latest normalized todo JSON. The `messages` table stores strictly
validated role-specific JSON plus stable per-session ordinals, tool metadata,
assistant response IDs, and timestamps. A unique `(session_id, ordinal)`
constraint and prefix comparison make complete-snapshot retries idempotent.
Malformed JSON, invalid role shapes, impossible transcript sequences, broken
todos, and divergent checkpoints fail closed with a session-specific error;
bad rows are never skipped or deleted.

Create a session row lazily inside its first successful checkpoint. Each
later successful Devin turn atomically appends unseen messages and replaces
the todo snapshot. A failed Devin turn restores the pre-turn todo snapshot
and writes nothing. Tool-driven file or shell effects are outside this
transaction and cannot be rolled back. If SQLite saving fails, keep the
completed history and todos in memory, display an unsaved warning, and retry
the full in-memory snapshot after the next successful turn.

Resume is a startup concern only. Exact IDs load directly; bare `--resume`
uses a newest-first Ink chooser controlled with Up/Down and Enter, with
Escape/Ctrl-C cancellation. Resumes require the stored model but rebuild the
system prompt and project context from the current launch and use a fresh
iteration budget. `--list-sessions` and the chooser inspect SQLite before any
Devin authentication. `--print` never creates a store.

## Consequences

- Interactive work survives clean exits and process crashes after the last
  committed checkpoint.
- SQLite transactions keep messages and todos mutually consistent, while the
  synchronous boundary stays small and easy to test with real temp databases.
- The application gains a native dependency and must build or download the
  compatible `better-sqlite3` binary for supported Node versions.
- Corruption is visible and actionable rather than silently losing context.
- Phase 12 intentionally provides no paging, search, rename, delete, session
  switching, persisted tool UI, or persisted iteration-budget usage.

## Amendment — Phase 30: session branching and forking

- Status: Accepted
- Date: 2026-07-12

Schema version bumped from 1 to 2. The `messages` table gains `id INTEGER
PRIMARY KEY` and `parent_id INTEGER NULL` (self-reference); the
`UNIQUE(session_id, ordinal)` constraint is dropped to allow forked branches
to share ordinal values. The `sessions` table gains `current_leaf_id INTEGER
NULL`. A new `branch_summary` role is added to the role CHECK.

A v1 → v2 data migration recreates the `messages` table, copies existing
rows, and wires linear `parent_id` chains plus `current_leaf_id` values for
all pre-existing sessions. The migration runs inside a transaction so a
mid-migration crash cannot leave version-2 metadata with partially-wired
chains.

`loadSession` no longer uses `ORDER BY ordinal`; it walks the `parent_id`
chain from `current_leaf_id` to root using a single recursive CTE
(`selectBranchFromLeaf`). `branch_summary` rows are DB-internal routing
pivots: they are never returned as conversation history by `loadSession`,
and `saveTransaction` filters them out before comparing the checkpoint
against stored rows.

Four new `SessionStore` methods: `branch` (moves `current_leaf_id`),
`branchWithSummary` (generates a summary of the abandoned path via the
live Devin provider, inserts a `branch_summary` row, then moves the leaf),
`forkSession` (copies the active branch into a new session with independent
row ids), and `getRecentMessages` (returns the last N messages with
id/role/preview for the `/branch` picker). All multi-write operations
(`branchWithSummary` insert + leaf update, `forkSession`) are wrapped in
`db.transaction` for atomicity.