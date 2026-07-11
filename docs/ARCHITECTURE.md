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
| CLI entry (`src/cli.ts`) | Pure argv parsing plus injectable dispatch for `config`, `login`, `logout`, `cron`, fresh REPL, exact/interactive resume, session listing, and stateless one-shot mode; config/auth/cron commands return before SQLite/session/TUI boundaries | Solo project — no formal ownership split |
| Paths/configuration (`src/paths.ts`, `src/config.ts`) | Derives config, token, state, SOUL, trust, extension, and cron paths from one fixed Railgun home (`~/.railgun`); recursively merges defaults with user JSON, validates recognized fields (`model`, `defaultProjectTrust`), preserves unknown fields, and atomically persists model replacements | Solo project |
| Authentication boundary (`src/auth.ts`) | Selects trimmed process-local `DEVIN_TOKEN` or the file cache, wraps model discovery and async streaming with source-aware 401 invalidation, and implements fresh-login verification plus idempotent cached logout without exposing token contents | Solo project |
| Session bootstrap (`src/session.ts`) | Acquires the authenticated provider, keeps resumes on an exact saved model, applies configuration to fresh sessions, coordinates interactive missing-model recovery before session construction, loads context/identity, and builds the system prompt once; exports `buildSessionCore` for silent mid-REPL session rebuilds during `/model` switches | Solo project |
| Session store (`src/persistence/sessionStore.ts`) | Functional factory around synchronous SQLite: versioned schema setup, strict message/todo codecs, fail-closed transcript validation, newest-first summaries, and atomic idempotent full-snapshot checkpoints | Solo project |
| System prompt builder (`src/agent/systemPrompt.ts`) | Pure prompt assembly: Railgun identity, tool rules, cached session environment, and two optional context blocks — `soulIdentity` (from `~/.railgun/SOUL.md`) and `projectContext` (from the project's context file); environment values are JSON-serialized as data. Remains synchronous and pure — all I/O happens in `projectContext.ts` before this function is called | Solo project |
| One-shot path (`src/oneShot.ts`) | Single-question turn loop used by `--print`/`-p`, plus `readline`-based shell-approval and clarify prompts on stderr | Solo project |
| Error presentation (`src/errors.ts`) | Maps widevin and source-aware credential errors to one-line messages while preserving API/protocol formatting and reporting cache-removal failures alongside the original 401 | Solo project |
| Iteration budget (`src/agent/iterationBudget.ts`) | Provides the default 90-step `IterationBudget` and the friendly exhaustion message shared by the REPL and one-shot paths | Solo project |
| Agent lifecycle (`src/agent/{agent,queue}.ts`) | Functional `createAgent` owner for one run-scoped `AbortController`, concurrent-run/idle-queue guards, FIFO boundary steering, settle-time follow-ups, queue cleanup, readonly `run`/`abort`/`steer`/`followUp`/`isRunning` operations, and a `subscribe` fan-out that processes each raw `AgentEvent` through every registered listener, catching and logging per-listener failures | Solo project |
| Turn logic (`src/agent/turn.ts`) | Runs one chat turn against a `DevinProvider`, looping tool-call rounds via the tool registry (`"file"`, `"terminal"`, `"planning"`, `"clarify"`, and `"extension"` toolsets always enabled) while an injected `IterationBudget` has remaining steps; each round is wrapped in `callDevinWithRecovery` and dispatches resolved tools sequentially or in parallel; wraps each tool dispatch with `ExtensionRunner.emitToolCall`/`emitToolResult` when an extension runner is provided (fail-closed per call on `tool_call` throws; observer-isolated for `tool_result`); emits a typed `AgentEvent` stream through an `emit` sink; propagates the run signal through provider, compaction, approval, and tool boundaries; injects one queued steer per completed boundary and all follow-ups only before settlement; preserves a protocol-valid transcript and explicit aborted outcome on cancellation; captures usage for 90%-window compaction and injects active todo state | Solo project |
| Event vocabulary (`src/agent/events.ts`) | Shared `AgentEvent` union (`agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`tool_execution_end`, `compaction_start`/`compaction_end`) and the `ToolResult` shape (`toolCallId`, `content`, `isError`) both `turn.ts` and `agentSession.ts` depend on; no I/O | Solo project |
| Session wrapper (`src/agent/agentSession.ts`) | `createAgentSession` wraps `createAgent`, re-emitting the raw `AgentEvent` stream plus session-only `AgentSessionEvent` additions — `agent_settled` (fires exactly once per completed `run()` call regardless of outcome) and `queue_update` (a session-local mirror of the steering/follow-up queues, updated on enqueue and on the injected message's `message_start` dequeue) — to independent `subscribe`d listeners | Solo project |
| Tool dispatch safety (`src/agent/toolDispatch.ts`) | Pure logic deciding whether a round's tool calls may run concurrently (`shouldParallelizeToolBatch`, `pathsOverlap`) and detecting corrupted tool-call JSON (`safeParseToolArgs`, `CORRUPTION_MARKER`) — no I/O, no registry access | Solo project |
| API failure recovery (`src/agent/recovery.ts`) | Treats credential rejection/401 as reauthentication, retries HTTP 408/429/5xx and fetch-style transport failures up to 3 attempts with 500ms/1000ms delays, classifies HTTP 413 as `compress_and_retry` (awaits an optional `compress` callback and retries without incrementing the backoff attempt counter, itself capped at 3 compression attempts), and fails other client/protocol/unrelated errors immediately | Solo project |
| Context compaction (`src/agent/compaction.ts`) | Ports Codex's (`openai/codex`) history-summarization algorithm: `runCompaction` sends the conversation plus a fixed summarization prompt to Devin (no tools), retrying with the oldest message dropped on a 413 until one request message remains; `selectRecentUserTexts`/`truncateMiddleTokens` keep a token-budgeted (20 000-token), newest-first selection of prior user turns, truncating the oldest kept message's middle with a `"…N tokens truncated…"` marker rather than dropping it outright; `buildCompactedMessage` merges the selected texts and the model's handoff summary into a single `role: "user"` message (Railgun's stricter `sessionStore.ts` transcript alternation forbids Codex's multi-message replacement shape — see `docs/adr/0010-...md`); `shouldCompact` triggers at 90% of the model's context window | Solo project |
| Tool registry (`src/tools/registry.ts`) | `createToolRegistry()` factory closing over a `Map<name, RegisteredTool>`; `ToolContext` carries the run-scoped `signal`, required `commandApprovalMode` and `sessionApprovals` fields for the risk gate, optional `devin`/`reviewerModel` for smart-approval LLM calls, and optional `clarifyCallback` (`ClarifyCallback`); `run` refuses already-aborted work, dispatches handlers, and converts unknown names or thrown failures into error results | Solo project |
| Extension types (`src/extensions/types.ts`) | Shared typed contracts: discriminated `ExtensionEvent` union (`tool_call`, `tool_result`, `session_start`, `session_shutdown`, `input`), per-event conditional handler return types, `ExtensionAPI` (the surface extension factories receive), `ExtensionRegisteredTool`, `ExtensionContext`, and `ExtensionFactory`; no I/O | Solo project |
| Extension runner (`src/extensions/runner.ts`) | `createExtensionRunner()` dispatches lifecycle events: fail-closed `emitToolCall` (throws propagate to the call-site error boundary; first `block:true` return short-circuits remaining handlers), error-isolated `emitToolResult` (per-handler try/catch; later-wins override accumulation for content/isError), error-isolated `emitInput` (`"transform"` rewrites text/images for subsequent handlers; `"handled"` skips the agent entirely), and observer `emitSessionStart`/`emitSessionShutdown` (per-handler try/catch; errors reported, not propagated) | Solo project |
| Extension loader (`src/extensions/loader.ts`) | `loadExtensions(runner, options)` scans project-local `.railgun/extensions/` (when `trusted`) then `~/.railgun/extensions/`, importing `.ts`/`.js` files and subdirectories with `index.ts`/`index.js` via `import(pathToFileURL(...))` — dynamic import is required because module paths are runtime-discovered; per-module errors are isolated and do not stop loading; `registerExtensionTools(runner, registry, sessionId)` inserts loaded tool definitions into the core registry under `toolset: "extension"` | Solo project |
| Built-in tools (`src/tools/{readFile,writeFile,listDirectory,runShell,todo,clarify}.ts`) | Six self-registering tools: file I/O, caller-owned todo planning, `run_shell_command`, and `clarify`; shell execution is routed through `checkCommandApproval` first — hardline-blocked commands return immediately as errors, safe commands execute directly, and dangerous commands go through configurable approval (manual y/n prompt, LLM smart review, or off); approved dangerous patterns are added to the per-session `sessionApprovals` set so the same class does not re-prompt within one conversation; the shell child is detached into a POSIX process group, sent `SIGTERM` on abort, then `SIGKILL` after a two-second grace period; `clarify` routes a question (with optional up-to-4 choices) to the injected `ClarifyCallback` and returns `{ question, answer }` JSON | Solo project |
| Todo store (`src/tools/todo.ts`) | Pure normalization/reducer logic plus a tiny stateful `createTodoStore()` boundary. Todos are flat, ordered by priority, globally deduplicated by id (last-occurrence-wins), bounded to 256 total items, truncate content above 4000 chars, normalize bad status to `pending`, coerce malformed items to placeholders, support partial-field merge-by-id, and expose `formatForInjection()` for pending/in-progress work only | Solo project |
| Tool activity labels (`src/tools/toolLabel.ts`) | Pure `buildToolLabel(name, args)` — turns a dispatched call's name+args into a one-line verb-based label (`"Reading <path>"`, `"Running <command>"`) via each tool's registered `verb`/`previewArgKey`, falling back to raw name+JSON for unlabeled/unregistered tools; whitespace-collapsed and truncated to 60 chars | Solo project |
| Checkpoint manager (`src/checkpoint.ts`) | Shadow-git checkpoint system: `shadowGitDir` derives a per-project path under `~/.railgun/checkpoints/<cwd-hash>/`, `ensureShadowRepo` idempotently initializes a non-bare git repo there, `snapshot` stages and commits the full working tree before the first file-mutating tool call each turn, `rollback` restores it via `git checkout HEAD -- .`; `createCheckpointGuard` wraps these into a per-turn guard (`beforeMutation` snapshots once then no-ops; `resetTurn` re-arms) threaded through `ToolContext` → `RunTurnOptions` → `AgentDependencies` | Solo project |
| Theme system (`src/repl/theme.ts`) | Immutable exact mint-light/mint-dark semantic palettes plus a `ThemeController` around `os-theme`; terminal-over-OS resolution, live terminal events, OS-event terminal re-query, deduplication, failure fallback, and resource cleanup | Solo project |
| Viewport/composer/lifecycle (`src/repl/{viewport,composer,lifecycle,mouse,terminalSize}.ts`) | Pure viewport and composer actions, SGR mouse parsing, shared resize observation, and guaranteed alternate-screen/mouse-mode boundaries; resize preserves prior bottom-follow state and unseen cues reserve a rendered row | Solo project |
| Streaming transcript (`src/repl/streamingTranscript.ts`) | Pure segment state that accumulates deltas, flushes narration before tools and queued-user injection, and returns only the uncommitted final/aborted assistant suffix | Solo project |
  | Command system (`src/commands.ts`) | Pure `/exit`, `/help`, `/clear`, `/model`, `/compact`, `/rollback`, and `/trust` matching, parsing, and tab/escape completion state; no I/O or React | Solo project |
  | Trust gate (`src/trust.ts`) | `TrustChoice`/`TrustDecision`/`ProjectTrustStore` types; `createProjectTrustStore` (ancestor-walk resolution, sync DI for path/readFile/writeFile, persists to `TRUST_PATH` via `writeFileSync` with mode `0600`); `resolveProjectTrust` (resolution order: CLI flags → config default → persisted store → interactive prompt); `promptTrustChoiceReadline` (five-choice readline prompt on stderr, fires before Ink starts); `assertProjectTrustedForRead`/`assertProjectTrustedForInstall` guards (not yet called — reserved for Phases 23/28) | Solo project |
  6. `/exit`, `/help`, `/clear`, `/model`, `/compact`, `/rollback`, and `/trust` are handled before agent dispatch. `/exit` resolves Ink, `/help` appends the current command list, `/clear` clears the canvas without discarding authoritative conversation state, `/compact` runs `runCompaction` directly (bypassing `runTurn`/`callDevinWithRecovery`), replaces `history` with the single compacted message plus a synthetic assistant acknowledgement, and attempts a checkpoint save. `/rollback` calls `rollback(shadowGitDir(cwd), cwd)` from `src/checkpoint.ts` to restore the working tree to the last shadow-git commit. The `/trust` command opens a five-key picker (keys `1`–`5`, Escape to cancel) within the running Ink REPL; on a valid choice it calls `trustStore.set(cwd, choice)`, updates the in-session `TrustDecision` state, and appends a confirmation line to the transcript.
| Markdown (`src/repl/markdown.ts`) | `markdansi` adapter for wrapped GFM replies, links, tables, lists, and mint-themed fenced code boxes; called only for completed assistant text | Solo project |
| Suggestions (`src/repl/Suggestions.tsx`) | Pure themed Ink component rendering slash-command matches and selection | Solo project |
| Session chooser (`src/repl/SessionChooser.tsx`) | Full-screen, live-themed, resize-aware startup selector for bare `--resume`/`-r`; shared synchronous input state preserves rapid navigation before Enter, Up/Down wraps, and Escape/Ctrl-C cancels before Devin initialization | Solo project |
| Model chooser (`src/repl/ModelChooser.tsx`) | Full-screen missing-model recovery for interactive fresh sessions; reuses the session chooser's input state and pure input/window helpers plus the alternate-screen/theme lifecycle while rendering model-specific capability rows; exports `resolveModelCommand` (pure command parser returning show/switch/error) and `ModelRow` for inline REPL `/model` picker | Solo project |
| Ink REPL (`src/repl/App.tsx`) | Full-height multi-turn UI with repaintable transcript, sticky todos/approval/suggestions/composer, viewport history, Markdown completion rendering, tool feedback, persistence hydration/checkpoint hooks, inline `/model` picker with keyboard navigation, live model switching via `buildSessionCore`, in-REPL `/trust` picker for updating the session trust decision, and status segments | Solo project |
| Status line helpers (`src/repl/statusLine.ts`) | Pure `formatCwd(cwd)` (homedir → `~` shortening) and async `getGitStatus(cwd)` (branch name + dirty detection via `execFile("git", ...)`) — consumed once on mount by `App.tsx`'s status bar; returns `{ branch: null, dirty: false }` outside a git repo or on any `git` error | Solo project |
| One-shot terminal spinner (`src/spinner.ts`) | `startSpinner(label)` writes a cycling braille frame to `process.stderr` on an interval and returns a `stop(isError)` closure that clears it and writes a final `✔`/`✘` line — the one-shot path's stderr-only equivalent of the REPL's `ink-spinner` line; `oneShot.ts` tracks at most one animated spinner slot at a time (per-call `tool_execution_start`/`tool_execution_end` events since Phase 18), falling back to a static, non-animated log line plus a manually-written `✔`/`✘` line for any additional concurrent call | Solo project |
| Threat pattern scanner (`src/security/threatPatterns.ts`) | Pure, id-tagged regex list (`CONTEXT_THREAT_PATTERNS`, 10 curated patterns covering prompt injection, role hijack, HTML hidden-element injection, system-prompt leak, and safety-bypass phrasing) plus `scanForThreats(content)` returning matched pattern ids; no I/O, bounded filler `(?:\w+\s+){0,8}` prevents catastrophic backtracking | Solo project |
| Command risk classifier (`src/security/commandApproval.ts`) | Pure `checkCommandApproval(command, mode, sessionApprovals)` returning one of three `ApprovalRequirement` variants: `forbidden` (5 hardline patterns — always blocked regardless of mode), `skip` (no match, already session-approved, or mode `"off"`), or `needs_approval` (7 dangerous patterns in manual/smart mode); exports `stripShellComments` to remove `# …` comment tails while respecting single/double quoting — used by the smart reviewer to reduce prompt-injection surface | Solo project |
| Smart approval reviewer (`src/security/smartApproval.ts`) | `smartApprove(devin, reviewerModel, command, flagReason)` sends the comment-stripped command plus flag reason to a Devin LLM call with a security-reviewer system prompt and parses the response as `"approve" \| "deny" \| "escalate"`; fail-safe: any error or unparseable response returns `"escalate"` so the human prompt is never silently skipped on failure | Solo project |
| Project context loader (`src/agent/projectContext.ts`) | Discovers and loads a project's context file (`.railgun.md`/`RAILGUN.md` walking to the git root, falling back to `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, `.cursorrules` in cwd only — first readable non-empty file wins, with case-variant aliases exhausted per directory before walking up or moving to the next candidate group), plus `~/.railgun/SOUL.md` as persistent identity; truncates with a 70/30 head/tail split at 20 000 chars, then scans the retained head and tail independently for injection via `scanForThreats` (blocked files produce a `[BLOCKED: ...]` placeholder that does not fall through to the next candidate); exports `loadProjectContext(cwd)` and `loadSoulIdentity()` | Solo project |

| Cron scheduler (`src/cron/jobs.ts`, `src/cron/scheduler.ts`) | `CronJob` type, `CronJobsError` (matches `ConfigError` pattern), `loadJobs`/`saveJobs` (disk I/O with `write-file-atomic`), `validateJob` (type-guarded shape validation), and `isDue` (uses `cron-parser`'s `CronExpressionParser.parse().prev()` to find the last scheduled time before `now`, returns `true` when `lastRun` is null or before that time). `startScheduler` re-reads jobs each cycle, calls `tick` (sequential due-job runner), saves back only when jobs ran, and sleeps between cycles via `Promise.withResolvers()` for abort-safe cancellation; SIGINT/SIGTERM forwarded from `dispatchCli` through an `AbortController`. Shell commands are denied in unattended runs unless `approvalMode: "off"`. Extensions are not loaded; each job gets a fresh ephemeral session with a 30-step iteration budget | Solo project |

## Data Flow

**One-shot path (`pnpm start --print`/`-p "<question>"`, tool-calling since Phase 4, iteration-budgeted since Phase 6, live tool spinner since Phase 7):**

1. `src/cli.ts` detects `--print`/`-p`, takes the remaining argv as the
   question (default `"Hello!"`), and calls `runOneShot`.
2. Before session initialization, `resolveProjectTrust` resolves the project trust
    decision (see the trust gate component description above); the `TrustDecision`
    is threaded through as plumbing — no resources are gated in Phase 20.
    `runOneShot` calls `initFreshDevinSession` (`src/session.ts`), which loads
   configuration and asks the authentication boundary for a provider. A
   trimmed nonempty `DEVIN_TOKEN`
   uses a process-local memory store and takes precedence without reading or
   changing the cache. Otherwise `~/.railgun/devin-token` is reused; only an
   absent cache starts OAuth through `src/openBrowser.ts`. Whitespace-only
   environment input counts as absent. `devin.listModels()` fetches available
   models. A null configuration selects the first; an available string selects
   that exact ID; an unavailable string follows interactive/non-interactive
   recovery before session construction. Session
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
3. `runOneShot` reads `~/.railgun/config.json` to extract `approvalMode` and
   (optionally) `reviewerModel`, creates a fresh in-memory `TodoStore` and a
   fresh `Set<string>` for session approvals, then calls `createAgentSession`
   with those values plus the session's default `iterationBudget` (via
   `createAgent`) and a `confirmShellCommand` built from
   `node:readline/promises`: it opens a `readline` interface on
   `process.stdin`/`process.stderr`, prompts
   `Run shell command: <command>\nType "yes" to run, anything else to cancel: `,
   and resolves `true` only if the answer trimmed/lowercased is exactly
   `"yes"` (closed/EOF stdin resolves immediately to an empty answer, i.e.
   declined; open-but-silent stdin blocks until answered — see
   `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md`'s
   context for why this matters for CI/scripted invocations). Before this
   prompt is ever shown, `run_shell_command`'s handler passes the command
   through `checkCommandApproval` — hardline commands are blocked immediately,
   safe commands bypass the prompt, dangerous commands enter the configured
   approval tier. See ADR-0013.
4. `message_update` events carrying `text_delta` stream to stdout as
   `createAgentSession` runs its rounds via `runOneShot`'s subscription.
   Each round's dispatched tool call(s) also fire `tool_execution_start`/
   `tool_execution_end`, correlated by `toolCallId` (see the shared
   `toolcall_delta`/`toolcall_end` dispatch note below); `runOneShot` tracks at
   most one animated spinner slot at a time via `src/spinner.ts`'s
   `startSpinner`/`stop`, which write a cycling braille frame and a final
   `✔`/`✘ <label>` line to `process.stderr` only, falling back to a static
   non-animated log line plus a manually-written `✔`/`✘` line for any
   additional concurrent call — stdout carries nothing
   but the streamed answer, so the spinner never corrupts a piped
   `pnpm start --print "..." | some-other-tool` invocation. On success a
   trailing newline is written to stdout after the loop completes. Budget
   exhaustion is returned as success, with the iteration-limit message as
   the answer text. Todo tool calls update the one-shot store but do not
   render spinner or completion output, preserving the stdout/stderr
   scripting contract.
5. Any error — from `streamChat` itself, or an error `agentSession.run` returns as
   `{ ok: false, error }` — is re-thrown by `runOneShot` and caught by
   `main()`'s top-level handler in `src/cli.ts`, which prints one line to
   stderr (via `describeDevinError`, falling back to a full dump for
   unclassified errors) with a non-zero exit code. Model-discovery and stream
   HTTP 401 responses become source-aware rejections: cached credentials are
   removed, while environment rejection leaves the cache untouched.

**Authentication commands (`login`/`logout`):**

1. CLI parsing recognizes only the exact subcommands with no extra arguments
   and dispatches before constructing SQLite, project context, a session, or
   the TUI.
2. `login` always starts fresh browser OAuth against the file store. The old
   cache remains until OAuth returns a replacement. Model discovery then
   verifies it: 401 clears the new value; API/protocol uncertainty retains it
   with saved-but-unverified context. A nonempty `DEVIN_TOKEN` produces an
   override warning.
3. `logout` idempotently clears the file store. A nonempty `DEVIN_TOKEN`
   produces a warning because environment authentication remains active.

**Startup session management (`--resume`/`-r [session-id]` and
`--list-sessions`):**

1. `parseCliArgs` resolves the mode before any stateful dependency is opened.
   The `--print` branch returns directly to `runOneShot`, so it never creates
   a `SessionStore`.
2. `--list-sessions` opens `createSessionStore`, calls `listSessions`, prints
   the detailed newest-first table (or `No saved sessions.`), and closes the
   store without calling `initDevinSession`.
3. Direct `--resume <id>`/`-r <id>` calls `loadSession(id)`. Bare `--resume`/`-r` first calls
   `listSessions`; an empty result exits successfully, otherwise
   `runSessionChooser` renders the Ink selector. Up/Down wraps the highlight,
   Enter returns the selected ID, and Escape/Ctrl-C returns no selection. The
   CLI awaits this result before any Devin login or model discovery.
4. A confirmed resume loads the strict persisted snapshot, then calls
   `initDevinSession(saved.model)`. For all three session-starting modes (fresh, resume, one-shot/print), trust
   resolution runs before session or database initialization. The exact model is required; Railgun never
   silently switches an old conversation to another model. `runRepl` receives
   the complete saved messages, normalized todos, immutable session metadata,
   and the full-snapshot checkpoint callback. The system prompt, project
   context, persistent identity, current directory, and 90-step budget are
   rebuilt for the new process rather than loaded from SQLite.
5. Missing IDs, corruption, database errors, and unavailable saved models
   propagate to the top-level error handler and exit nonzero. Store closure is
   guaranteed by `dispatchCli`'s shared `withStore`/`finally` boundary on
   success, cancellation, and failure.

**Configuration (`config` and fresh-session model selection):**

1. Exact `config` dispatch calls `loadConfig` and prints two-space JSON before
   authentication, SQLite, filesystem creation, or Ink initialization.
2. Missing `config.json` returns `{ "model": null }`. Existing object roots are
   recursively merged with defaults; recognized fields are validated while
   unknown JSON fields survive reads and writes. Parse, validation, and read
   failures identify the path and never trigger repair.
3. Fresh REPL and one-shot bootstrap apply the configured model. If an exact ID
   is unavailable and both stdin/stdout are TTYs, `runModelChooser` returns a
   replacement or cancellation. Replacement uses `write-file-atomic` after
   creating the Railgun home and completes before context or session startup.
   Non-TTY launches fail with both unavailable and available IDs. Exact-model
   resume remains a separate path and never switches models.

**Interactive REPL path (`pnpm start`):**

1. `src/cli.ts` initializes the configured fresh session before opening the
   session store, so recovery cancellation creates no database. It then opens
   the store, allocates a session ID, and calls `runRepl`. `ThemeController` resolves
   terminal appearance before OS appearance, installs deduplicated live
   listeners, and falls back to dark on failure.
2. Interactive TTY output enters the alternate screen and enables SGR mouse
   reporting; non-TTY and screen-reader runs do neither. Ink renders a
   full-height `ChatApp`, and alternate-screen, mouse, theme, and native-resource
   cleanup are guaranteed by `finally` boundaries around `waitUntilExit()`.
3. `ChatApp` owns one process-lifetime `IterationBudget`, hydrated `TodoStore`,
   and a `useRef<Set<string>>` for session approvals that persists across all
   turns in the session. On mount it reads `~/.railgun/config.json` to set
   `approvalMode` and `reviewerModel` state; this is fire-and-forget with a
   `.catch(console.error)` so a malformed config surfaces in the console but
   does not abort startup. Each submitted message creates an `AgentSession` over
   authoritative history, a subscribed event handler, approval, and those shared
   stores — the current `approvalMode`, `sessionApprovals` ref, and (if
   configured) `reviewerModel` are forwarded so the risk gate in
   `run_shell_command` can enforce the correct policy. While it runs, Enter
   queues steering and Ctrl+C aborts; idle queue operations and concurrent runs
   are rejected. Success checkpoints the complete history/todo snapshot; save
   failure retains it in memory for retry. Ordinary failure restores pre-turn
   todos, while abort retains completed tool/todo effects, partial assistant
   text, and a protocol-valid message prefix. Authentication failure leaves the
   REPL open and never replays the failed message or tools.
4. Display lines become physical terminal rows before entering the pure
   viewport reducer. Mouse wheel and PageUp/PageDown scroll, Home/End jump,
   resize preserves prior bottom-follow state, and an unseen cue consumes one
   visible row while scrolled up. Completed assistant text passes through the
   `markdansi` adapter; partial streaming text stays plain. Streaming narration
   is flushed before each following compact tool row and before a queued `YOU`
   row is injected; settlement appends only the unflushed suffix. Short visible
   slices bottom-align beside the composer, while full pages remain top-aligned.
   `todo` activity is represented by the sticky todo panel.
5. `ink-multiline-input` provides cursor navigation, wrapping, and multiline
   paste. Railgun supplies Enter/Shift+Enter bindings, completion-first Tab,
   Ctrl+U clearing, active-run steering, modal approval focus, protocol-response filtering,
   and one-to-six-row sizing. Enhanced keyboard reporting is enabled without a
   capability-query input leak only for known supporting terminals.
  | Command system (`src/commands.ts`) | Pure `/exit`, `/help`, `/clear`, `/model`, `/compact`, `/rollback`, and `/trust` matching, parsing, and tab/escape completion state; no I/O or React | Solo project |
  | Trust gate (`src/trust.ts`) | `TrustChoice`/`TrustDecision`/`ProjectTrustStore` types; `createProjectTrustStore` (ancestor-walk resolution, sync DI for path/readFile/writeFile, persists to `TRUST_PATH` via `writeFileSync` with mode `0600`); `resolveProjectTrust` (resolution order: CLI flags → config default → persisted store → interactive prompt); `promptTrustChoiceReadline` (five-choice readline prompt on stderr, fires before Ink starts); `assertProjectTrustedForRead`/`assertProjectTrustedForInstall` guards (not yet called — reserved for Phases 23/28) | Solo project |
  6. `/exit`, `/help`, `/clear`, `/model`, `/compact`, `/rollback`, and `/trust` are handled before agent dispatch. `/exit` resolves Ink, `/help` appends the current command list, `/clear` clears the canvas without discarding authoritative conversation state, `/compact` runs `runCompaction` directly (bypassing `runTurn`/`callDevinWithRecovery`), replaces `history` with the single compacted message plus a synthetic assistant acknowledgement, and attempts a checkpoint save. `/rollback` calls `rollback(shadowGitDir(cwd), cwd)` from `src/checkpoint.ts` to restore the working tree to the last shadow-git commit. The `/trust` command opens a five-key picker (keys `1`–`5`, Escape to cancel) within the running Ink REPL; on a valid choice it calls `trustStore.set(cwd, choice)`, updates the in-session `TrustDecision` state, and appends a confirmation line to the transcript.

`toolcall_delta` and `toolcall_end` events together drive
`src/agent/turn.ts`'s tool-calling loop in both paths (Phase 5 added
`toolcall_delta` buffering; before that it was ignored). `usage` events are
captured by both paths since Phase 16 to drive proactive context
compaction (`shouldCompact`/`runCompaction`, `src/agent/compaction.ts`).
`thinking_delta` and `toolcall_start` are forwarded by `turn.ts` as
`message_update` events (since Phase 18) but still ignored by both
consumers (reasoning display is a later phase; live tool-call feedback
shipped in Phase 7 via `LoopCallbacks`, replaced in Phase 18 by a typed
`AgentEvent`/`AgentSessionEvent` stream — see ADR-0012). Both paths enable the exact same toolsets (`"file"`, `"terminal"`, `"planning"`, `"clarify"`, and `"extension"`) — the only behavioral difference between them is how `confirmShellCommand` collects the y/n answer and how `clarifyCallback` surfaces questions to the user (Ink `useInput`/`useState` in the REPL vs. blocking `readline` on stdin in one-shot mode), and how tool activity renders (an `ink-spinner` line + scrollback vs. a stderr braille spinner via `src/spinner.ts`). They also differ in budget lifetime: the REPL has one shared 90-step budget and one shared todo store for the process lifetime, while each one-shot invocation gets a fresh 90-step budget and fresh todo store.

## Persistence

`getHomeDir()` fixes the application home at `~/.railgun`; config, token, state, SOUL, trust, extensions, and cron paths are derived from it. `config.json` is the single configuration source. Missing files use `{ "model": null, "defaultProjectTrust": "ask" }`; unknown fields are retained and model recovery writes two-space JSON with a trailing newline atomically.

A single file, `~/.railgun/devin-token` (mode `0600`), holds the optional cached
Devin auth token and is managed through `widevin`'s `createFileTokenStore`.
`DEVIN_TOKEN`, when nonempty after trimming, is held in a memory store for the
current process, takes precedence over this file, and is never persisted or
cleared by Railgun. An optional file, `~/.railgun/SOUL.md` (no file-mode
restriction — user-authored text, not a secret), is read once at session
startup by `loadSoulIdentity` (`src/agent/projectContext.ts`) and its
content injected as a `# Persistent Identity` block in the system prompt;
a missing or whitespace-only file is silently ignored.

`~/.railgun/trust.json` (mode `0600`) persists per-project trust decisions,
keyed by canonical absolute directory path. Ancestor-directory inheritance
applies: trusting `/a/b` implicitly trusts any subdirectory. `trust-parent`
writes to `path.dirname(canonicalPath)`. Session-only choices (`trust-session`,
`deny-session`) are never written to disk. The file is created lazily on the
first persisted choice; a missing file means no stored decisions. Both the
trust store and `assertProjectTrustedForRead`/`assertProjectTrustedForInstall`
guards live in `src/trust.ts`; the guards are not yet called in Phase 20
(reserved for Phases 23/28).

The session database,
`~/.railgun/state.db` (mode `0600`), stores interactive sessions, messages,
and todo snapshots. It uses WAL, foreign keys, a busy timeout, and schema
versioning; malformed saved state aborts loading instead of being skipped.
One-shot mode does not open this database. See ADR 0006.

Shadow-git checkpoint directories live at
`~/.railgun/checkpoints/<12-char-sha256-of-cwd>/`. One directory per project
cwd, initialized as a non-bare git repo on first use. No file-mode restriction
is applied — checkpoint repos contain only project file snapshots, no secrets.
One-shot mode does not create or use checkpoints.

`~/.railgun/cron/jobs.json` (mode `0600`, created lazily by `saveJobs`) stores the list of scheduled jobs. Each job has `id`, `schedule` (cron expression, interpreted in local time by `cron-parser`), `prompt`, and `lastRun` (epoch ms or null). A missing file means no jobs; the scheduler treats it as an empty list and does not create the file unless a job runs. The file is re-read on every scheduler tick so edits take effect without a process restart; it is written atomically via `write-file-atomic` after any job runs to persist the updated `lastRun` values. Cron mode does not open the session database.

## Integrations

- Devin, via the `widevin` npm package (OAuth login, model discovery, streaming chat). See
  `docs/adr/0001-single-provider-devin-via-widevin.md` and
  `docs/adr/0008-source-aware-devin-authentication.md`.
- SQLite, via `better-sqlite3`, for local interactive session checkpoints. See
  `docs/adr/0006-sqlite-session-checkpoints.md`.
- Ink (`^6.8.0`) + React (`^19.2.0`) + `ink-multiline-input` (`^0.1.0`) +
  `ink-spinner` (`^5.0.0`) for the REPL's terminal UI, pulled forward from
  the replication plan's later "polished terminal UI" phase. See
  `docs/adr/0002-ink-repl-ahead-of-schedule.md`. Ink is still pinned to 6,
  not 7, even though the Node floor was independently raised to `>=22`
  for `Promise.withResolvers()` — see
  `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md`.
  `ink-spinner`'s published peer deps (`ink >=4.0.0`, `react >=18.0.0`)
  are satisfied by both pins with no override needed.
- `os-theme` provides OS and terminal appearance detection; `markdansi`
  provides completed-reply GFM parsing, layout, links, tables, and code boxes.
- Context compaction's algorithm (`src/agent/compaction.ts`) is ported from
  [OpenAI's Codex CLI](https://github.com/openai/codex)
  (`codex-rs/core/src/compact.rs`), not from `widevin` or a package
  dependency — Codex is a reference implementation read during development,
  not a runtime integration. Two adaptations diverge from Codex's shape to
  satisfy `sessionStore.ts`'s stricter transcript alternation invariant; see
  `docs/adr/0010-compaction-single-message-adaptations.md`.

## Security

- Cached Devin tokens use a single user-owned file (`~/.railgun/devin-token`,
  mode `0600`); environment tokens remain process-local and are never copied
  into that cache.
- Railgun never logs or prints token contents; only the sign-in URL (which
  is not a secret on its own) is printed during login.
- Conversation history and todos may contain sensitive local data. The SQLite
  database is chmod'd to `0600` whenever it is opened, and strict codecs fail
  closed on malformed or inconsistent rows rather than skipping them. The
  database is not application-level encrypted; confidentiality relies on the
  OS account and filesystem protections.
- `run_shell_command` runs whatever command string the model provides via
  `spawn("bash", ["-c", command])` — a real arbitrary-code-execution surface.
  Phase 21 adds a three-tier risk gate (`src/security/commandApproval.ts`)
  before any shell is spawned: **hardline** patterns (5 regex rules — `rm -rf /`,
  `mkfs.*`, `shutdown`/`reboot`, fork bombs, `dd of=/dev/<disk>`) are blocked
  unconditionally and cannot be overridden by configuration; **dangerous**
  patterns (7 rules — `rm -r*`, `sudo`, `git push --force`, `DROP TABLE`,
  block-device redirects, world-writable `chmod`, `curl | bash`) route through
  the configurable approval tier; **safe** commands execute immediately with no
  prompt. The approval tier's behavior is set by `approvalMode` in
  `~/.railgun/config.json`: `"manual"` (default) shows the interactive y/n
  prompt, `"off"` skips the prompt (hardline blocks still apply), and `"smart"`
  calls an LLM reviewer (`src/security/smartApproval.ts`) that can approve,
  deny, or escalate to the human prompt. Shell comments are stripped before
  the command is sent to the reviewer (`stripShellComments`) to reduce the
  prompt-injection surface; the reviewer is fail-safe and always escalates on
  any error. Approved pattern classes are recorded in a per-session
  `Set<string>` so re-approval is not needed within one conversation. On
  macOS/Linux the child runs in a detached process group; cancellation sends
  `SIGTERM` to the group, escalating to `SIGKILL` after two seconds.
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
- Project trust (`~/.railgun/trust.json`, mode `0600`) gates future loading of
  project-local config, extensions, and skills. The trust gate (`src/trust.ts`)
  runs before session initialization; untrusted projects will have no local
  resources loaded once those resources exist (Phases 23/28). CLI flags
  `--approve`/`-a` and `--no-approve`/`-na` bypass the persisted store for one
  invocation. `defaultProjectTrust: "always"` in `config.json` disables the gate
  globally (opt-in). The five-choice `/trust` REPL command lets users change the
  in-session decision.
- Compliance is an operational responsibility, not a code-enforced one — see
  `docs/adr/0001-single-provider-devin-via-widevin.md`.
- Extension code (`~/.railgun/extensions/` and `.railgun/extensions/`) runs as untrusted user-supplied JavaScript or TypeScript with the same OS process privileges as Railgun itself. There is no sandbox, capability restriction, or code signing. `tool_call` handlers can block built-in tools; all handlers run before the answer is delivered to the model. Project-local extensions are not yet trust-gated — they load unconditionally when `trusted: true` is passed (the current hardcoded default). See `docs/adr/0013-extension-system.md`.

## Observability

- Human-readable startup status, selected model, the first committed full
  session ID, and top-level failures are written to stderr. One-shot answer
  text remains isolated on stdout for piping.
- The REPL exposes checkpoint health directly: an `unsaved` status marker and
  warning appear after a failed save, and a recovery line appears after the
  next successful full-snapshot retry.
- There are no structured logs, metrics, traces, telemetry exports, or remote
  crash reports. `--list-sessions` is the supported local inspection surface;
  corrupt state is reported as an actionable error rather than partially
  displayed.

## Deployment

- Railgun is a single-user local Node.js CLI, run from source with pnpm or from
  the compiled `dist/` output. It has no daemon, server, container, or remote
  persistence service.
- Node.js 22 or newer is required. Installation must provide a compatible
  `better-sqlite3` native binary (downloaded or built by pnpm) for the host
  platform.
- Runtime state lives under `~/.railgun/`; project context is rebuilt from the
  directory where each process is launched.

## Architectural Decision Records

Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance. See `docs/adr/0013-command-risk-gate-and-smart-approval.md` for the Phase 21 risk-gate design.
