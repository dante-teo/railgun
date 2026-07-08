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
- Runtime environments: local developer machine (macOS/Linux/Windows), Node.js >= 22 (see `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md`)

## Components

| Component | Responsibility | Owner |
| --- | --- | --- |
| CLI entry (`src/cli.ts`) | Parses argv, dispatches to one-shot or REPL, top-level error handling | Solo project — no formal ownership split |
| Session bootstrap (`src/session.ts`) | Token store setup, login-if-needed, model discovery — shared by both paths | Solo project |
| One-shot path (`src/oneShot.ts`) | Single-question turn loop used by `--print`/`-p`, plus a `readline`-based shell-approval prompt on stderr | Solo project |
| Error classification (`src/errors.ts`) | Maps `DevinAuthError`/`DevinApiError`/`DevinProtocolError` to one-line messages | Solo project |
| Turn logic (`src/agent/turn.ts`) | Runs one chat turn against a `DevinProvider`, looping tool-call rounds via the tool registry (both `"file"` and `"terminal"` toolsets always enabled) for up to 10 steps until a text-only reply; returns new history or an error | Solo project |
| Tool registry (`src/tools/registry.ts`) | `createToolRegistry()` factory closing over a `Map<name, RegisteredTool>`; `getSchemas(toolsets)` filters by toolset + `isAvailable()`, `run(name, args, context)` dispatches to a handler or returns a fixed "unknown tool"/"error running" result — the only unit-tested pure-logic module besides `turn.ts` | Solo project |
| Built-in tools (`src/tools/{readFile,writeFile,listDirectory,runShell}.ts`) | Four self-registering tools: `read_file`/`write_file`/`list_directory` (toolset `"file"`, real disk I/O), `run_shell_command` (toolset `"terminal"`, gated behind `ToolContext.confirmShellCommand` before `execFile("bash", ["-c", command])`) | Solo project |
| Ink REPL (`src/repl/App.tsx`) | Multi-turn chat UI: scrolling transcript (`Static`), streaming reply line, text input, `/exit`, and a `useInput`-driven y/n approval gate for `run_shell_command` | Solo project |

## Data Flow

**One-shot path (`pnpm start --print`/`-p "<question>"`, tool-calling since Phase 4):**

1. `src/cli.ts` detects `--print`/`-p`, takes the remaining argv as the
   question (default `"Hello!"`), and calls `runOneShot`.
2. `runOneShot` calls `initDevinSession` (`src/session.ts`), which checks
   `~/.railgun/devin-token` via `widevin`'s `createFileTokenStore`; if no
   token is cached, `devin.login()` drives an OAuth flow via
   `src/openBrowser.ts`, then the token store persists it; `devin.listModels()`
   fetches available models and the first one is selected.
3. `runOneShot` calls `runTurn` (`src/agent/turn.ts`) with empty prior
   history, the single question as `userText`, and a `confirmShellCommand`
   built from `node:readline/promises`: it opens a `readline` interface on
   `process.stdin`/`process.stderr`, prompts
   `Run shell command: <command>\nType "yes" to run, anything else to cancel: `,
   and resolves `true` only if the answer trimmed/lowercased is exactly
   `"yes"` (closed/EOF stdin resolves immediately to an empty answer, i.e.
   declined; open-but-silent stdin blocks until answered — see
   `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md`'s
   context for why this matters for CI/scripted invocations).
4. `text_delta` events stream to stdout as `runTurn` runs its rounds; on
   success a trailing newline is written after the loop completes.
5. Any error — from `streamChat` itself, or an error `runTurn` returns as
   `{ ok: false, error }` — is re-thrown by `runOneShot` and caught by
   `main()`'s top-level handler in `src/cli.ts`, which prints one line to
   stderr (via `describeDevinError`, falling back to a full dump for
   unclassified errors) with a non-zero exit code.

**REPL path (`pnpm start`, tool calling since Phase 3, tool registry since Phase 4):**

1. `src/cli.ts` (no argv) calls `initDevinSession` once, then `runRepl`
   (`src/repl/App.tsx`) renders the Ink `ChatApp` and blocks on
   `waitUntilExit()`.
