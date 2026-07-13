# 0005. Add ~/.railgun/SOUL.md persistent identity in Phase 10

Date: 2026-07-09

## Status

Accepted

## Context

Phase 10's literal title is "project-level context files" — discovering and
loading `.railgun.md`/`RAILGUN.md` (walking up to the git root),
`AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, or `.cursorrules` (cwd
only) into the system prompt. Hermes Agent, however, treats
persistent identity (`SOUL.md`, loaded from `HERMES_HOME`) as an inseparable
part of the same context-assembly pass: it is loaded alongside project
context, truncated with the same head/tail logic, scanned with the same
injection patterns, and injected into the same system prompt — just
unconditionally rather than via a precedence-chain search.

The machinery needed for `SOUL.md` — filesystem read, head/tail truncation,
injection scan via `scanForThreats` — is already
being built in Phase 10 for project context files. Adding `SOUL.md` support
is near-zero marginal cost: one additional function (`loadSoulIdentity`),
one constant (`SOUL_PATH`), and one optional field on `SystemPromptInput`.

## Decision

Include `~/.railgun/SOUL.md` persistent identity in Phase 10 rather than
deferring it to a separate phase. `SOUL_PATH` is fixed at
`join(homedir(), ".railgun", "SOUL.md")`, matching the existing fixed-path
pattern used by `TOKEN_PATH` (`~/.railgun/devin-token`) and `CONFIG_PATH`
(`~/.railgun/config.json`) — no config-driven path override, no
`RAILGUN_HOME` environment variable.

`loadSoulIdentity()` reads the file, truncates it, scans the retained
head and tail independently for injection (to avoid false positives from
patterns spanning the truncation seam), and returns the result (or `null`
if the file is missing, unreadable, or
whitespace-only). The result is passed to `buildSystemPrompt` as the
optional `soulIdentity` field, which — when present — produces a
`# Persistent Identity` block placed before the `# Project Context` block
in the system prompt array.

## Consequences

- `~/.railgun/SOUL.md` is new scope beyond Phase 10's literal title;
  this ADR records the expansion rather than silently widening the phase.
- The fixed path has no config override. A later phase that adds
  multi-profile identity or per-project identity overrides would need to
  revisit this fixed path (e.g. introduce a `RAILGUN_HOME` env var or a
  `soul_path` key in `config.json`).
- The same injection scanner and truncation logic is reused for both
  project context and persistent identity, keeping the security posture
  consistent — a `SOUL.md` containing injection patterns is blocked with
  the same `[BLOCKED: ...]` placeholder as a project context file.
- No user-visible feature depends on `SOUL.md` existing; a missing file
  is silently ignored, so the common case (no `SOUL.md` created yet)
  produces no warning or behavioral change.
- **Agent-writable `SOUL.md`**: the system prompt now always emits a `# Persistent Identity` block — either with the loaded content when `SOUL.md` exists, or with a "file does not exist yet" hint and instructions to create it via `write_file`. The tool rules block explicitly tells the agent it can create or update `~/.railgun/SOUL.md` using `write_file` when the user asks it to remember something about itself or its behavior. Changes take effect on the next session (the injection scanner still runs at load time).
- **Dream-driven SOUL.md promotion**: the `railgun dream` subsystem (Phase 28) can promote stable `"preference"` memories into `SOUL.md` automatically. The dream agent receives `write_file` access (via the `"file"` toolset) and the current `SOUL.md` content in its user message so it can append without overwriting. Promoted memories are deleted from the database since they now live in the identity file.
