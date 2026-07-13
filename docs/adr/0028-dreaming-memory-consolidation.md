# 0028. Memory dreaming: consolidation and SOUL.md promotion in Phase 28

Date: 2026-07-13

## Status

Accepted

## Context

Memories accumulate in `state.db` across sessions via `memory_write`. Without
pruning, the store grows unbounded: duplicate facts appear when the user repeats
information across sessions, contradicting memories coexist, and vague entries
never get refined. Hermes Agent solves this with a background curator that
periodically reviews and consolidates the memory store.

A second problem: stable preferences — things the user consistently wants the
agent to do across all sessions and projects — live in the `memories` table
with no path to `~/.railgun/SOUL.md`, which is the actual persistent identity
file injected unconditionally at every session start. A memory that survives
multiple consolidation passes is effectively identity-level and belongs in
`SOUL.md`.

## Decision

### `railgun dream` CLI command and `/dream` REPL slash command

`dispatchCli` handles `{ kind: "dream" }`: it calls `initSession()` for an
authenticated provider and model, opens `state.db` via `withStores`, and
calls `runDreamSession`. The `/dream` slash command in the REPL calls the
same function with the already-open `memoryStore`, routing log messages
through `setLines` so they appear as transcript lines instead of writing to
stderr (which would corrupt Ink's managed TUI output).

### `runDreamSession` (`src/dream/dreamJob.ts`)

The dream session is a bounded `createAgent` call with a 30-step
`IterationBudget`, `enabledToolsets: ["dream", "file"]`, and no shell access
(`confirmShellCommand: async () => false`). It receives the `DREAM_SYSTEM_PROMPT`
instead of the normal system prompt.

Before starting the agent, `runDreamSession` calls `memoryStore.all()` — if
fewer than 5 memories exist it exits early, since there is nothing meaningful
to consolidate. Otherwise it also calls `loadSoulIdentity()` to read the
current `SOUL.md` content (or `null` if absent) and packages both into
`formatDreamMessage`, which produces the user message.

### Two-phase dream system prompt

`DREAM_SYSTEM_PROMPT` instructs the curator in two phases:

1. **Phase 1 — Consolidate**: use `memory_consolidate` to merge duplicates,
   delete stale/contradicted entries, and update vague wording. Preferences
   must never be deleted unless explicitly contradicted by a newer preference.

2. **Phase 2 — Promote**: after consolidation, review remaining `"preference"`
   memories. Those that are stable and identity-level — describing how the user
   wants the agent to behave across all sessions — should be written to
   `~/.railgun/SOUL.md` via `write_file` (appending to existing content, never
   erasing unrelated sections) and then deleted from the store with
   `memory_consolidate(action: "delete")`. The current `SOUL.md` content is
   included in the user message so the agent never promotes something already
   captured.

### `memory_consolidate` tool (`src/tools/memoryConsolidate.ts`)

Registered under the `"dream"` toolset, unavailable in normal sessions. Accepts
an `operations` array:

| Action | Requirement | Effect |
|--------|-------------|--------|
| `merge` | ≥2 `ids`, `newContent`, `category` | Deletes all source IDs, saves one combined memory |
| `delete` | ≥1 `ids` | Removes each memory |
| `update` | exactly 1 `id`, `newContent` | Rewrites content/category via `update()` |

All operations in a batch run inside a single `memoryStore.runInTransaction`
call. Validation errors inside the batch use `continue` semantics — one
malformed operation logs an error string in the result but does not abort
the remaining operations.

### `MemoryStore` extensions

Four new methods added to support the dream subsystem:

- `all()` — all memories in ascending `created_at` order (dream needs the
  complete picture, unlike `recent` which is top-N newest-first).
- `delete(id)` — returns whether the row existed.
- `update(id, content, category)` — uses `UPDATE … RETURNING` so the returned
  `Memory` carries the original `created_at` timestamp, not `Date.now()`.
- `runInTransaction(fn)` — wraps the callback in a SQLite transaction via
  `db.transaction(fn)()`.

## Consequences

- **No automatic scheduling**: `railgun dream` is a one-shot command that
  users schedule externally (e.g. `0 3 * * * railgun dream` in crontab).
  The existing `railgun cron` infrastructure is not used — unattended dreaming
  does not fit the cron job model (it needs the full memory store, not a
  single scheduled prompt).

- **LLM cost per run**: each dream is a full agent session. With 20 memories
  the prompt is small (~2K tokens); with hundreds it grows proportionally.
  The 30-step budget caps work without capping context size. If the memory
  count grows very large, a future `batchSize` parameter could chunk the
  memories into sequential passes.

- **SOUL.md write trust**: agent-written `SOUL.md` goes through the same
  `scanForInjection` call on next session load. Content that triggers the
  injection scanner will be blocked with a `[BLOCKED: ...]` placeholder on
  reload — the correct defensive posture for agent-written identity content.

- **Minimum threshold (5 memories)**: the early-exit guard prevents wasteful
  LLM calls when the store is nearly empty.

- **REPL vs CLI log routing**: the `log` parameter defaults to `console.error`
  for the CLI path (stderr is appropriate there) and is overridden in the
  REPL's `/dream` handler to route through `setLines` as transcript lines,
  preventing raw stderr writes from corrupting Ink's managed TUI output.