2. Each submitted line calls `runTurn` (`src/agent/turn.ts`) with the
   growing `history` array, the session's `DevinProvider`/model, the new
   user text, and a `confirmShellCommand` callback that stores a
   `{ resolve }` pair in a ref and sets `pendingCommand` React state; a
   `useInput` handler (active only while `pendingCommand` is set) resolves
   `true` on `y`, `false` on `n`/`Esc`, and ignores every other key. Internally
   `runTurn` loops `streamChat` calls — passing `registry.getSchemas(["file",
   "terminal"])` (both toolsets always enabled; no per-profile config yet)
   and a fixed system prompt naming the agent "Railgun" (required: Devin's
   Claude-family models reject a request that declares `tools` with an
   empty system prompt) — for up to 10 rounds. Each round's `text_delta`
   events stream into a live "in-flight" line via a callback as they
   arrive; `toolcall_end` events are buffered until that round's stream
   ends, then run in call order via `registry.run(name, args, { confirmShellCommand })`
   (each tool returns `{ content, isError }` — `run_shell_command` first
   awaits `confirmShellCommand`, returning `isError: true` immediately if
   declined, before ever spawning `execFile("bash", ["-c", command])`)
   with each result pushed back as a `tool`-role message before the next
   round starts. A round producing no tool calls ends the loop; the REPL
   shows no distinct UI for tool-call rounds — the same streaming line
   stays at its empty placeholder during a pure tool-call round, except
   when `run_shell_command` is pending approval, when the input box is
   replaced by the `Run shell command: <command> [y/n]` prompt.
3. On success, `runTurn` returns a new `history` array (the turn's one
   user message, plus each round's assistant message and — for rounds
   that called a tool — tool messages, appended in round order) that
   becomes React state for the next turn. `assistantText` concatenates
   every round's streamed text in round order — including narration a
   round streams before calling a tool — so nothing the in-flight line
   showed live is ever missing from the permanent scrollback (`Static`)
   entry it moves into on completion. If the loop exhausts its 10-round
   limit without a text-only round, this still counts as success:
   `assistantText` is instead the literal string
   `"(stopped: too many steps)"` and `history` keeps every round run so
   far.
4. On failure (a streamChat error in any round), runTurn returns
   `{ ok: false, error }` and the *caller's*
   `history` is left untouched (no dangling unanswered user turn is ever
   sent next); the REPL renders one red line via `describeDevinError` and
   keeps running — a per-turn error never exits the process.
5. `history` lives only in the Ink component's React state for the
   process's lifetime; there is no on-disk conversation persistence yet
   (a later phase adds save/resume).
6. `/exit` calls Ink's `exit()`, which resolves `waitUntilExit()` and lets
   `main()` return normally.

`toolcall_end` events drive `src/agent/turn.ts`'s tool-calling loop in
both paths. `thinking_delta`, `toolcall_start`, `toolcall_delta`, and
`usage` are still received but ignored by both paths (live tool-call
feedback and reasoning display are later phases). Both paths now enable
the exact same toolsets (`"file"` + `"terminal"`) — the only behavioral
difference between them is how `confirmShellCommand` collects the y/n
answer (Ink `useInput` vs. blocking `readline` on stdin).

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
  `docs/adr/0002-ink-repl-ahead-of-schedule.md`. Ink is still pinned to 6,
  not 7, even though the Node floor was independently raised to `>=22`
  for `Promise.withResolvers()` — see
  `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md`.

## Security

- The Devin token is stored in a single user-owned file (`~/.railgun/devin-token`,
  mode `0600`), not in an env var or shell history, limiting exposure to
  other local users/processes on shared machines.
- Railgun never logs or prints the token itself; only the sign-in URL (which
  is not a secret on its own) is printed during login.
- `run_shell_command` runs whatever command string the model provides via
  `execFile("bash", ["-c", command])` — a real arbitrary-code-execution
  surface, mitigated only by the interactive y/n approval gate
  (`ToolContext.confirmShellCommand`) in front of every invocation, in
  both the REPL and one-shot mode. There is no allowlist/sandboxing; the
  approval prompt is the only safety control.
- Compliance is an operational responsibility, not a code-enforced one — see
  `docs/adr/0001-single-provider-devin-via-widevin.md`.

## Observability

TBD

## Deployment

TBD

## Architectural Decision Records

Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance.
