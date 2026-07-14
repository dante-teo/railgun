# 0027. Semantic note search via sqlite-vec + multilingual-e5-small in Phase 27

Date: 2026-07-12

## Status

Accepted

## Context

Phase 26 added FTS5 keyword search (`note_search`) for the user's imported notes.
Keyword search fails when the user's query shares no lexical overlap with the
stored notes — for example, asking "what do I do for fun?" when the only
relevant note says "went hiking this weekend". Keyword search returns nothing
because none of the query words appear in the note text.

Two design choices needed recording:

1. **Model choice and prefix convention**: the embedding model must run locally,
   produce small vectors, and support English plus other languages the user may
   write notes in. `Xenova/multilingual-e5-small` is a 384-dimensional
   multilingual sentence-transformer that fits those constraints. The E5 family
   requires a task-specific prefix on every input: `"query: "` for search
   queries and `"passage: "` for documents being stored. Omitting the prefix
   makes all results look equally (incorrectly) similar.

2. **sqlite-vec KNN query syntax constraints**: sqlite-vec exposes vector KNN
   through a `MATCH` operator in the `WHERE` clause of a `vec0` virtual table.
   The exact SQL shape matters: `WHERE embedding MATCH ? AND k = ?` works,
   but moving the `k` limit to `LIMIT ?` as a separate bind parameter is
   rejected at `prepare()` time by sqlite-vec. Queries must also pass integer
   `rowid` values to better-sqlite3 as `BigInt`.

## Decision

Extend the schema from v4 to v5, load the sqlite-vec extension, and add a new
semantic search tool alongside `note_search`:

- Load the sqlite-vec extension via `sqliteVec.load(db)` inside
  `initializeSchema`, **before** the migration loop. This is required because
  migration index 4 creates a `vec0` virtual table, which cannot be created
  until the extension module is registered in the connection.

- Schema v4→v5: create a `notes_vec` virtual table with a 384-dimensional float
  vector. The implicit `rowid` mirrors the corresponding `notes.id`, matching the
  `notes_fts` pattern.

  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_vec USING vec0(
    embedding FLOAT[384]
  );
  ```

- New module `src/persistence/embedder.ts`: wraps
  `Xenova/multilingual-e5-small` through `@huggingface/transformers`. The heavy
  `onnxruntime-node` dependency is only loaded on the first `embedText()` call
  because the `pipeline` import is dynamically imported inside `getEmbedder()`.
  The embedder is a promise-cached singleton; if the promise rejects, the cached
  instance is cleared so the next call can retry. E5 prefixes are applied in
  `embedText(text, kind)` — `"query: "` for queries and `"passage: "` for stored
  passages.

- `NoteStore` is extended with `storeVector`, `searchSemantic`,
  `importFolderWithEmbeddings`, and `backfillEmbeddings`. An `EmbedFn` type
  keeps `NoteStore` decoupled from the embedder module so tests and callers can
  supply deterministic fake embedders.

- `storeVector(noteId, embedding)` inserts into `notes_vec` using
  `BigInt(noteId)` for the `rowid` column. This is required by the
  better-sqlite3 + sqlite-vec binding.

- `searchSemantic(queryVector, limit)` uses the KNN subquery shape
  `WHERE embedding MATCH ? AND k = ?`, then joins back to `notes` for
  `source_path` and `content`. Using `LIMIT ?` as a separate bind parameter is
  not supported by sqlite-vec at prepare time.

- `importFolderWithEmbeddings(folderPath, embedFn, chunkWords)` is the async
  counterpart to `importFolder`: it reads and chunks files the same way, then
  embeds each chunk before storing its vector. There is no outer transaction
  wrapping the async embed loop.

- `backfillEmbeddings(embedFn)` finds every `notes` row that has no
  corresponding `notes_vec` row (`n.id NOT IN (SELECT rowid FROM notes_vec)`),
  embeds its content as a passage, and stores the vector. It is idempotent:
  running it when all notes already have vectors returns 0.

- `import-notes` CLI: the handler now runs
  `importFolderWithEmbeddings` and then `backfillEmbeddings`. Error isolation
  preserves the original import error over any secondary backfill error, and
  backfill always runs so partial imports are self-healing on the next
  invocation.

- New tool `note_search_semantic` is registered under the existing `"memory"`
  toolset. The system prompt is updated to guide the model to try `note_search`
  first (faster, exact keyword match) and fall back to `note_search_semantic`
  when the question is about a broad topic or feeling and keyword search finds
  nothing. If embedding or vector retrieval throws, the tool catches that
  failure and runs `NoteStore.search` with the same query. The fallback is
  reported in the tool content and remains a successful tool result, including
  when keyword search finds no matches, so the agent can continue instead of
  stalling on an optional native dependency.

## Consequences

- **First-run model download**: the first call to `embedText` downloads the ONNX
  model from HuggingFace Hub. Subsequent runs reuse the cached model.

- **Upgrade from Phase 26**: notes imported before Phase 27 exist in `notes` and
  `notes_fts` but have no vectors. The next `import-notes` run backfills them
  automatically via `backfillEmbeddings`; the user does not need a separate
  command.

- **No transaction around the async embed loop**: this is deliberate. A crash
  mid-import leaves `notes` and `notes_fts` rows but no vectors for the
  in-flight chunk. `backfillEmbeddings` picks up exactly those gaps on the next
  run.

- **Native build dependencies**: `@huggingface/transformers` pulls in
  `onnxruntime-node`, `protobufjs`, and `sharp` as transitive dependencies that
  require native compilation. The pnpm workspace must permit their build scripts.

- **Complementary search path**: keyword search remains the first choice for
  speed and exact matches. Semantic search is a fallback for conceptual or
  feeling-based queries, widening recall at the cost of a slower, model-backed
  call. When that model-backed path is unavailable, the semantic tool degrades
  to safe keyword search rather than returning an embedding dependency error.
