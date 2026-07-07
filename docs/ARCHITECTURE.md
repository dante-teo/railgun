# Architecture

## Overview

This document records the intended system architecture for Railgun. Keep it current as major components, deployment boundaries, and integration points are introduced.

## Principles

- Prefer simple, composable modules with explicit boundaries.
- Keep side effects at system edges.
- Capture significant technical decisions as ADRs in `docs/adr/`.
- Favor well-maintained open source dependencies when they materially reduce implementation risk.

## System Context

- Users: the project's own author, via a local terminal
- External systems: Devin/Cascade (via `widevin`'s OAuth + HTTP/streaming API)
- Runtime environments: local developer machine (macOS/Linux/Windows), Node.js >= 20

## Components

| Component | Responsibility | Owner |
| --- | --- | --- |
| CLI entry (`src/cli.ts`) | Parses argv, dispatches to one-shot or REPL, top-level error handling | Solo project — no formal ownership split |
| Session bootstrap (`src/session.ts`) | Token store setup, login-if-needed, model discovery — shared by both paths | Solo project |
| One-shot path (`src/oneShot.ts`) | Phase 1's exact single-question streaming behavior, used by `--print`/`-p` | Solo project |
| Error classification (`src/errors.ts`) | Maps `DevinAuthError`/`DevinApiError`/`DevinProtocolError` to one-line messages | Solo project |
| Turn logic (`src/agent/turn.ts`) | Pure function: runs one chat turn against a `DevinProvider`, returns new history or an error — the only unit-tested module | Solo project |
| Ink REPL (`src/repl/App.tsx`) | Multi-turn chat UI: scrolling transcript (`Static`), streaming reply line, text input, `/exit` | Solo project |

## Data Flow

**One-shot path (`pnpm start --print`/`-p "<question>"`, unchanged from Phase 1):**

1. `src/cli.ts` detects `--print`/`-p`, takes the remaining argv as the
   question (default `"Hello!"`), and calls `runOneShot`.
2. `runOneShot` calls `initDevinSession` (`src/session.ts`), which checks
   `~/.railgun/devin-token` via `widevin`'s `createFileTokenStore`; if no
   token is cached, `devin.login()` drives an OAuth flow via
   `src/openBrowser.ts`, then the token store persists it; `devin.listModels()`
   fetches available models and the first one is selected.
3. `devin.streamChat(...)` opens a streaming request with the single
   question as the only message; `text_delta` events are written to stdout
   as they arrive, and a trailing newline is written on `done`.
4. Any error short-circuits the flow and prints one line to stderr (via
   `describeDevinError`, falling back to a full dump for unclassified
   errors) with a non-zero exit code.

**REPL path (`pnpm start`, new in Phase 2):**

1. `src/cli.ts` (no argv) calls `initDevinSession` once, then `runRepl`
   (`src/repl/App.tsx`) renders the Ink `ChatApp` and blocks on
   `waitUntilExit()`.
2. Each submitted line calls `runTurn` (`src/agent/turn.ts`) with the
   growing `history` array, the session's `DevinProvider`/model, and the new
   user text; `text_delta` events stream into a live "in-flight" line via a
   callback while the request is outstanding.
3. On success, `runTurn` returns a new `history` array (user + assistant
   messages appended) that becomes React state for the next turn; the
   finished reply moves into the permanent scrollback (`Static`).
4. On failure, `runTurn` returns `{ ok: false, error }` and the *caller's*
   `history` is left untouched (no dangling unanswered user turn is ever
   sent next); the REPL renders one red line via `describeDevinError` and
   keeps running — a per-turn error never exits the process.
5. `history` lives only in the Ink component's React state for the
   process's lifetime; there is no on-disk conversation persistence yet
   (a later phase adds save/resume).
6. `/exit` calls Ink's `exit()`, which resolves `waitUntilExit()` and lets
   `main()` return normally.

All other Devin stream event types (`thinking_delta`, `toolcall_*`, `usage`)
are received but ignored by both paths until tool calling is implemented in
a later phase.

## Persistence

A single file, `~/.railgun/devin-token` (mode `0600`), holds the cached
Devin auth token — created and managed entirely by `widevin`'s
`createFileTokenStore`. Railgun keeps no other on-disk state: REPL
`history` is in-memory-only for the process's lifetime, with no
conversation persistence across restarts yet (a later phase adds
save/resume).

## Integrations

- Devin, via the `widevin` npm package (OAuth login, model discovery, streaming chat). See
  `docs/adr/0001-single-provider-devin-via-widevin.md`.
- Ink (`^6.8.0`) + React (`^19.2.0`) + `ink-text-input` (`^6.0.0`) for the
  REPL's terminal UI, pulled forward from the replication plan's later
  "polished terminal UI" phase. See
  `docs/adr/0002-ink-repl-ahead-of-schedule.md`.

## Security

- The Devin token is stored in a single user-owned file (`~/.railgun/devin-token`,
  mode `0600`), not in an env var or shell history, limiting exposure to
  other local users/processes on shared machines.
- Railgun never logs or prints the token itself; only the sign-in URL (which
  is not a secret on its own) is printed during login.
- Compliance is an operational responsibility, not a code-enforced one — see
  `docs/adr/0001-single-provider-devin-via-widevin.md`.

## Observability

TBD

## Deployment

TBD

## Architectural Decision Records

Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance.
