# 0034. Fixed home-directory workspace

Date: 2026-07-15

## Status

Accepted

## Context

Railgun previously treated the launch directory as a project identity and added
per-directory trust decisions, CLI trust flags, and project-local extension
discovery. That made startup and desktop integration depend on project selection,
canonicalization, persisted trust state, and restricted versus trusted modes.

The product is intentionally single-user and local. A predictable workspace is
more valuable than project switching, and global resources under `~/.railgun/`
already provide configuration, extensions, skills, memory, notes, and MCP access.

## Decision

- Every CLI and desktop session uses the current user's home directory as its
  working directory. There is no project chooser or working-directory override.
- Per-project trust prompts, persisted trust state, `defaultProjectTrust`,
  `/trust`, `--approve`, and `--no-approve` are not part of the product.
- Extensions and skills are loaded only from `~/.railgun/extensions/` and
  `~/.railgun/skills/`. Project-local resources are not discovered.
- Saved sessions remain global. Resuming a session rebuilds context under the
  current fixed home workspace rather than restoring a former launch directory.
- `import-notes <folder>` preserves normal CLI path semantics: an explicit
  relative folder is resolved against the invocation directory before the
  process changes to the home directory.

## Consequences

- Startup has no project-selection or project-trust gate, and backend restarts
  do not carry project identity or trust state.
- File and shell tools operate from the home directory, so their relative paths
  are home-relative.
- User-authored context files in the home workspace continue to be truncated and
  scanned before prompt injection.
- The removed trust gate and the original project-local portion of the extension
  design remain documented in their superseded ADRs for historical context.
