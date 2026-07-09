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
| Session bootstrap (`src/session.ts`) | Token store setup, login-if-needed, model discovery, local-date capture, parallel project-context and persistent-identity loading via `projectContext.ts`, and one-time system-prompt construction — shared by both paths | Solo project |
| System prompt builder (`src/agent/systemPrompt.ts`) | Pure prompt assembly: Railgun identity, tool rules, cached session environment, and two optional context blocks — `soulIdentity` (from `~/.railgun/SOUL.md`) and `projectContext` (from the project's context file); environment values are JSON-serialized as data. Remains synchronous and pure — all I/O happens in `projectContext.ts` before this function is called | Solo project |
| One-shot path (`src/oneShot.ts`) | Single-question turn loop used by `--print`/`-p`, plus a `readline`-based shell-approval prompt on stderr | Solo project |
| Error classification (`src/errors.ts`) | Maps `DevinAuthError`/`DevinApiError`/`DevinProtocolError` to one-line messages | Solo project |
| Iteration budget (`src/agent/iterationBudget.ts`) | Provides the default 90-step `IterationBudget` and the friendly exhaustion message shared by the REPL and one-shot paths | Solo project |
| Turn logic (`src/agent/turn.ts`) | Runs one chat turn against a `DevinProvider`, looping tool-call rounds via the tool registry (both `"file"` and `"terminal"` toolsets always enabled) while an injected `IterationBudget` has remaining steps; each round is wrapped in `callDevinWithRecovery` (retry-with-backoff on transient failures) and dispatches its resolved tool calls through `shouldParallelizeToolBatch`, firing an optional `LoopCallbacks` (`onDelta`/`onToolStart`/`onToolComplete`) around each dispatch; returns new history or an error | Solo project |
| Tool dispatch safety (`src/agent/toolDispatch.ts`) | Pure logic deciding whether a round's tool calls may run concurrently (`shouldParallelizeToolBatch`, `pathsOverlap`) and detecting corrupted tool-call JSON (`safeParseToolArgs`, `CORRUPTION_MARKER`) — no I/O, no registry access | Solo project |
| API failure recovery (`src/agent/recovery.ts`) | Classifies a thrown error into a `RecoveryAction` (`classifyError`) and retries a step up to 3 times with linear backoff only when the classification says to (`callDevinWithRecovery`) | Solo project |
| Tool registry (`src/tools/registry.ts`) | `createToolRegistry()` factory closing over a `Map<name, RegisteredTool>`; `getSchemas(toolsets)` filters by toolset + `isAvailable()`, `get(name)` looks up a registered tool's metadata, `run(name, args, context)` dispatches to a handler or returns a fixed "unknown tool"/"error running" result — the only unit-tested pure-logic module besides `turn.ts` | Solo project |
| Built-in tools (`src/tools/{readFile,writeFile,listDirectory,runShell}.ts`) | Four self-registering tools: `read_file`/`write_file`/`list_directory` (toolset `"file"`, real disk I/O), `run_shell_command` (toolset `"terminal"`, gated behind `ToolContext.confirmShellCommand` before `execFile("bash", ["-c", command])`); each registers a `verb`/`previewArgKey` pair consumed by `buildToolLabel` for its live-activity label | Solo project |
| Tool activity labels (`src/tools/toolLabel.ts`) | Pure `buildToolLabel(name, args, phase)` — turns a dispatched call's name+args into a one-line verb-based label (`"Reading <path>"`, `"Running <command>"`) via each tool's registered `verb`/`previewArgKey`, falling back to raw name+JSON for unlabeled/unregistered tools and the `"__batch__"` sentinel for a collapsed concurrent batch; whitespace-collapsed and truncated to 60 chars | Solo project |
| Skin system (`src/skins.ts`) | Pure skin data: `SkinConfig` interface, two built-in skins (`default`, `mono`) covering banner colors, prompt symbol, `ink-spinner` type, and branding strings; `resolveSkin(name)` is a pure lookup returning `undefined` for an unrecognized name | Solo project |
| Config persistence (`src/config.ts`) | `loadConfig`/`saveConfig` read/write `~/.railgun/config.json` (skin preference only, `{ "skin": "<name>" }`); a missing file, unreadable file, malformed JSON, or an unrecognized skin name all collapse silently to the default skin, with no startup warning | Solo project |
| Command system (`src/commands.ts`) | Pure slash-command logic: `KNOWN_COMMANDS`, prefix matching (`matchCommand`/`findMatches`), `parseSlashCommand` (splits `"/skin mono"` into command + arg), and `nextCompletionState` (the tab/escape state machine cycling frozen matches vs. re-deriving live matches) — no I/O, no React | Solo project |
| Banner (`src/repl/Banner.tsx`) | `printBanner(skin)` — a one-shot, raw-ANSI-colored startup banner (hex-to-24-bit-ANSI conversion, no `chalk` dependency) written via `console.log` before Ink's `render()` is ever called; lives outside the Ink component tree entirely, so it is printed exactly once per launch and never re-renders | Solo project |
| Suggestions (`src/repl/Suggestions.tsx`) | Pure Ink component rendering a vertical dropdown of slash-command matches beneath the input box, highlighting whichever entry the current tab-cycle has selected | Solo project |
| Ink REPL (`src/repl/App.tsx`) | Multi-turn chat UI: scrolling transcript (`Static`), streaming reply line, text input, slash commands (`/exit`, `/skin <name>`, `/help`, `/clear`), tab-completion with a live `Suggestions` dropdown, a `useInput`-driven y/n approval gate for `run_shell_command`, and a skin-driven prompt symbol + `ink-spinner` type (`activeSkin.colors.promptSymbol`/`activeSkin.spinnerType`) alongside the permanent `✓`/`✗` scrollback line for tool activity | Solo project |
| One-shot terminal spinner (`src/spinner.ts`) | `startSpinner(label)` writes a cycling braille frame to `process.stderr` on an interval and returns a `stop(isError)` closure that clears it and writes a final `✓`/`✗` line — the one-shot path's stderr-only equivalent of the REPL's `ink-spinner` line | Solo project |
| Threat pattern scanner (`src/security/threatPatterns.ts`) | Pure, id-tagged regex list (`CONTEXT_THREAT_PATTERNS`, 10 curated patterns covering prompt injection, role hijack, HTML hidden-element injection, system-prompt leak, and safety-bypass phrasing) plus `scanForThreats(content)` returning matched pattern ids; no I/O, bounded filler `(?:\w+\s+){0,8}` prevents catastrophic backtracking | Solo project |
| Project context loader (`src/agent/projectContext.ts`) | Discovers and loads a project's context file (`.railgun.md`/`RAILGUN.md` walking to the git root, falling back to `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, `.cursorrules` in cwd only — first readable non-empty file wins, with case-variant aliases exhausted per directory before walking up or moving to the next candidate group), plus `~/.railgun/SOUL.md` as persistent identity; truncates with a 70/30 head/tail split at 20 000 chars, then scans the retained head and tail independently for injection via `scanForThreats` (blocked files produce a `[BLOCKED: ...]` placeholder that does not fall through to the next candidate); exports `loadProjectContext(cwd)` and `loadSoulIdentity()` | Solo project |

## Data Flow

**One-shot path (`pnpm start --print`/`-p "<question>"`, tool-calling since Phase 4, iteration-budgeted since Phase 6, live tool spinner since Phase 7):**

1. `src/cli.ts` detects `--print`/`-p`, takes the remaining argv as the
   question (default `"Hello!"`), and calls `runOneShot`.
2. `runOneShot` calls `initDevinSession` (`src/session.ts`), which checks
   `~/.railgun/devin-token` via `widevin`'s `createFileTokenStore`; if no
   token is cached, `devin.login()` drives an OAuth flow via
   `src/openBrowser.ts`, then the token store persists it; `devin.listModels()`
   fetches available models and the first one is selected. Session
   bootstrap then loads project context and persistent identity in parallel
   via `loadProjectContext(cwd)` and `loadSoulIdentity()`
   (`src/agent/projectContext.ts`): `loadProjectContext` searches for
   `.railgun.md`/`RAILGUN.md` (walking up to the git root),
   `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, or `.cursorrules` (cwd only), first found wins;
   `loadSoulIdentity` reads `~/.railgun/SOUL.md`. Both loaders truncate
   raw content to 20 000 chars (70/30 head/tail split) if needed, then
   scan the retained head and tail independently for injection patterns
   by `scanForThreats` (`src/security/threatPatterns.ts`) — a match
   replaces the content with a `[BLOCKED: ...]` placeholder and logs to
   stderr. For project context, a whitespace-only or unreadable alias
   falls through to the next case-variant alias in the same candidate
   group before moving to the next group, returning `null` only when all
   candidates are exhausted; for SOUL identity, a missing or
   whitespace-only file returns `null` directly. The
   results are passed to
   `buildSystemPrompt` (`src/agent/systemPrompt.ts`), which assembles the
   cached system prompt: Railgun's general-assistant identity, tool-use
   rules, cwd/platform/date/model/provider environment, and — when
   present — a `# Persistent Identity` block and a `# Project Context`
   block. The date is captured from local calendar fields rather
   than UTC serialization, and every environment value is JSON-serialized
   before insertion into the prompt so paths or model ids containing
   control characters cannot create extra system-prompt instructions.
3. `runOneShot` creates a fresh default `IterationBudget` and calls
   `runTurn` (`src/agent/turn.ts`) with empty prior history, the single
   question as `userText`, and a `confirmShellCommand` built from
   `node:readline/promises`: it opens a `readline` interface on
   `process.stdin`/`process.stderr`, prompts
   `Run shell command: <command>\nType "yes" to run, anything else to cancel: `,
   and resolves `true` only if the answer trimmed/lowercased is exactly
   `"yes"` (closed/EOF stdin resolves immediately to an empty answer, i.e.
   declined; open-but-silent stdin blocks until answered — see
   `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md`'s
   context for why this matters for CI/scripted invocations).
4. `text_delta` events stream to stdout as `runTurn` runs its rounds. Each
   round's dispatched tool call(s) also fire `LoopCallbacks.onToolStart`/
   `onToolComplete` (see step 2 of the REPL path below for the shared
   dispatch semantics); `runOneShot` wires these to `src/spinner.ts`'s
   `startSpinner`/`stop`, which write a cycling braille frame and a final
   `✓`/`✗ <label>` line to `process.stderr` only — stdout carries nothing
   but the streamed answer, so the spinner never corrupts a piped
   `pnpm start --print "..." | some-other-tool` invocation. On success a
   trailing newline is written to stdout after the loop completes. Budget
   exhaustion is returned as success, with the iteration-limit message as
   the answer text.
5. Any error — from `streamChat` itself, or an error `runTurn` returns as
   `{ ok: false, error }` — is re-thrown by `runOneShot` and caught by
   `main()`'s top-level handler in `src/cli.ts`, which prints one line to
   stderr (via `describeDevinError`, falling back to a full dump for
   unclassified errors) with a non-zero exit code.

**REPL path (`pnpm start`, tool calling since Phase 3, tool registry since Phase 4, hardened loop since Phase 5, iteration-budgeted since Phase 6, live tool feedback since Phase 7):**

1. `src/cli.ts` (no argv) calls `initDevinSession` once (which now also
   loads project context and persistent identity in parallel — see the
   one-shot path step 2 above for the full `loadProjectContext`/
   `loadSoulIdentity` discovery, injection scan, and truncation
   semantics), then `runRepl` (`src/repl/App.tsx`) loads the persisted
   skin preference via `loadConfig` (`src/config.ts`), resolves it to a
   `SkinConfig` via `resolveSkin` (`src/skins.ts`, falling back to the
   default skin for a missing/invalid config), prints the startup banner
   via `printBanner` (`src/repl/Banner.tsx`) straight to stdout — before
   Ink's `render()` is ever called — then renders the Ink `ChatApp` and
   blocks on `waitUntilExit()`.
2. `ChatApp` receives the cached system prompt from `initDevinSession`
   and the resolved skin as its `initialSkin` prop, seeding the
   `activeSkin` React state that `/skin` can later update live.
   It also creates one default `IterationBudget` in a React ref, shared
   by every turn for the REPL process lifetime. Each submitted line calls
   `runTurn` (`src/agent/turn.ts`) with the growing `history` array, the
   session's `DevinProvider`/model/system prompt, the new user text, that
   shared budget, and a `confirmShellCommand` callback that stores a
   `{ resolve }` pair in a ref and sets `pendingCommand` React state; a
   `useInput` handler
   (active only while `pendingCommand` is set) resolves that approval
   promise. `runTurn` loops one `streamChat` round per consumed budget
   step, each wrapped in `callDevinWithRecovery`
   (`src/agent/recovery.ts`): a round that throws a transient error
   (429/502/503, or an error type `classifyError` doesn't recognize) is
   retried up to 3 times total with linear backoff (500ms × attempt
   number) before the turn gives up; a malformed-request error (400/413)
   or `DevinAuthError` fails the turn immediately on first throw, with no
   retry. Within a round, `text_delta` events stream into a live
   "in-flight" line via a callback as they arrive; `toolcall_delta` events
   are buffered per tool-call id into a raw
   JSON string (widevin's own incrementally-parsed `.arguments` is not
   trusted, since it silently returns `{}` on a parse failure instead of
   surfacing one), and at that round's `toolcall_end` the buffered string is
   parsed via `safeParseToolArgs` (`src/agent/toolDispatch.ts`) — a call
   whose buffer never parses gets a labeled corruption message
   (`CORRUPTION_MARKER`) pushed as its tool result and is never dispatched
   to `registry.run`. Every other (valid) call in the round is dispatched
   either concurrently via `Promise.all` or one at a time in a `for` loop,
   chosen by `shouldParallelizeToolBatch`: concurrent only when every call
   is either on an explicit read-only allow-list (currently just
   `read_file`) or is a path-scoped call (`read_file`/`write_file`) whose
   target path doesn't overlap any other call's target in the same round,
   and never when any call is on the "never parallel" list (currently just
   the not-yet-built `clarify`, pre-declared for Phase 16). Each dispatched
   call's result — or a corrupted call's marker — is pushed back as a
   `tool`-role message via `registry.run(name, args, { confirmShellCommand })`
   (each tool returns `{ content, isError }` — `run_shell_command` first
   awaits `confirmShellCommand`, returning `isError: true` immediately if
   declined, before ever spawning `execFile("bash", ["-c", command])`)
   before the next round starts. `LoopCallbacks.onToolStart`/
   `onToolComplete` fire around this dispatch (once per call in the
   sequential `for` loop; once for the whole batch under the `"__batch__"`
   sentinel, with `isError` hardcoded `false` regardless of any individual
   call's result); `ChatApp` wires these to `src/tools/toolLabel.ts`'s
   `buildToolLabel` to drive an `ink-spinner` line in place of the busy
   placeholder while a call is in flight, then appends a permanent
   `✓`/`✗`-prefixed line to the scrollback (`Static`) once it settles. A
   round producing no tool calls ends the loop, except when
   `run_shell_command` is pending approval, when the input box is
   replaced by the `Run shell command: <command> [y/n]` prompt.
3. On success, `runTurn` returns a new `history` array (the turn's one
   user message, plus each round's assistant message and — for rounds
   that called a tool — tool messages, appended in round order) that
   becomes React state for the next turn. `assistantText` concatenates
   every round's streamed text in round order — including narration a
   round streams before calling a tool — so nothing the in-flight line
   showed live is ever missing from the permanent scrollback (`Static`)
   entry it moves into on completion. If the injected budget is exhausted
   before a text-only round, this still counts as success: `assistantText`
   is the friendly iteration-limit message and `history` keeps every round
   run so far, followed by a synthetic assistant message containing the
   same limit text.
4. On failure (a streamChat error in any round), runTurn returns
   `{ ok: false, error }` and the *caller's*
   `history` is left untouched (no dangling unanswered user turn is ever
   sent next); the REPL renders one red line via `describeDevinError` and
   keeps running — a per-turn error never exits the process.
5. `history` lives only in the Ink component's React state for the
   process's lifetime; there is no on-disk conversation persistence yet
   (a later phase adds save/resume).
6. Slash commands are dispatched by `handleSubmit` via `parseSlashCommand`
   (`src/commands.ts`) before any turn is run: `/exit` calls Ink's
   `exit()`, which resolves `waitUntilExit()` and lets `main()` return
   normally; `/skin <name>` resolves the name via `resolveSkin`
   (`src/skins.ts`) — on success it updates `activeSkin` React state
   (changing the prompt symbol, spinner type, and banner colors live on
   the next render) and fire-and-forgets `saveConfig` (`src/config.ts`)
   to persist the choice to `~/.railgun/config.json`, or on an
   unknown/missing name pushes a red `Unknown skin: …` scrollback line
   instead; `/help` pushes one scrollback line listing all four
   commands; `/clear` writes the terminal-clear escape sequence
   (`\x1Bc`) via Ink's `useStdout().write` (never raw
   `process.stdout.write`, which would corrupt Ink's internal
   render-diff state) without touching the `lines` array — Ink's
   `<Static>` uses a monotonically-advancing index, so shrinking the
   array would silently break subsequent scrollback rendering.

`toolcall_delta` and `toolcall_end` events together drive
`src/agent/turn.ts`'s tool-calling loop in both paths (Phase 5 added
`toolcall_delta` buffering; before that it was ignored). `thinking_delta`,
`toolcall_start`, and `usage` are still received but ignored by both paths
(reasoning display is a later phase; live tool-call feedback shipped in
Phase 7 via `LoopCallbacks` rather than a new stream-event type). Both
paths now enable the exact same toolsets (`"file"` + `"terminal"`) — the
only behavioral difference between them is how `confirmShellCommand`
collects the y/n answer (Ink `useInput` vs. blocking `readline` on stdin)
and how tool activity renders (an `ink-spinner` line + scrollback vs. a
stderr braille spinner via `src/spinner.ts`). They also differ in budget
lifetime: the REPL has one shared 90-step budget for the process
lifetime, while each one-shot invocation gets a fresh 90-step budget.

## Persistence

A single file, `~/.railgun/devin-token` (mode `0600`), holds the cached
Devin auth token — created and managed entirely by `widevin`'s
`createFileTokenStore`. A second file, `~/.railgun/config.json` (no file
mode restriction — it holds no secret, just `{ "skin": "<name>" }`), is
read on REPL startup by `src/config.ts`'s `loadConfig` and written by its
`saveConfig` whenever `/skin <name>` succeeds; a missing, unreadable,
malformed, or unrecognized-skin config silently falls back to the default
skin. A third optional file, `~/.railgun/SOUL.md` (no file-mode
restriction — user-authored text, not a secret), is read once at session
startup by `loadSoulIdentity` (`src/agent/projectContext.ts`) and its
content injected as a `# Persistent Identity` block in the system prompt;
a missing or whitespace-only file is silently ignored. Railgun keeps no
other on-disk state: REPL `history` is in-memory-only for the process's
lifetime, with no conversation persistence across restarts yet (a later
phase adds save/resume).

## Integrations

- Devin, via the `widevin` npm package (OAuth login, model discovery, streaming chat). See
  `docs/adr/0001-single-provider-devin-via-widevin.md`.
- Ink (`^6.8.0`) + React (`^19.2.0`) + `ink-text-input` (`^6.0.0`) +
  `ink-spinner` (`^5.0.0`) for the REPL's terminal UI, pulled forward from
  the replication plan's later "polished terminal UI" phase. See
  `docs/adr/0002-ink-repl-ahead-of-schedule.md`. Ink is still pinned to 6,
  not 7, even though the Node floor was independently raised to `>=22`
  for `Promise.withResolvers()` — see
  `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md`.
  `ink-spinner`'s published peer deps (`ink >=4.0.0`, `react >=18.0.0`)
  are satisfied by both pins with no override needed.

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
- Project context files (`.railgun.md`/`RAILGUN.md`, `AGENTS.md`/`agents.md`,
  `CLAUDE.md`/`claude.md`, `.cursorrules`) and `~/.railgun/SOUL.md` are untrusted user-authored
  content injected into the system prompt. Before inclusion, each file is
  truncated to a 20 000-char head/tail window, then the retained head and
  tail are scanned independently for injection patterns by `scanForThreats`
  (`src/security/threatPatterns.ts`) — a heuristic, defense-in-depth control
  covering 10 curated patterns (prompt injection, role hijack, system-prompt
  leak, etc.). Scanning head and tail separately prevents false positives
  from regex patterns bridging the truncation seam, and truncating before
  scanning ensures no unscanned content reaches the prompt. A match replaces
  the entire file with a `[BLOCKED: ...]` placeholder; blocked files do not
  fall through to lower-precedence candidates, preventing precedence probing.
- Compliance is an operational responsibility, not a code-enforced one — see
  `docs/adr/0001-single-provider-devin-via-widevin.md`.

## Observability

TBD

## Deployment

TBD

## Architectural Decision Records

Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance.
