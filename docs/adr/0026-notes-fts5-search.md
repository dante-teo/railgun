# 0026. Long-term notes search via SQLite FTS5 in Phase 26

Date: 2026-07-12

## Status

Accepted

## Context

Phase 25 deferred two things to Phase 26 explicitly: replacing LIKE-based
`memory_search` with FTS5, and adding a bulk-import path for longer documents.
The memory store was designed for short, user-authored facts (≤a few sentences
per row). FTS5 on that corpus adds complexity for little gain. Instead, Phase 26
targets a distinct use case: the user's own reference documents — notes,
research, journal entries — that are too long to hold in the memory table and
too numerous to manually prompt-inject.

Two design choices needed recording:

1. **Separate table vs. reusing `memories`**: the `memories` table is designed
   for short, categorized, agent-written rows inserted one at a time by tool
   call. Notes are user-authored files, may be thousands of words, require
   chunking, and have no category. Sharing the table would require nullable
   category, a mixed-purpose LIKE index, and confusing query semantics. A
   separate `notes` table is unambiguous.

2. **FTS5 sync strategy — triggers vs. application-level**: SQLite FTS5 can be
   kept in sync either by the application (insert into the virtual table
   explicitly alongside the main table) or by database triggers. Triggers are
   the correct choice here: the `notes` table has a single writer
   (`importFolder`) but could have additional future writers; triggers guarantee
   the FTS index is always in sync regardless of which code path performs the
   write. Three triggers cover insert, delete, and update.

3. **FTS5 query sanitization**: FTS5 queries have their own syntax (`OR`, `AND`,
   `"phrases"`, `field:token`, `*` prefix). User-supplied keyword searches are
   not FTS5 queries — they are plain keywords that should match anywhere in the
   content. Passing raw user input to `MATCH` risks a syntax error that would
   propagate to the tool handler as a crash. The solution is `sanitizeFts5Query`:
   extract Unicode letter, combining-mark, number, and underscore tokens, quote
   each token as an FTS5 literal, and join them with implicit `AND` semantics.
   This safely handles punctuation such as apostrophes, hyphens, and email
   addresses while neutralizing operators such as `AND`, `OR`, and `NOT`. If no
   tokens remain, `search` returns `[]` without hitting SQLite at all.

4. **Chunking strategy**: files are split into fixed-size word chunks (default
   500 words) before insertion. This is the simplest approach that avoids
   storing multi-megabyte rows in SQLite (which degrades FTS index performance)
   and allows snippet extraction to work on a reasonably-sized unit of text. The
   trade-off is that a chunk boundary may split a sentence — FTS5's `snippet()`
   function mitigates this by extracting the most relevant 30-token window
   regardless. Smarter chunking (paragraph-aware, heading-aware) is deferred.

5. **Non-recursive folder walk**: `importFolder` reads only the top level of
   the supplied directory. This keeps the command predictable and avoids
   accidentally importing deep directory trees. Users can import subfolders
   explicitly.

## Decision

Add a `notes` table and a `notes_fts` FTS5 virtual table to `state.db` (schema
v4, migrating from v3 transparently):

```sql
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT,
  content TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(content);
-- Three triggers keep the index in sync automatically.
```

`createNoteStore(db)` owns two prepared statements and one transaction:
- `selectSearch`: FTS5 `MATCH` query with `snippet(notes_fts, 0, '>>>', '<<<', '...', 30)`, joined back to `notes` for `source_path`, ordered by `rank`, limited to 5 results by default.
- `insertNote`: inserts one chunk row; called inside a `db.transaction()` that wraps the entire folder import.

`importFolder(folderPath, chunkWords = 500)` reads the top-level directory with
`readdirSync`, skips non-`.md`/`.txt` files, splits each file's content on
`\s+`, chunks into groups of `chunkWords` non-empty words, and inserts each
chunk inside a single transaction. Returns the total number of inserted chunks.

One new tool, `note_search`, is registered under the existing `"memory"` toolset
(always enabled). The tool rules block in the system prompt instructs the agent
to use it before saying it doesn't know something. The handler gracefully returns
an error result when `noteStore` is absent from the context (no crash).

One new CLI command, `import-notes <folder>`, runs `importFolder` via
`withStores` and prints the chunk count to stdout. Trust flags (`--approve`,
`--no-approve`) are rejected for this command.

## Consequences

- **Schema migration**: v3 databases are migrated transparently on next open.
  The migration is pure DDL — no data transformation needed. If the migration
  runs and the process crashes before `user_version` is bumped, SQLite's
  transaction rollback guarantees the next open re-runs the migration cleanly
  (the `CREATE TABLE IF NOT EXISTS` and `CREATE VIRTUAL TABLE IF NOT EXISTS`
  forms are idempotent).

- **`noteStore` on `ToolContext` is optional**: same pattern as `memoryStore`.
  Contexts without a wired store (e.g. cron sessions, future test harnesses)
  get a graceful error from the tool, never a crash.

- **`SessionStore.db` re-used**: `createNoteStore(db)` receives the same
  connection handle already exposed via `SessionStore.readonly db`. No second
  connection is opened. Lifecycle stays with `SessionStore`.

- **`notes` rows are immutable after insert**: there is no update or delete API
  in `NoteStore`. The update trigger exists for completeness and future
  correctness in case rows are ever modified by raw SQL or a future tool; it
  carries no current code path.

- **No deduplication**: re-running `import-notes` on the same folder inserts
  duplicate chunks. The search still works — FTS5 returns the best-ranked
  results regardless of duplicates — but the database grows. A future
  `--replace` flag could clear existing rows for the folder before importing.

- **LIKE search in `memory_search` unchanged**: Phase 25's `memory_search` still
  uses LIKE. The memories corpus is small and user-authored; FTS5 overhead is
  not justified there. The Phase 25 ADR's forward-reference to "Phase 26 will
  replace with FTS5" referred to the notes feature, not a retrofit of memory
  search.
