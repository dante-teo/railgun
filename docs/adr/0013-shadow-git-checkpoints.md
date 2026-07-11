# 0013. Shadow-git checkpoints and `/rollback`

Date: 2026-07-12

## Status

Accepted

## Context

Phase 22 adds a safety net for file-mutating tool calls: a snapshot of the
working directory taken automatically before the first mutating tool executes
in a given user turn, and a `/rollback` REPL command to restore the working
tree to that pre-turn state.

The mechanism needs to:

- Be invisible during normal operation — zero ceremony when no rollback is needed.
- Survive concurrent agent runs on different projects without collision.
- Work without adding a runtime dependency (no new npm packages).
- Not interfere with the user's own `.git` repository.

Three approaches were considered:

1. **File copies to a temp directory.** Simple, but naive — misses deletions,
   symlinks, binary files, and requires tracking every affected path.

2. **`git stash` inside the user's own repo.** Reuses an existing git repo, but
   deeply entangled with the user's own commit graph and stash stack. Breaks
   outside a git repo. Invasive — running `/rollback` would leave stash
   entries visible in `git stash list`.

3. **Separate shadow git repository (`GIT_DIR` + `GIT_WORK_TREE`).** A plain
   (non-bare) git repo initialized at a path outside the project directory,
   pointed at the project's working tree via environment variables. Git does all
   the diffing, staging, binary handling, and tree restoration. Completely hidden
   from the user's own repo and git tooling.

Option 3 was chosen.

## Decision

**Shadow git directory:** `~/.railgun/checkpoints/<hash>/` where `<hash>` is
the first 12 hex characters of the SHA-256 of the absolute `cwd` path. One
directory per project cwd — no collision between concurrent runs on different
projects.

**Repository type:** Non-bare (`git init` via `GIT_DIR=<dir>` env, not
`--bare`). A bare repo sets `core.bare = true`, which causes git to reject
`git add` even when `GIT_WORK_TREE` is set. A non-bare repo initialized at
the shadow path (not the work tree) accepts both `GIT_DIR` and
`GIT_WORK_TREE` together.

**Snapshot timing:** Once per user turn, on the first file-mutating tool call
(`write_file` or `run_shell_command` after approval). A per-turn guard
(`CheckpointGuard`) tracks whether a snapshot has already been taken this turn
and makes subsequent `beforeMutation` calls no-ops. `resetTurn` is called at
the REPL layer before each `agentSession.run()` — not inside `runTurn`'s
while loop, which iterates multiple model rounds within the same user turn.

**Tool scope:** Only `write_file` and `run_shell_command` call `beforeMutation`.
Read-only tools (`read_file`, `list_directory`, `todo`) are not snapshotted —
they produce no filesystem mutations to roll back. This is a deliberate
decision to avoid the cost of `git add -A` on every tool call.

**Rollback:** `git checkout HEAD -- .` restores all tracked files to the
most recent commit in the shadow repo. Files that were added since the last
snapshot and not tracked before are not removed by this command — a known
limitation. If no snapshot has been taken in the current session (the user
types `/rollback` before any mutation), the command fails with a clear error
(git has no HEAD to check out from).

**`git` availability:** The checkpoint system hard-requires `git` on `$PATH`.
`execFileSync` throws if git is absent; the error propagates to the tool
registry's catch block and surfaces as an error result. No fallback is
planned — git is a universal developer dependency.

## Consequences

- Rollback is turn-granular, not operation-granular. Multiple writes in one
  turn are rolled back together to the pre-turn state.
- Files added since the snapshot that were not present at snapshot time are
  not removed by `git checkout HEAD -- .`. Full cleanup would require
  `git clean -fd`, which is more destructive and not included.
- The shadow repo accumulates commits across sessions for each project. No
  automatic cleanup is implemented; a future `/checkpoint-gc` command could
  prune it. Current disk usage is negligible for typical agent work.
- The guard's `resetTurn` is called at the REPL layer, meaning one-shot mode
  (`--print`) does not use checkpoints — it receives no `CheckpointGuard` in
  its `AgentDependencies`. This is intentional: one-shot runs are ephemeral
  and have no REPL to issue `/rollback` from.
