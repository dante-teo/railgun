# 0013. Per-directory project trust gate

Date: 2026-07-12

## Status

Accepted

## Context

Railgun will load project-local configuration (`.railgun/` settings, extensions, skills) from future
phases (23, 28). Loading these files unconditionally from any directory the user `cd`s into is a
security risk — a malicious repo could place a `.railgun/settings.json` or extension that exfiltrates
data or changes agent behavior. Hermes Agent's architecture includes a per-directory trust gate that
persists decisions so legitimate projects are not re-prompted on every run.

## Decision

- Trust decisions are persisted in `~/.railgun/trust.json` (mode `0600`), keyed by canonical absolute
  directory path. The file is created lazily; a missing file means an empty (no decisions) store.
- Ancestor-directory inheritance: the store walk checks the exact path, then `path.dirname`, continuing
  to the filesystem root. Trusting a parent directory implicitly trusts all its descendants.
- Five choices: `trust` (persist current dir), `trust-parent` (persist `dirname(current)`),
  `trust-session` (trusted for this process only), `deny` (persist current dir), `deny-session`
  (denied for this process only).
- Resolution order in `resolveProjectTrust`: `--approve`/`-a` CLI flag → `--no-approve`/`-na` →
  `defaultProjectTrust: "always"` → `defaultProjectTrust: "never"` → persisted store (ancestor walk) →
  interactive prompt.
- `promptTrustChoiceReadline` fires on stderr before the Ink REPL starts, using `node:readline`. This
  avoids conflicts with Ink's stdin ownership.
- The `defaultProjectTrust` field in `~/.railgun/config.json` short-circuits the per-directory prompt:
  `"always"` trusts every project, `"never"` denies every project. Default is `"ask"`.
- CLI flags `--approve`/`-a` and `--no-approve`/`-na` override for a single invocation without reading
  or writing the trust store. Both flags together throw `CliUsageError`. These flags are rejected on
  `login`, `logout`, `config`, and `--list-sessions` modes.
- The `/trust` REPL command opens a numbered in-REPL picker (keys `1`–`5`, Escape cancels) using Ink's
  `useInput` hook. It updates the in-session `TrustDecision` state and calls `trustStore.set` for
  persisted choices.
- `assertProjectTrustedForRead(decision, resourcePath)` and `assertProjectTrustedForInstall(decision)`
  are exported guards in `src/trust.ts`. They are not called in Phase 20 — they exist for Phase 23
  (local config loading) and Phase 28 (local package installation) to consume.
- The trust gate is plumbing-only in Phase 20: the decision is resolved before session initialization
  and threaded through `dispatchCli` → `runRepl`/`runOneShot`, but no resources are actually gated yet.
- `ProjectTrustStore` uses synchronous DI (`readFile`, `writeFile`) with `writeFileSync` + `mkdirSync`
  for the default implementation, consistent with the synchronous SQLite pattern in `sessionStore.ts`.

## Consequences

- Legitimate project directories are prompted once; the decision persists indefinitely.
- No project-local resources are blocked in this phase, but the gate is in place for future phases to
  use by calling the guards.
- `runOneShot` and `runRepl` both receive the trust decision and store; future callers can pass them
  to `assertProjectTrustedForRead` without touching the startup flow.
- The readline prompt on stderr is the same pattern as `confirmShellCommand` in `oneShot.ts`, but
  fires before any Ink rendering begins — no conflict with the alternate-screen buffer.
- `defaultProjectTrust: "always"` is a convenience setting for users who work exclusively in their own
  projects and find the per-directory prompt unnecessary overhead.
