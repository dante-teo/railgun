# ADR 0014: Session branching and forking

- Status: Accepted
- Date: 2026-07-12

## Context

Phase 30 adds two interactive history operations to the existing SQLite
session store: **branching** (rewind to an earlier message and continue
from there, optionally summarizing the abandoned path) and **forking**
(extract the current active path into a brand-new independent session).

The Phase 12 schema was linear: every session's messages formed a
contiguous `(session_id, ordinal)` sequence. Branching requires a tree
structure where messages have parents, and the active path is a chain from
the current leaf back to the root. The key design decisions are:

1. How to represent the tree without breaking the existing linear read path.
2. Where to put the `branch_summary` content so it does not appear as a
   real conversation message but still enables parent-chain traversal.
3. How to keep `saveTransaction` idempotent across branches.
4. Whether to share the summarization code with `compaction.ts`.

## Decision

**Tree structure via `parent_id` + `current_leaf_id`.** Each `messages`
row gains a nullable `parent_id` self-reference. Each `sessions` row gains
`current_leaf_id`. `loadSession` walks the chain from the leaf to the root
using a single recursive CTE (`selectBranchFromLeaf`), reversing the order
for chronological output. This replaces the `ORDER BY ordinal` query.

**`branch_summary` as a routing pivot, not a history entry.**
`branchWithSummary` inserts a row with `role = 'branch_summary'` as the
new leaf. This row is a DB-internal node: `loadSession` filters it out
before returning messages, and `saveTransaction` also filters it out when
comparing the checkpoint against stored rows. New messages after a
`branchWithSummary` call chain from the summary row's `id`, so the summary
acts as a transparent pivot without polluting conversation history. The
`UNIQUE(session_id, ordinal)` constraint is dropped in v2 to accommodate
fork branches that share ordinal values.

**`saveTransaction` filters `branch_summary` rows.** Rather than the v1
approach of comparing all stored rows against the checkpoint by ordinal,
v2 walks the active branch via `getBranch()`, filters out any
`branch_summary` rows for comparison purposes (recording the last DB row's
id as the parent for new inserts), and compares remaining stored rows
against encoded checkpoint entries in order. This keeps `saveCheckpoint`
idempotent and makes full-snapshot retries work correctly even on branched
sessions.

**Separate `branchSummarizer.ts`, not shared with `compaction.ts`.** Both
modules call the model to produce a summary, but their inputs, outputs, and
error-handling differ enough that a shared abstraction would add more
indirection than it saves. `runCompaction` returns structured
`{ messages, usage }` with a specific compacted-message format and retries
on 413. `summarizeMessages` returns a plain string with no retry logic.
Duplication of the `for await ... text_delta` pattern is preferred over a
shared helper that would need flags to distinguish the two behaviors.

**All multi-write operations are transactional.** `branchWithSummary`
(insert + leaf update), `forkSession` (session insert + N message inserts +
leaf update), and each schema migration each run inside `db.transaction(...)`.
A crash mid-operation leaves either the full effect or nothing — never partial
rows with a stale leaf pointer, and never a schema change without its
corresponding `user_version` bump (the pragma is issued inside the same
transaction as the DDL).

**`/branch` and `/fork` as REPL slash commands.** The branch/fork surface
is two new commands. `/branch [--summary] [id]` with no id prints a recent-
message picker. `/fork` copies the active branch into a new session and
updates the displayed history in place. Both are wired via optional
callbacks in `ReplPersistenceOptions` so sessions without persistence
continue to work unchanged. The `branchWithSummary` callback requires a
live Devin provider and is patched into the options object after session
initialisation in both the fresh and resume code paths.

## Consequences

- Abandoned branch messages persist in `state.db` indefinitely. There is
  no garbage collection for off-branch rows in Phase 30.
- `branch_summary` content is stored raw in the DB but never decoded into
  conversation history. A future phase could expose it in the session
  chooser or a branch-tree viewer.
- `ordinal` values on messages after a fork or branch are set to the
  message's position in the current branch path at save time. They are
  human-readable but are not a structural invariant — `parent_id` is the
  ordering source of truth.
- `forkSession` generates the new session id as
  `\`${sourceId}-fork-${Date.now()}\``. This is stable enough for a
  single-user local tool; a distributed scenario would need a UUID.
- The v1 schema had `messages_session_ordinal ON messages(session_id,
  ordinal)`. The v2 schema replaces it with `messages_session ON
  messages(session_id)` and `messages_parent ON messages(parent_id)` to
  support the recursive CTE join on `parent_id`.
