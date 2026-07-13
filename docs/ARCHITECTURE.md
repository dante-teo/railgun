# Architecture

## Overview

This document records the intended system architecture for Railgun. Keep it current as major components, deployment boundaries, and integration points are introduced.

## Principles

- Prefer simple, composable modules with explicit boundaries.
- Keep side effects at system edges.
- Capture significant technical decisions as ADRs in `docs/adr/`.
- Favor well-maintained open source dependencies when they materially reduce implementation risk.

## System Context

- Users: the project's own author, via a local terminal or macOS desktop app
- External systems: Devin/Cascade (via `widevin`'s OAuth + HTTP/streaming API)
- Runtime environment: local developer machine (macOS/Linux/Windows), Node.js >= 22.19.0 (see `docs/adr/0003-node-floor-raised-to-22-for-promise-withResolvers.md` and `docs/adr/0030-built-in-web-search-and-fetch.md`)
- Supported surfaces: terminal REPL, one-shot CLI output, JSONL RPC over stdio,
  ACP over stdio, and the private Electron desktop scaffold
- Package boundary: one publishable Node.js CLI package plus one private
  Electron workspace, managed by pnpm with one lockfile; no daemon or socket
  service

## Components

| Component | Responsibility | Owner |
| --- | --- | --- |
6: | CLI entry (`src/cli.ts`) | Pure argv parsing plus injectable dispatch for `config`, `login`, `logout`, `cron`, `import-notes`, `dream`, fresh REPL, exact/interactive resume, session listing, stateless one-shot, headless RPC, and ACP server modes; config/auth/cron/import commands return before SQLite/session/TUI boundaries | Solo project — no formal ownership split |
7: | Tool registry (`src/tools/registry.ts`) | `createToolRegistry()` factory closing over a `Map<name, RegisteredTool>`; `ToolContext` carries the run-scoped `signal`, required `commandApprovalMode` and `sessionApprovals` fields for the risk gate, optional `devin`/`reviewerModel` for smart-approval LLM calls, optional `clarifyCallback` (`ClarifyCallback`), optional `memoryStore` (`MemoryStore`) for the `memory_write`/`memory_search` tools, optional `noteStore` (`NoteStore`) for the `note_search` and `note_search_semantic` tools, optional `advisoryContext?: AdvisoryContext` that is present only during advisor tool execution, optional `model`/`contextWindow`/`delegationDepth` fields forwarded from `RunTurnOptions` so delegate-tool children inherit session configuration, and optional `emit?: (event: AgentEvent) => Promise<void>` giving tool handlers access to the parent turn's event sink (used by `delegate_task` for `subagent_start`/`subagent_end`); `run` refuses already-aborted work, dispatches handlers, and converts unknown names or thrown failures into error results | Solo project |
8: | Built-in tools (`src/tools/{readFile,writeFile,listDirectory,runShell,todo,clarify,memory,noteSearch,noteSearchSemantic,memoryConsolidate,cron,delegate}.ts`) | Twelve self-registering tools: file I/O, caller-owned todo planning, `run_shell_command`, `clarify`, `memory_write`, `memory_search`, `memory_consolidate`, `note_search`, `note_search_semantic`, `cron`, and `delegate_task`; shell execution is routed through `checkCommandApproval` first — hardline-blocked commands return immediately as errors, safe commands execute directly, and dangerous commands go through configurable approval (manual y/n prompt, LLM smart review, or off); approved dangerous patterns are added to the per-session `sessionApprovals` set so the same class does not re-prompt within one conversation; the shell child is detached into a POSIX process group, sent `SIGTERM` on abort, then `SIGKILL` after a two-second grace period; `clarify` routes a question (with optional up-to-4 choices) to the injected `ClarifyCallback` and returns `{ question, answer }` JSON; memory tools read/write the `MemoryStore` injected via `ToolContext`; `note_search` performs FTS5 full-text search over imported notes via `NoteStore` injected via `ToolContext`; `note_search_semantic` performs embedding-based semantic search over the same notes via `NoteStore` injected via `ToolContext`; the self-registering `advise` tool (toolset `"advisory"`) is available only when `advisoryContext` is present on `ToolContext` — three emission guards (content-free phrase suppression, per-run dedupe, one-note-per-update rate limit) keep it quiet; all severities are routed through the steering queue | Solo project |
| Delegation tool (`src/tools/delegate.ts`) | Self-registering `delegate_task` tool under the `"delegation"` toolset. Accepts a single `goal` string or a `tasks` array and spawns independent child agent loops via `runTurn` — each child gets its own `IterationBudget` (50 steps), `AbortController`, and empty message history. Children run in batches of 3 (`MAX_CONCURRENT_CHILDREN`) via `Promise.all`. Leaf children (default) receive every standard toolset except `"delegation"`; orchestrator children at depth below the cap (2) also receive `"delegation"`. Parent abort propagates to all running children via a forwarding event listener. Emits `subagent_start`/`subagent_end` events through `context.emit`. `delegate_task` is listed in `NEVER_PARALLEL_TOOLS` so the turn loop never issues two concurrent delegation calls | Solo project |
| Web tools (`src/tools/{webSearch,webSearchProviders,webFetch}.ts`) | Read-only `web_search` and `web_fetch` tools under the always-enabled `"web"` toolset. Search walks configured Brave/Tavily/Jina/SearXNG providers, then keyless Exa MCP and best-effort DuckDuckGo, normalizing results and reporting the successful provider. Fetch extracts HTML with Readability, passes through text/JSON, bounds redirects/time/bytes/output, and blocks SSRF by validating every DNS answer and redirect before pinning Undici connections to approved addresses. Both tools are parallel-safe and inherited by delegated agents through `DEFAULT_TOOLSETS` in `src/tools/toolsets.ts` | Solo project |
| Memory store (`src/persistence/memoryStore.ts`) | Prepared-statement wrapper around the shared SQLite connection: `save(content, category)` inserts a UUID-keyed memory row; `search(query, limit?)` returns case-insensitive LIKE matches newest-first (with `rowid DESC` as tiebreaker for same-millisecond inserts); `recent(limit?)` returns the most recent memories; `all()` returns all memories in ascending creation order; `delete(id)` removes a memory and reports whether it existed; `update(id, content, category)` rewrites a row via `UPDATE … RETURNING` so the returned `Memory` carries the original `created_at`; `runInTransaction(fn)` wraps the callback in a SQLite transaction; `formatMemoriesForPrompt` formats a list for system-prompt injection, returning `null` for empty lists. Categories: `"preference"`, `"fact"`, `"project"` | Solo project |
| Note store (`src/persistence/noteStore.ts`) | FTS5 and vector-search prepared-statement wrapper around the shared SQLite connection (Phases 26–27): `importFolder(folderPath, chunkWords?)` reads `.md`/`.txt` files from the top-level directory, splits content into word chunks (default 500 words), and inserts each chunk inside a single transaction; `search(query, limit?)` sanitizes the query (strips FTS5 syntax characters), runs a `MATCH` query against `notes_fts` with `snippet()` extraction, and returns ranked results with `sourcePath` and `snippet` fields; Phase 27 adds `storeVector(noteId, embedding)`, `searchSemantic(queryVector, limit?)`, `importFolderWithEmbeddings(folderPath, embedFn, chunkWords?)`, and `backfillEmbeddings(embedFn)` against the `notes_vec` sqlite-vec virtual table (`embedding FLOAT[384]`), plus an `EmbedFn` type. The `notes_fts` virtual table is kept in sync by three database triggers (insert/delete/update) defined in the schema migration | Solo project |
9: Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance. See `docs/adr/0013-command-risk-gate-and-smart-approval.md` for the Phase 21 risk-gate design, `docs/adr/0014-mcp-client-support.md` for the Phase 24 MCP client, `docs/adr/0014-persistent-memory.md` for the Phase 25 memory design, `docs/adr/0014-advisor-passive-second-model.md` for the Phase 34 advisor design, `docs/adr/0015-skills-system.md` for the Phase 28 skills system design, `docs/adr/0016-ansi-first-ui-design-system.md` for the Phase 35 shared ANSI design system, `docs/adr/0016-delegate-task-subagent-spawning.md` for the Phase 31 delegation design, `docs/adr/0026-notes-fts5-search.md` for the Phase 26 FTS5 notes search design, `docs/adr/0027-semantic-note-search.md` for the Phase 27 semantic note search design, and `docs/adr/0031-node-pnpm-single-package.md` for the runtime and package boundary.
| Paths/configuration (`src/paths.ts`, `src/config.ts`) | Derives config, token, state, SOUL, trust, extension, cron, and skills paths from one fixed Railgun home (`~/.railgun`); recursively merges defaults with user JSON, validates recognized fields (`model`, `defaultProjectTrust`, `approvalMode`, `reviewerModel`, `operationTimeoutMs`, `moaPresets`, `activeMoaPreset`, `advisor`), preserves unknown fields (including `mcpServers`), and exposes validated atomic functional updates used by model and settings persistence. `operationTimeoutMs` is a positive integer with a `600000` default | Solo project |
| Async operation guard (`src/asyncOperation.ts`) | `runBoundedOperation` creates a per-operation controller linked to the run signal, races cooperative or non-cooperative promises against cancellation and an optional deadline, clears timers/listeners on settlement, aborts the scoped signal before rejecting a timeout, and absorbs late fulfillment or rejection. `OperationTimeoutError` retains the operation label and deadline for descriptive failures. Provider consumption may flush one already-produced event during immediate cancellation, but stops processing once the scoped deadline signal is aborted | Solo project |
| Authentication boundary (`src/auth.ts`) | Selects trimmed process-local `DEVIN_TOKEN` or the file cache, wraps model discovery and async streaming with source-aware 401 invalidation, and implements fresh-login verification plus idempotent cached logout without exposing token contents | Solo project |
| Session bootstrap (`src/session.ts`) | Acquires the authenticated provider, keeps resumes on an exact saved model, applies configuration to fresh sessions, coordinates interactive missing-model recovery before session construction, loads context/identity, and builds the system prompt once; accepts an optional `memoriesText` string that is injected as a `# Memories` prompt block when provided; exports `buildSessionCore` for silent mid-REPL session rebuilds during `/model` switches | Solo project |
| Session store (`src/persistence/sessionStore.ts`) | Functional factory around synchronous SQLite: schema v5 with a parent_id tree structure for messages, a `memories` table for cross-session memory, a `notes` table + `notes_fts` FTS5 virtual table (with three sync triggers) + `notes_vec` sqlite-vec virtual table for imported document search (Phases 26–27), strict message/todo codecs, fail-closed transcript validation, newest-first summaries, recursive-CTE branch walks, atomic full-snapshot checkpoints, branch/fork/branchWithSummary operations, and a `readonly db` handle exposed for `MemoryStore` and `NoteStore` to share the connection. Migrations live in a `MIGRATIONS: ReadonlyArray<fn>` array (index N = delta from schema N to N+1); `initializeSchema` runs each outstanding step in a transaction that atomically bumps `user_version` atomically — no separate `SCHEMA_VERSION` constant. Branch-summarizer logic lives in `src/persistence/branchSummarizer.ts`. | Solo project |
| System prompt builder (`src/agent/systemPrompt.ts`) | Pure prompt assembly: Railgun identity, tool rules (including `memory_write`, `note_search`, and `note_search_semantic` guidance since Phases 25/26/27, and — new in Phase 28 — explicit instructions that the agent can create or update `~/.railgun/SOUL.md` and `.railgun.md` via `write_file`), cached session environment, and up to three optional context blocks — `soulIdentity` (`~/.railgun/SOUL.md`), `projectContext` (project context file), and `memories` (formatted memory list). The `# Persistent Identity` block is always emitted: when `soulIdentity` is present it includes the loaded content; when absent it includes a "file does not exist yet" hint pointing the agent to `write_file`. Environment values are JSON-serialized as data. Remains synchronous and pure — all I/O happens before this function is called | Solo project |
| One-shot path (`src/oneShot.ts`) | Single-question turn loop used by `--print`/`-p`, plus `readline`-based shell-approval and clarify prompts on stderr; when `activeMoaPreset` is set in config, the named preset is loaded and passed to `createAgentSession`, and MoA reference events are printed to stderr | Solo project |
| RPC subsystem (`src/rpc/{jsonl,types,rpcMode,rpcClient}.ts`) | `serializeJsonLine`/`makeLineReader` framing that splits on `0x0a` only (not `U+2028`/`U+2029`); `RpcCommand`/`RpcResponse`/`RpcSessionState` types; `runRpcMode` headless loop that consumes stdin commands, dispatches one in-flight `prompt` at a time, handles synchronous `steer`/`abort`/`follow_up`, fans raw `AgentSessionEvent` objects to stdout, and shuts down on stdin EOF; `RpcClient` for spawning child processes, correlating responses by id, and forwarding events | Solo project |
| Desktop scaffold (`apps/desktop`) | Private Electron 43 / Forge 7 / Vite 8 / React workspace. Main owns a bounded backend supervisor and mock scenario restarts; preload exposes four typed backend operations; the sandboxed renderer uses shadcn/ui primitives to display startup, ready, failed, and disconnected states plus a mock-only transport panel. Real and mock backends use the same JSONL stdio path. | Solo project |
| ACP subsystem (`src/acp/{acpMode,toolKind}.ts`) | `createAcpApp(options)` builds an `AgentApp` (from `@agentclientprotocol/sdk`) with handlers for `initialize`, `authenticate`, `session/set_mode`, `session/new`, `session/prompt`, and `session/cancel`; `runAcpMode` connects it to stdio via `ndJsonStream`; `mapToolKind` maps internal tool names to ACP tool-kind strings (`"read"`, `"edit"`, `"execute"`, `"think"`, `"other"`); each `session/prompt` creates a fresh `AgentSession`, streams `agent_message_chunk`/`tool_call`/`tool_call_update` `session/update` notifications to the client, and accumulates per-session conversation history; `session/cancel` calls `agentSession.abort()` on any in-flight run | Solo project |
| Error presentation (`src/errors.ts`) | Maps widevin and source-aware credential errors to one-line messages while preserving API/protocol formatting and reporting cache-removal failures alongside the original 401 | Solo project |
| Iteration budget (`src/agent/iterationBudget.ts`) | Provides the default 90-step `IterationBudget` and the friendly exhaustion message shared by the REPL and one-shot paths | Solo project |
| Agent lifecycle (`src/agent/{agent,queue}.ts`) | Functional `createAgent` owner for one run-scoped `AbortController`, validated operation deadline, concurrent-run/idle-queue guards, FIFO boundary steering, settle-time follow-ups consumed one at a time, queue cleanup, readonly `run`/`abort`/`steer`/`followUp`/`isRunning` operations, and a `subscribe` fan-out that bounds each awaited listener while catching and logging per-listener failures; the deprecated batch `takeFollowUps` operation remains for compatibility while agent code uses singular `takeFollowUp`; when an `advisor` dependency is supplied, the advisor runtime is created once at agent construction, advisory prompts are normalized out of incoming and returned durable history, `seedFrom(messages)` advances the advisor cursor and resets its one-steer allowance plus dedupe state for each run, and bounded `onTurnEnd` work is awaited after each `turn_end` event | Solo project |
| Turn logic (`src/agent/turn.ts`) | Runs one chat turn against a `DevinProvider`, looping tool-call rounds via the tool registry (`"file"`, `"terminal"`, `"planning"`, `"clarify"`, `"extension"`, `"memory"`, `"skills"`, `"delegation"`, and `"cron"` toolsets always enabled at the top level) while an injected `IterationBudget` has remaining steps; each round is wrapped in `callDevinWithRecovery` and dispatches resolved tools sequentially or in parallel with an independent deadline per call; provider streams, extension hooks, compaction, MoA references, and advisor work use scoped cancellation and deadlines, and provider events yielded after timeout are discarded; approval and clarification remain untimed but cancellation-aware; emits a typed `AgentEvent` stream through an `emit` sink; injects one queued steer per completed boundary, then when the run would otherwise settle injects follow-ups FIFO one per assistant boundary so durable history never contains consecutive user messages; preserves a protocol-valid transcript and explicit aborted outcome on cancellation; captures usage for 90%-window compaction and injects active todo state; `RunTurnOptions` carries `operationTimeoutMs`, MoA, advisor callback, enabled-toolset, model, context-window, and delegation-depth configuration into the appropriate operation boundaries | Solo project |
| Mixture of Agents (`src/agent/moa.ts`) | Pure MoA orchestration: `MoAPreset`/`ModelSlot` types; `REFERENCE_SYSTEM_PROMPT`; `truncateToolResult` (head+tail truncation with omission marker); `buildReferenceMessages` (converts conversation to a tool-free advisory view — tool results folded into preceding assistant content, synthetic user advisory appended when conversation ends on an assistant turn); `ReferenceCallbacks` interface for real-time start/end event delivery inside `runReferences`; `runOneReference` (advisory-only `streamChat` call, char-budget early-break, failure → labelled note, never throws); `runReferences` (parallel `Promise.all` fan-out with per-slot callbacks, max 8 references); `buildAggregatorGuidance` (labels labelled blocks with model names); `injectMoAGuidance` (appends guidance as a trailing user message — pure, does not mutate input). No I/O beyond the `DevinProvider` calls | Solo project |
| Event vocabulary (`src/agent/events.ts`) | Shared `AgentEvent` union (`agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`tool_execution_end`, `compaction_start`/`compaction_end`, `moa_reference_start`/`moa_reference_end`, `moa_aggregating`, `subagent_start`/`subagent_end`) and the `ToolResult` shape (`toolCallId`, `content`, `isError`) both `turn.ts` and `agentSession.ts` depend on; no I/O | Solo project |
| Session wrapper (`src/agent/agentSession.ts`) | `createAgentSession` wraps `createAgent`, re-emitting the raw `AgentEvent` stream plus session-only `AgentSessionEvent` additions — `agent_settled` (fires exactly once per completed `run()` call regardless of outcome) and `queue_update` (a session-local mirror of the steering/follow-up queues, updated on enqueue and on the injected message's `message_start` dequeue) — to independent `subscribe`d listeners | Solo project |
| Tool dispatch safety (`src/agent/toolDispatch.ts`) | Pure logic deciding whether a round's tool calls may run concurrently (`shouldParallelizeToolBatch`, `pathsOverlap`) and detecting corrupted tool-call JSON (`safeParseToolArgs`, `CORRUPTION_MARKER`) — no I/O, no registry access | Solo project |
| API failure recovery (`src/agent/recovery.ts`) | Treats credential rejection/401 as reauthentication, retries HTTP 408/429/5xx and fetch-style transport failures up to 3 attempts with 500ms/1000ms delays, classifies HTTP 413 as `compress_and_retry` (awaits an optional `compress` callback and retries without incrementing the backoff attempt counter, itself capped at 3 compression attempts), and fails other client/protocol/unrelated errors immediately | Solo project |
| Context compaction (`src/agent/compaction.ts`) | Ports Codex's (`openai/codex`) history-summarization algorithm: `runCompaction` sends the conversation plus a fixed summarization prompt to Devin (no tools), retrying with the oldest message dropped on a 413 until one request message remains; `selectRecentUserTexts`/`truncateMiddleTokens` keep a token-budgeted (20 000-token), newest-first selection of prior user turns, truncating the oldest kept message's middle with a `"…N tokens truncated…"` marker rather than dropping it outright; `buildCompactedMessage` merges the selected texts and the model's handoff summary into a single `role: "user"` message (Railgun's stricter `sessionStore.ts` transcript alternation forbids Codex's multi-message replacement shape — see `docs/adr/0010-...md`); `shouldCompact` triggers at 90% of the model's context window | Solo project |
6: | CLI entry (`src/cli.ts`) | Pure argv parsing plus injectable dispatch for `config`, `login`, `logout`, `cron`, `import-notes`, `dream`, fresh REPL, exact/interactive resume, session listing, stateless one-shot, headless RPC, and ACP server modes; config/auth/cron/import commands return before SQLite/session/TUI boundaries | Solo project — no formal ownership split |
7: | Tool registry (`src/tools/registry.ts`) | `createToolRegistry()` factory closing over a `Map<name, RegisteredTool>`; `ToolContext` carries the run-scoped `signal`, required `commandApprovalMode` and `sessionApprovals` fields for the risk gate, optional `devin`/`reviewerModel` for smart-approval LLM calls, optional `clarifyCallback` (`ClarifyCallback`), optional `memoryStore` (`MemoryStore`) for the `memory_write`/`memory_search` tools, optional `noteStore` (`NoteStore`) for the `note_search` and `note_search_semantic` tools, optional `advisoryContext?: AdvisoryContext` that is present only during advisor tool execution, optional `model`/`contextWindow`/`delegationDepth` fields forwarded from `RunTurnOptions` so delegate-tool children inherit session configuration, and optional `emit?: (event: AgentEvent) => Promise<void>` giving tool handlers access to the parent turn's event sink (used by `delegate_task` for `subagent_start`/`subagent_end`); `run` refuses already-aborted work, dispatches handlers, and converts unknown names or thrown failures into error results | Solo project |
8: | Built-in tools (`src/tools/{readFile,writeFile,listDirectory,runShell,todo,clarify,memory,noteSearch,noteSearchSemantic,memoryConsolidate,cron,delegate}.ts`) | Twelve self-registering tools: file I/O, caller-owned todo planning, `run_shell_command`, `clarify`, `memory_write`, `memory_search`, `memory_consolidate`, `note_search`, `note_search_semantic`, `cron`, and `delegate_task`; shell execution is routed through `checkCommandApproval` first — hardline-blocked commands return immediately as errors, safe commands execute directly, and dangerous commands go through configurable approval (manual y/n prompt, LLM smart review, or off); approved dangerous patterns are added to the per-session `sessionApprovals` set so the same class does not re-prompt within one conversation; the shell child is detached into a POSIX process group, sent `SIGTERM` on abort, then `SIGKILL` after a two-second grace period; `clarify` routes a question (with optional up-to-4 choices) to the injected `ClarifyCallback` and returns `{ question, answer }` JSON; memory tools read/write the `MemoryStore` injected via `ToolContext`; `note_search` performs FTS5 full-text search over imported notes via `NoteStore` injected via `ToolContext`; `note_search_semantic` performs embedding-based semantic search over the same notes via `NoteStore` injected via `ToolContext`; the self-registering `advise` tool (toolset `"advisory"`) is available only when `advisoryContext` is present on `ToolContext` — three emission guards (content-free phrase suppression, per-run dedupe, one-note-per-update rate limit) keep it quiet; all severities are routed through the steering queue | Solo project |
| Delegation tool (`src/tools/delegate.ts`) | Self-registering `delegate_task` tool under the `"delegation"` toolset. Accepts a single `goal` string or a `tasks` array and spawns independent child agent loops via `runTurn` — each child gets its own `IterationBudget` (50 steps), `AbortController`, and empty message history. Children run in batches of 3 (`MAX_CONCURRENT_CHILDREN`) via `Promise.all`. Leaf children (default) receive every standard toolset except `"delegation"`; orchestrator children at depth below the cap (2) also receive `"delegation"`. Parent abort propagates to all running children via a forwarding event listener. Emits `subagent_start`/`subagent_end` events through `context.emit`. `delegate_task` is listed in `NEVER_PARALLEL_TOOLS` so the turn loop never issues two concurrent delegation calls | Solo project |
| Memory store (`src/persistence/memoryStore.ts`) | Prepared-statement wrapper around the shared SQLite connection: `save(content, category)` inserts a UUID-keyed memory row; `search(query, limit?)` returns case-insensitive LIKE matches newest-first (with `rowid DESC` as tiebreaker for same-millisecond inserts); `recent(limit?)` returns the most recent memories; `all()` returns all memories in ascending creation order; `delete(id)` removes a memory and reports whether it existed; `update(id, content, category)` rewrites a row via `UPDATE … RETURNING` so the returned `Memory` carries the original `created_at`; `runInTransaction(fn)` wraps the callback in a SQLite transaction; `formatMemoriesForPrompt` formats a list for system-prompt injection, returning `null` for empty lists. Categories: `"preference"`, `"fact"`, `"project"` | Solo project |
| Note store (`src/persistence/noteStore.ts`) | FTS5 and vector-search prepared-statement wrapper around the shared SQLite connection (Phases 26–27): `importFolder(folderPath, chunkWords?)` reads `.md`/`.txt` files from the top-level directory, splits content into word chunks (default 500 words), and inserts each chunk inside a single transaction; `search(query, limit?)` sanitizes the query (strips FTS5 syntax characters), runs a `MATCH` query against `notes_fts` with `snippet()` extraction, and returns ranked results with `sourcePath` and `snippet` fields; Phase 27 adds `storeVector(noteId, embedding)`, `searchSemantic(queryVector, limit?)`, `importFolderWithEmbeddings(folderPath, embedFn, chunkWords?)`, and `backfillEmbeddings(embedFn)` against the `notes_vec` sqlite-vec virtual table (`embedding FLOAT[384]`), plus an `EmbedFn` type. The `notes_fts` virtual table is kept in sync by three database triggers (insert/delete/update) defined in the schema migration | Solo project |
9: Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance. See `docs/adr/0013-command-risk-gate-and-smart-approval.md` for the Phase 21 risk-gate design, `docs/adr/0014-mcp-client-support.md` for the Phase 24 MCP client, `docs/adr/0014-persistent-memory.md` for the Phase 25 memory design, `docs/adr/0014-advisor-passive-second-model.md` for the Phase 34 advisor design, `docs/adr/0015-skills-system.md` for the Phase 28 skills system design, `docs/adr/0016-ansi-first-ui-design-system.md` for the Phase 35 shared ANSI design system, `docs/adr/0016-delegate-task-subagent-spawning.md` for the Phase 31 delegation design, `docs/adr/0026-notes-fts5-search.md` for the Phase 26 FTS5 notes search design, and `docs/adr/0027-semantic-note-search.md` for the Phase 27 semantic note search design.
| Extension types (`src/extensions/types.ts`) | Shared typed contracts: discriminated `ExtensionEvent` union (`tool_call`, `tool_result`, `session_start`, `session_shutdown`, `input`), per-event conditional handler return types, `ExtensionAPI` (the surface extension factories receive), `ExtensionRegisteredTool`, cancellation-aware `ExtensionContext` (`sessionId` plus scoped `signal`), and `ExtensionFactory`; no I/O | Solo project |
| Extension runner (`src/extensions/runner.ts`) | `createExtensionRunner()` dispatches lifecycle events: fail-closed `emitToolCall` (throws propagate to the call-site error boundary; first `block:true` return short-circuits remaining handlers), error-isolated `emitToolResult` (per-handler try/catch; later-wins override accumulation for content/isError), error-isolated `emitInput` (`"transform"` rewrites text/images for subsequent handlers; `"handled"` skips the agent entirely), and observer `emitSessionStart`/`emitSessionShutdown` (per-handler try/catch; errors reported, not propagated) | Solo project |
| Extension loader (`src/extensions/loader.ts`) | `loadExtensions(runner, options)` scans project-local `.railgun/extensions/` (when `trusted`) then `~/.railgun/extensions/`, importing `.ts`/`.js` files and subdirectories with `index.ts`/`index.js` via `import(pathToFileURL(...))` — dynamic import is required because module paths are runtime-discovered; per-module errors are isolated and do not stop loading; `registerExtensionTools(runner, registry, sessionId)` inserts loaded tool definitions into the core registry under `toolset: "extension"`; `createExtensionAPI(runner, source)` is exported so the MCP bootstrap can create an `ExtensionAPI` programmatically without going through the filesystem loader | Solo project |
| MCP client (`src/extensions/mcp/`) | Programmatic built-in extension that connects to external MCP servers configured via `mcpServers` in `~/.railgun/config.json`. `connection.ts` spawns each server via stdio, handshakes JSON-RPC (`initialize` → `notifications/initialized` → `tools/list`), retains its shorter RPC limits (10 s for handshake/list, 30 s for tool calls), observes the enclosing extension operation signal, and rejects all pending RPCs if the child exits unexpectedly. `naming.ts` produces collision-safe `mcp__<server>__<tool>` names. `index.ts` runs connections via `Promise.allSettled`, registers discovered tools, and returns a `close()` handle that kills child processes | Solo project |
6: | CLI entry (`src/cli.ts`) | Pure argv parsing plus injectable dispatch for `config`, `login`, `logout`, `cron`, `import-notes`, `dream`, fresh REPL, exact/interactive resume, session listing, stateless one-shot, headless RPC, and ACP server modes; config/auth/cron/import commands return before SQLite/session/TUI boundaries | Solo project — no formal ownership split |
7: | Tool registry (`src/tools/registry.ts`) | `createToolRegistry()` factory closing over a `Map<name, RegisteredTool>`; `ToolContext` carries the run-scoped `signal`, required `commandApprovalMode` and `sessionApprovals` fields for the risk gate, optional `devin`/`reviewerModel` for smart-approval LLM calls, optional `clarifyCallback` (`ClarifyCallback`), optional `memoryStore` (`MemoryStore`) for the `memory_write`/`memory_search` tools, optional `noteStore` (`NoteStore`) for the `note_search` and `note_search_semantic` tools, optional `advisoryContext?: AdvisoryContext` that is present only during advisor tool execution, optional `model`/`contextWindow`/`delegationDepth` fields forwarded from `RunTurnOptions` so delegate-tool children inherit session configuration, and optional `emit?: (event: AgentEvent) => Promise<void>` giving tool handlers access to the parent turn's event sink (used by `delegate_task` for `subagent_start`/`subagent_end`); `run` refuses already-aborted work, dispatches handlers, and converts unknown names or thrown failures into error results | Solo project |
8: | Built-in tools (`src/tools/{readFile,writeFile,listDirectory,runShell,todo,clarify,memory,noteSearch,noteSearchSemantic,memoryConsolidate,cron,delegate}.ts`) | Twelve self-registering tools: file I/O, caller-owned todo planning, `run_shell_command`, `clarify`, `memory_write`, `memory_search`, `memory_consolidate`, `note_search`, `note_search_semantic`, `cron`, and `delegate_task`; shell execution is routed through `checkCommandApproval` first — hardline-blocked commands return immediately as errors, safe commands execute directly, and dangerous commands go through configurable approval (manual y/n prompt, LLM smart review, or off); approved dangerous patterns are added to the per-session `sessionApprovals` set so the same class does not re-prompt within one conversation; the shell child is detached into a POSIX process group, sent `SIGTERM` on abort, then `SIGKILL` after a two-second grace period; `clarify` routes a question (with optional up-to-4 choices) to the injected `ClarifyCallback` and returns `{ question, answer }` JSON; memory tools read/write the `MemoryStore` injected via `ToolContext`; `note_search` performs FTS5 full-text search over imported notes via `NoteStore` injected via `ToolContext`; `note_search_semantic` performs embedding-based semantic search over the same notes via `NoteStore` injected via `ToolContext`; the self-registering `advise` tool (toolset `"advisory"`) is available only when `advisoryContext` is present on `ToolContext` — three emission guards (content-free phrase suppression, per-run dedupe, one-note-per-update rate limit) keep it quiet; all severities are routed through the steering queue | Solo project |
| Delegation tool (`src/tools/delegate.ts`) | Self-registering `delegate_task` tool under the `"delegation"` toolset. Accepts a single `goal` string or a `tasks` array and spawns independent child agent loops via `runTurn` — each child gets its own `IterationBudget` (50 steps), `AbortController`, and empty message history. Children run in batches of 3 (`MAX_CONCURRENT_CHILDREN`) via `Promise.all`. Leaf children (default) receive every standard toolset except `"delegation"`; orchestrator children at depth below the cap (2) also receive `"delegation"`. Parent abort propagates to all running children via a forwarding event listener. Emits `subagent_start`/`subagent_end` events through `context.emit`. `delegate_task` is listed in `NEVER_PARALLEL_TOOLS` so the turn loop never issues two concurrent delegation calls | Solo project |
| Memory store (`src/persistence/memoryStore.ts`) | Prepared-statement wrapper around the shared SQLite connection: `save(content, category)` inserts a UUID-keyed memory row; `search(query, limit?)` returns case-insensitive LIKE matches newest-first (with `rowid DESC` as tiebreaker for same-millisecond inserts); `recent(limit?)` returns the most recent memories; `all()` returns all memories in ascending creation order; `delete(id)` removes a memory and reports whether it existed; `update(id, content, category)` rewrites a row via `UPDATE … RETURNING` so the returned `Memory` carries the original `created_at`; `runInTransaction(fn)` wraps the callback in a SQLite transaction; `formatMemoriesForPrompt` formats a list for system-prompt injection, returning `null` for empty lists. Categories: `"preference"`, `"fact"`, `"project"` | Solo project |
| Note store (`src/persistence/noteStore.ts`) | FTS5 and vector-search prepared-statement wrapper around the shared SQLite connection (Phases 26–27): `importFolder(folderPath, chunkWords?)` reads `.md`/`.txt` files from the top-level directory, splits content into word chunks (default 500 words), and inserts each chunk inside a single transaction; `search(query, limit?)` sanitizes the query (strips FTS5 syntax characters), runs a `MATCH` query against `notes_fts` with `snippet()` extraction, and returns ranked results with `sourcePath` and `snippet` fields; Phase 27 adds `storeVector(noteId, embedding)`, `searchSemantic(queryVector, limit?)`, `importFolderWithEmbeddings(folderPath, embedFn, chunkWords?)`, and `backfillEmbeddings(embedFn)` against the `notes_vec` sqlite-vec virtual table (`embedding FLOAT[384]`), plus an `EmbedFn` type. The `notes_fts` virtual table is kept in sync by three database triggers (insert/delete/update) defined in the schema migration | Solo project |
9: Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance. See `docs/adr/0013-command-risk-gate-and-smart-approval.md` for the Phase 21 risk-gate design, `docs/adr/0014-mcp-client-support.md` for the Phase 24 MCP client, `docs/adr/0014-persistent-memory.md` for the Phase 25 memory design, `docs/adr/0014-advisor-passive-second-model.md` for the Phase 34 advisor design, `docs/adr/0015-skills-system.md` for the Phase 28 skills system design, `docs/adr/0016-ansi-first-ui-design-system.md` for the Phase 35 shared ANSI design system, `docs/adr/0016-delegate-task-subagent-spawning.md` for the Phase 31 delegation design, `docs/adr/0026-notes-fts5-search.md` for the Phase 26 FTS5 notes search design, and `docs/adr/0027-semantic-note-search.md` for the Phase 27 semantic note search design.
| Advisory context (`src/advisor/advisoryContext.ts`) | Shared `AdvisoryContext` type carrying `steer`, `appendToPrimary`, `dedupe: Set<string>`, and `notesThisUpdate: number` — the guard state threaded from `AdvisorRuntime` into each review; `notesThisUpdate` is review-scoped while `dedupe` is shared across the current run | Solo project |
| Advisor runtime (`src/advisor/advisor.ts`) | `createAdvisorRuntime(devin, config, memoryStore?, noteStore?)` owns per-agent advisor history plus run-scoped cursor, intervention, and dedupe state; `seedFrom(messages)` advances the cursor past pre-existing history and resets the one-steer allowance and dedupe set; `onPrimaryTurnEnd` formats the new-message delta via `formatDeltaForAdvisor`, runs a 3-iteration mini tool-use loop against the advisor model with `read_file`, `list_directory`, `advise`, `memory_search`, and `note_search` available (enforced at both schema and execution level via `ADVISOR_ALLOWED_TOOLS`; `memory_search` and `note_search` use the optional `memoryStore`/`noteStore` passed at construction, enabling the advisor to detect responses that contradict known user facts or preferences), and swallows all errors so advisor failure is never fatal to the primary turn | Solo project |
| Todo store (`src/tools/todo.ts`) | Pure normalization/reducer logic plus a tiny stateful `createTodoStore()` boundary. Todos are flat, ordered by priority, globally deduplicated by id (last-occurrence-wins), bounded to 256 total items, truncate content above 4000 chars, normalize bad status to `pending`, coerce malformed items to placeholders, support partial-field merge-by-id, and expose `formatForInjection()` for pending/in-progress work only | Solo project |
| Tool activity labels (`src/tools/toolLabel.ts`) | Pure `buildToolLabel(name, args)` — turns a dispatched call's name+args into a one-line verb-based label (`"Reading <path>"`, `"Running <command>"`) via each tool's registered `verb`/`previewArgKey`, falling back to raw name+JSON for unlabeled/unregistered tools; whitespace-collapsed and truncated to 60 chars | Solo project |
| Skills system (`src/skills.ts`) | `discoverSkills(dir)` recursively scans `~/.railgun/skills/` synchronously at session build time — directories containing `SKILL.md` are treated as skill roots (recursion stops there); plain `.md` files at any level are also valid single-file skills. Each file is parsed for YAML frontmatter (`name`, `description`, `disable-model-invocation`) using the `yaml` package; invalid names (must match `/^[a-z0-9-]{1,64}$/`) or missing descriptions are rejected with `[skills]`-prefixed warnings. `buildSkillIndex` deduplicates by first-loaded-wins. `formatSkillsForPrompt` produces the `<available_skills>` XML block injected into the system prompt (skills with `disable-model-invocation: true` are excluded). `expandSkillCommand` parses `/skill:<name> [args]` and returns a discriminated union `{ kind: "expanded"; content: string } \| { kind: "error"; message: string } \| null`; descriptions and paths are XML-attribute-escaped. | Solo project |
| Skill view tool (`src/tools/skillView.ts`) | Self-registering `skill_view` tool under the `"skills"` toolset; called by the model to load a named skill's full instruction body. Holds a module-level index populated once per session via `setSkillIndex(index)` — a setter exported through `src/tools/index.ts` and called by `buildSessionCore` before session construction completes. | Solo project |
| Cron tool (`src/tools/cron.ts`) | Self-registering `cron` tool under the `"cron"` toolset; single `action` discriminator (`list`, `add`, `remove`, `update`) manages `~/.railgun/cron/jobs.json` via `loadJobs`/`saveJobs`/`validateJob` from `src/cron/jobs.ts`. Reads/writes the jobs file directly — no new persistence layer. Enabled in both `ENABLED_TOOLSETS` (root agent) and `LEAF_TOOLSETS` (subagents). `CronJobsError` messages are returned as `isError: true` without re-throwing. | Solo project |
| Arg helper (`src/tools/args.ts`) | Single exported `extractString(args, key)` — extracts a non-empty string value from a loosely-typed tool args object. Shared by `memory.ts`, `noteSearch.ts`, `noteSearchSemantic.ts`, and `cron.ts` to replace four identical local copies. | Solo project |
| Checkpoint manager (`src/checkpoint.ts`) | Shadow-git checkpoint system: `shadowGitDir` derives a per-project path under `~/.railgun/checkpoints/<cwd-hash>/`, `ensureShadowRepo` idempotently initializes a non-bare git repo there, `snapshot` stages and commits the full working tree before the first file-mutating tool call each turn, `rollback` restores it via `git checkout HEAD -- .`; `createCheckpointGuard` wraps these into a per-turn guard (`beforeMutation` snapshots once then no-ops; `resetTurn` re-arms) threaded through `ToolContext` → `RunTurnOptions` → `AgentDependencies` | Solo project |
| Theme system (`src/repl/theme.ts`) | Immutable exact mint-light/mint-dark semantic palettes plus a `ThemeController` around `os-theme`; terminal-over-OS resolution, live terminal events, OS-event terminal re-query, deduplication, failure fallback, and resource cleanup | Solo project |
| UI design system (`src/ui/palette.ts`, `src/ui/theme.ts`) | Shared cross-renderer design tokens and ANSI styling layer (Phase 35). `palette.ts` exports JSON-serializable `Palette`/`ThemeMode` types, `palettes` (dark + light hex values mirroring `src/repl/theme.ts`'s `THEMES`), and `glyphs` (tool-state and navigation characters). `theme.ts` exports `createAnsiTheme(mode)` which wraps each palette color in a zero-dependency truecolor ANSI styler (`\u001b[38;2;R;G;Bm`/`\u001b[48;2;R;G;Bm`); the returned `AnsiTheme` object exposes named styling functions (`accent`, `dim`, `error`, …), composite helpers (`toolCallLabel`, `toolCallPrefix`, `streamingCursor`, `thinkingIndicator`, `unseenPill`), and `ToolCallState`. The exported `rgb` helper is shared with `src/repl/markdown.ts`. `src/repl/theme.ts` is NOT modified — the Ink REPL continues consuming raw hex strings via Ink props. See ADR 0016. | Solo project |
| Viewport/composer/lifecycle (`src/repl/{viewport,composer,lifecycle,mouse,terminalSize}.ts`) | Pure viewport and composer actions, SGR mouse parsing, shared resize observation, and guaranteed alternate-screen/mouse-mode boundaries; resize preserves prior bottom-follow state and unseen cues reserve a rendered row | Solo project |
| Streaming transcript (`src/repl/streamingTranscript.ts`) | Pure segment state that accumulates deltas, flushes narration before tools and queued-user injection, and returns only the uncommitted final/aborted assistant suffix | Solo project |
  | Command system (`src/commands.ts`) | Pure `/exit`, `/help`, `/clear`, `/model`, `/settings`, `/compact`, `/rollback`, `/trust`, `/moa`, `/branch`, `/fork`, `/dream`, and `/cron` matching, parsing, and tab/escape completion state; no I/O or React | Solo project |
  | Trust gate (`src/trust.ts`) | `TrustChoice` (`"trust" \| "trust-session" \| "deny"`), `TrustDecision`, `ProjectTrustStore` types; `createProjectTrustStore` (ancestor-walk resolution, sync DI for path/readFile/writeFile, persists to `TRUST_PATH` via `writeFileSync` with mode `0600`); `resolveProjectTrust` (resolution order: CLI flags → config default → persisted store → interactive prompt); `promptTrustChoiceReadline` (raw-mode stdin arrow-key selector on stderr — Trust / Trust (this session only) / Do not trust — fires before Ink starts); `assertProjectTrustedForRead`/`assertProjectTrustedForInstall` guards (not yet called — reserved for Phases 23/28) | Solo project |
  6. Slash commands are handled before agent dispatch. `/settings` opens nested AI configuration pickers; `/trust`, bare `/moa`, and bare `/branch` use the shared Up/Down/Enter/Escape selector, while explicit arguments remain supported. `/compact` replaces history with its compacted form and checkpoints it, `/rollback` restores the last shadow-git snapshot, and `/fork` copies the active branch into a new session, and `/cron [add|remove]` manages scheduled jobs via `loadJobs`/`saveJobs` from `src/cron/jobs.ts` — `setBusy` guards the async I/O.
| Markdown (`src/repl/markdown.ts`) | `markdansi` adapter for wrapped GFM replies, links, tables, lists, and mint-themed fenced code boxes; called only for completed assistant text. Imports `rgb` from `src/ui/theme.ts` (shared helper, no behavioral change from the former inline copy). | Solo project |
| Suggestions (`src/repl/Suggestions.tsx`) | Pure themed Ink component rendering slash-command matches and selection | Solo project |
| Session chooser (`src/repl/SessionChooser.tsx`) | Full-screen, live-themed, resize-aware startup selector for bare `--resume`/`-r`; shared synchronous input state preserves rapid navigation before Enter, Up/Down wraps, and Escape/Ctrl-C cancels before Devin initialization | Solo project |
| Model chooser (`src/repl/ModelChooser.tsx`) | Full-screen missing-model recovery for interactive fresh sessions; reuses the session chooser's input state and pure input/window helpers plus the alternate-screen/theme lifecycle while rendering model-specific capability rows; exports `resolveModelCommand` (pure command parser returning show/switch/error) and `ModelRow` for inline REPL `/model` picker | Solo project |
| Ink REPL (`src/repl/App.tsx`) | Full-height multi-turn UI with repaintable transcript, sticky todos/approval/suggestions/composer, viewport history, Markdown completion rendering, tool feedback, persistence hydration/checkpoint hooks, shared arrow-key selectors for settings/trust/MOA/branch/clarification, live model switching, persisted MOA startup activation, advisor severity rows, status segments, and MoA reference/aggregation progress events | Solo project |
| Skills slash command (`src/repl/App.tsx` — `/skill:`) | `/skill:<name> [args]` is handled in the slash-command block before agent dispatch. `expandSkillCommand` is called with the active session's `skillIndex`; an `"error"` result shows a red error line; an `"expanded"` result rewrites `text` and falls through to the normal agent turn, sending the expanded `<skill>` XML as the user message. An unrecognised `/skill:` pattern (e.g., `/skill:` alone) returns `null` and is a no-op. The `/help` command output lists `/skill:<name>`. | Solo project |
| Status line helpers (`src/repl/statusLine.ts`) | Pure `formatCwd(cwd)` (homedir → `~` shortening) and async `getGitStatus(cwd)` (branch name + dirty detection via `execFile("git", ...)`) — consumed once on mount by `App.tsx`'s status bar; returns `{ branch: null, dirty: false }` outside a git repo or on any `git` error | Solo project |
| One-shot terminal spinner (`src/spinner.ts`) | `startSpinner(label)` writes a cycling braille frame to `process.stderr` on an interval and returns a `stop(isError)` closure that clears it and writes a final `✔`/`✘` line — the one-shot path's stderr-only equivalent of the REPL's `ink-spinner` line; `oneShot.ts` tracks at most one animated spinner slot at a time (per-call `tool_execution_start`/`tool_execution_end` events since Phase 18), falling back to a static, non-animated log line plus a manually-written `✔`/`✘` line for any additional concurrent call | Solo project |
| Threat pattern scanner (`src/security/threatPatterns.ts`) | Pure, id-tagged regex list (`CONTEXT_THREAT_PATTERNS`, 10 curated patterns covering prompt injection, role hijack, HTML hidden-element injection, system-prompt leak, and safety-bypass phrasing) plus `scanForThreats(content)` returning matched pattern ids; no I/O, bounded filler `(?:\w+\s+){0,8}` prevents catastrophic backtracking | Solo project |
| Command risk classifier (`src/security/commandApproval.ts`) | Pure `checkCommandApproval(command, mode, sessionApprovals)` returning one of three `ApprovalRequirement` variants: `forbidden` (5 hardline patterns — always blocked regardless of mode), `skip` (no match, already session-approved, or mode `"off"`), or `needs_approval` (7 dangerous patterns in manual/smart mode); exports `stripShellComments` to remove `# …` comment tails while respecting single/double quoting — used by the smart reviewer to reduce prompt-injection surface | Solo project |
| Smart approval reviewer (`src/security/smartApproval.ts`) | `smartApprove(devin, reviewerModel, command, flagReason)` sends the comment-stripped command plus flag reason to a Devin LLM call with a security-reviewer system prompt and parses the response as `"approve" \| "deny" \| "escalate"`; fail-safe: any error or unparseable response returns `"escalate"` so the human prompt is never silently skipped on failure | Solo project |
| Project context loader (`src/agent/projectContext.ts`) | Discovers and loads a project's context file (`.railgun.md`/`RAILGUN.md` walking to the git root, falling back to `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, `.cursorrules` in cwd only — first readable non-empty file wins, with case-variant aliases exhausted per directory before walking up or moving to the next candidate group), plus `~/.railgun/SOUL.md` as persistent identity; truncates with a 70/30 head/tail split at 20 000 chars, then scans the retained head and tail independently for injection via `scanForThreats` (blocked files produce a `[BLOCKED: ...]` placeholder that does not fall through to the next candidate); exports `loadProjectContext(cwd)` and `loadSoulIdentity()` | Solo project |

| Dream job (`src/dream/dreamJob.ts`) | `runDreamSession(memoryStore, devin, model, log?)` runs a bounded 30-step agent session whose sole available toolset is `"dream"` plus `"file"`. It loads all stored memories via `memoryStore.all()`, skips if fewer than 5 exist, reads current `SOUL.md` content via `loadSoulIdentity()`, and feeds both to the agent as a structured user message. The `DREAM_SYSTEM_PROMPT` instructs the agent to (Phase 1) consolidate memories via `memory_consolidate` and (Phase 2) promote stable `"preference"` memories to `~/.railgun/SOUL.md` via `write_file`, deleting promoted entries from the store. Triggered by `railgun dream` (CLI) or `/dream` (REPL slash command). | Solo project |
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
   present — a `# Persistent Identity` block, a `# Project Context` block,
   and (since Phase 25) a `# Memories` block containing the 20 most recent
   memories loaded via `MemoryStore.recent(20)` and formatted by
   `formatMemoriesForPrompt`. The date is captured from local calendar fields rather
   than UTC serialization, and every environment value is JSON-serialized
   before insertion into the prompt so paths or model ids containing
   control characters cannot create extra system-prompt instructions.
3. `runOneShot` reads `~/.railgun/config.json` to extract `approvalMode` and
   (optionally) `reviewerModel`; if `advisor.enabled` is `true` and `advisor.model` is set (`isAdvisorActive`), `{ advisor: { model } }` is forwarded to `createAgentSession`/`createAgent`, which wires an `AdvisorRuntime` via the `onTurnEnd` hook. `runOneShot` also creates a fresh in-memory `TodoStore` and a
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
   The `--print` branch opens the session database (as of Phase 25, to load
   memories via `withStores`) but never writes session rows.
2. `--list-sessions` opens `createSessionStore`, calls `listSessions`, prints
   the detailed newest-first table (or `No saved sessions.`), and closes the
   store without calling `initDevinSession`.
3. Direct `--resume <id>`/`-r <id>` calls `loadSession(id)`. Bare `--resume`/`-r` first calls
   `listSessions`; an empty result exits successfully, otherwise
   `runSessionChooser` renders the Ink selector. Up/Down wraps the highlight,
   Enter returns the selected ID, and Escape/Ctrl-C returns no selection. The
   CLI awaits this result before any Devin login or model discovery.
4. A confirmed resume opens `createSessionStore`, creates a `MemoryStore` on the shared
   `db` handle, loads `recent(20)` memories, and passes the formatted `memoriesText`
   to `initDevinSession(saved.model, memoriesText)`. For all three session-starting
   modes (fresh, resume, one-shot/print), trust resolution runs before session or
   database initialization. The exact model is required; Railgun never silently switches
   an old conversation to another model. `runRepl` receives the complete saved messages,
   normalized todos, immutable session metadata, and the full-snapshot checkpoint callback.
   The system prompt, project context, persistent identity, memories, current directory,
   and 90-step budget are rebuilt for the new process rather than loaded from SQLite.
5. Missing IDs, corruption, database errors, and unavailable saved models
   propagate to the top-level error handler and exit nonzero. Store closure is
   guaranteed by `dispatchCli`'s shared `withStores`/`finally` boundary on
   success, cancellation, and failure.

**Configuration (`config` and fresh-session model selection):**

1. Exact `config` dispatch calls `loadConfig` and prints two-space JSON before
   authentication, SQLite, filesystem creation, or Ink initialization.
2. Missing `config.json` returns the effective model, trust, and 600000ms
   operation-timeout defaults. Existing object roots are
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
   `approvalMode` and `reviewerModel` state; `advisorModel` state (`string | undefined`) is also loaded from config on mount and forwarded to `createAgentSession` when set, enabling the advisor for that session; this is fire-and-forget with a
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
  | Command system (`src/commands.ts`) | Pure `/exit`, `/help`, `/clear`, `/model`, `/settings`, `/compact`, `/rollback`, `/trust`, `/moa`, `/branch`, `/fork`, `/dream`, and `/cron` matching, parsing, and tab/escape completion state; no I/O or React | Solo project |
  | Trust gate (`src/trust.ts`) | `TrustChoice` (`"trust" \| "trust-session" \| "deny"`), `TrustDecision`, `ProjectTrustStore` types; `createProjectTrustStore` (ancestor-walk resolution, sync DI for path/readFile/writeFile, persists to `TRUST_PATH` via `writeFileSync` with mode `0600`); `resolveProjectTrust` (resolution order: CLI flags → config default → persisted store → interactive prompt); `promptTrustChoiceReadline` (raw-mode stdin arrow-key selector on stderr — Trust / Trust (this session only) / Do not trust — fires before Ink starts); `assertProjectTrustedForRead`/`assertProjectTrustedForInstall` guards (not yet called — reserved for Phases 23/28) | Solo project |
  6. Slash commands are handled before agent dispatch. `/settings` opens nested AI configuration pickers; `/trust`, bare `/moa`, and bare `/branch` use the shared Up/Down/Enter/Escape selector, while explicit arguments remain supported. `/compact` replaces history with its compacted form and checkpoints it, `/rollback` restores the last shadow-git snapshot, and `/fork` copies the active branch into a new session, and `/cron [add|remove]` manages scheduled jobs via `loadJobs`/`saveJobs` from `src/cron/jobs.ts` — `setBusy` guards the async I/O.

**RPC mode path (`railgun --mode rpc`):**

1. `src/cli.ts` parses `--mode rpc` into `{ kind: "rpc" }`; `dispatchCli` calls `dependencies.initSession()` for the authenticated `DevinSession`, `dependencies.loadConfig()` for `AppConfig`, `bootstrapExtensions("rpc")` to prime extensions, emits `session_start`, and then calls `dependencies.runRpc({ session, config, stdin: process.stdin, stdout: process.stdout, extensionRunner })`.
2. `runRpcMode` initializes mutable per-process state from the session: `currentModel` is `session.model.id`, `history` starts as an empty `DevinMessage[]`, `todoStore` is created with `createTodoStore()`, and `sessionApprovals` is a fresh `Set<string>`. No `SessionStore` is opened.
3. `makeLineReader(stdin, handleLine)` attaches to `process.stdin` and splits incoming bytes on the literal `\n` byte (`0x0a`) only, so Unicode line separators `U+2028`/`U+2029` do not split frames. Each non-empty line is parsed as JSON and dispatched synchronously through `dispatch(cmd)`.
4. `prompt`: if `run.current` is already set, the command responds immediately with an `agent is already running` error. Otherwise `makeSession()` creates a fresh `AgentSession` via `createAgentSession` with `confirmShellCommand` always returning `true` and `clarifyCallback` throwing; the session is subscribed to serialize every `AgentSessionEvent` directly to stdout as raw JSONL. `agentSession.run({ text, history })` is started fire-and-forget and stored in `run.current`. Its `.then()` merges `outcome.messages` into `history` on success or abort and writes the prompt's correlated `response`; `.catch()` writes an error response for unexpected exceptions; `.finally()` clears `run.current`.
5. `steer` and `follow_up` call `run.current.session.steer(message)` or `followUp(message)` synchronously and respond immediately; if no run is in-flight the dispatch catches the thrown error and returns it as the command's error response.
6. `abort` calls `run.current.session.abort()` when a run exists and responds immediately with success.
7. `get_state`, `get_messages`, and `set_model` are handled synchronously (`get_state` returns `running`, `model`, `messageCount`, and `todos`; `get_messages` returns the accumulated `history`; `set_model` updates `currentModel`). `get_available_models` and `compact` are fire-and-forget async promises that respond when `session.devin.listModels()` or `runCompaction()` resolve; `set_auto_compaction` acknowledges the command and no-ops.
8. The function returns a `Promise` that resolves once stdin emits `"end"` or `"close"`. `Promise.withResolvers` waits for either event; on receipt `cleanupLineReader()` detaches the data handler, any in-flight run is aborted and awaited, and `dispatchCli` emits `session_shutdown`.

**Desktop bootstrap (`pnpm dev` / `pnpm dev:mock`):**

1. Forge builds separate main, preload, and renderer targets. The window starts
   with context isolation and sandboxing enabled and Node integration disabled.
2. In development, Electron main starts either the root CLI through pnpm/tsx
   with `--mode rpc` or the stateful mock JSONL child. Forge packages a
   production-only deployment of the compiled root CLI and a bundled mock
   process under `Resources/backend`; the packaged app runs either asset with
   Electron's embedded Node runtime, so it does not depend on a source checkout,
   a system Node.js installation, or a system pnpm. Both paths use the same
   JSONL stdio boundary. A correlated `get_state` probe moves the snapshot from
   `starting` to `ready`; parse errors, rejected probes, timeouts, and exits
   become `failed` or `disconnected` snapshots.
3. Preload exposes only snapshot read/subscription and mock scenario
   list/selection. Renderer code has no generic IPC, filesystem, process, or
   Node access. Diagnostics and transport logs are bounded in main.
4. Mock scenarios live in one typed registry and include ready/idle, delayed
   startup, rejection, malformed output, crash-before-ready, and
   disconnect-after-ready. Selecting a scenario terminates and replaces the
   child, and generation checks discard late events from the old process.

`toolcall_delta` and `toolcall_end` events together drive
`src/agent/turn.ts`'s tool-calling loop in both paths (Phase 5 added
`toolcall_delta` buffering; before that it was ignored). `usage` events are
captured by both paths since Phase 16 to drive proactive context
compaction (`shouldCompact`/`runCompaction`, `src/agent/compaction.ts`).
`thinking_delta` and `toolcall_start` are forwarded by `turn.ts` as
`message_update` events (since Phase 18) but still ignored by both
consumers (reasoning display is a later phase; live tool-call feedback
shipped in Phase 7 via `LoopCallbacks`, replaced in Phase 18 by a typed
`AgentEvent`/`AgentSessionEvent` stream — see ADR-0012). Both paths enable the exact same toolsets (`"file"`, `"terminal"`, `"planning"`, `"clarify"`, `"extension"`, `"memory"`, `"skills"`, and `"delegation"`) — the only behavioral difference between them is how `confirmShellCommand` collects the y/n answer and how `clarifyCallback` surfaces questions to the user (Ink `useInput`/`useState` in the REPL vs. blocking `readline` on stdin in one-shot mode), and how tool activity renders (an `ink-spinner` line + scrollback vs. a stderr braille spinner via `src/spinner.ts`). They also differ in budget lifetime: the REPL has one shared 90-step budget and one shared todo store for the process lifetime, while each one-shot invocation gets a fresh 90-step budget and fresh todo store.

**ACP mode path (`railgun --mode acp`):**

1. `src/cli.ts` parses `--mode acp` into `{ kind: "acp" }`; `dispatchCli` calls `dependencies.initSession()`, `dependencies.loadConfig()`, `bootstrapExtensions("acp")`, emits `session_start`, and calls `dependencies.runAcp({ session, config, stdin: process.stdin, stdout: process.stdout, extensionRunner })`.
2. `runAcpMode` calls `createAcpApp` to build an `AgentApp`, then wraps `process.stdin`/`process.stdout` as web streams via `Readable.toWeb`/`Writable.toWeb`, creates an ndjson transport via `ndJsonStream(output, input)`, and connects with `agentApp.connect(stream)`. The function returns once `connection.closed` resolves (client disconnects or stdin EOF).
3. `createAcpApp` registers five request handlers and one notification handler. `initialize` returns protocol version 1, `loadSession: false` capability, and agent info. `authenticate` and `session/set_mode` are no-ops returning empty objects (authentication is handled internally; modes are not supported). `session/new` allocates a UUID session ID, creates an empty `{ history, activeRun }` entry in a `Map`, and returns the ID. `session/cancel` calls `agentSession.abort()` on the session's `activeRun` if one exists.
4. `session/prompt` is the load-bearing handler. It looks up the session by `params.sessionId` (throws a JSON-RPC error if not found, or if a prompt is already running). It extracts user text from `params.prompt` content blocks — `type: "text"` blocks are concatenated, `type: "resource"` blocks with text content are prefixed with `file:`. It creates a fresh `AgentSession` via `createAgentSession` with `confirmShellCommand` always returning `true` and `clarifyCallback` throwing. It subscribes to the session's event stream and translates events to `session/update` notifications via `ctx.client.notify(methods.client.session.update, ...)`: `message_update` with `text_delta` → `agent_message_chunk`; `tool_execution_start` → `tool_call` (with `mapToolKind` for the kind field); `tool_execution_end` → `tool_call_update` (status `"completed"` or `"failed"`). All other events are ignored. It then awaits `agentSession.run({ text, history })` and returns `{ stopReason: "end_turn" }` for `ok` outcomes, `{ stopReason: "cancelled" }` for aborted outcomes, and `{ stopReason: "end_turn" }` for error outcomes (the error is already surfaced as a `tool_call_update` with `status: "failed"`). On completion, `activeRun` is cleared.
5. Unlike RPC mode, ACP mode maintains per-session history independently — multiple named sessions can exist simultaneously within one `railgun --mode acp` process. Each `session/prompt` appends to its session's accumulated history. No `SessionStore` is opened; history is in-process only and lost when the process exits.
6. Shell commands are auto-approved (`confirmShellCommand` always returns `true`); `clarify` throws, surfacing as a tool error. Extensions are bootstrapped and lifecycle events emitted identically to RPC mode.

## Persistence

`getHomeDir()` fixes the application home at `~/.railgun`; config, token, state, SOUL, trust, extensions, cron, and skills paths are derived from it. `~/.railgun/skills/` is the user-global skills directory scanned at startup (see the skills system component above); it is never created by Railgun and silently returns no skills when absent. `config.json` is the single configuration source. Missing files use `{ "model": null, "defaultProjectTrust": "ask", "operationTimeoutMs": 600000 }`; the optional `mcpServers` key configures MCP servers (see MCP client component above); unknown fields are retained and model recovery writes two-space JSON with a trailing newline atomically.

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
applies: trusting `/a/b` implicitly trusts any subdirectory. The three
persisted/session choices are: `trust` (persist current dir), `trust-session`
(trusted for this process only, not written to disk), and `deny` (persist current dir).
The file is created lazily on the first persisted choice; a missing file means
no stored decisions. Both the trust store and
`assertProjectTrustedForRead`/`assertProjectTrustedForInstall` guards live in
`src/trust.ts`; the guards are not yet called in Phase 20 (reserved for Phases 23/28).

The session database,
`~/.railgun/state.db` (mode `0600`), stores interactive sessions, messages,
todo snapshots, user memories (Phase 25), FTS5-indexed imported notes (Phase 26) and sqlite-vec embedded notes (Phase 27, via the `notes`, `notes_fts`, and `notes_vec` tables). The messages table uses a
tree structure introduced in schema v2 (Phase 30) and extended to v3: messages
carry a `parent_id` self-reference and sessions carry `current_leaf_id`;
`loadSession` walks the chain from the current leaf to root via a single
recursive CTE. A `branch_summary` message role is used as a routing pivot
when branching with summarization; these rows are never returned as
conversation history. The database uses WAL, foreign keys, a busy timeout,
and a `MIGRATIONS` array for schema versioning: each migration runs inside a
transaction that bumps `user_version` atomically, so the version stamp and
schema changes are never split by a crash. Malformed saved state aborts
loading instead of being skipped. All session modes open this database to
load memories into the system prompt. See ADR 0006 and ADR 0014.

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
  resources loaded once those resources exist (Phase 23 for extensions; project-local
  skills gating is a future phase). CLI flags `--approve`/`-a` and `--no-approve`/`-na`
  bypass the persisted store for one invocation. `defaultProjectTrust: "always"` in
  `config.json` disables the gate globally (opt-in). The three-choice `/trust` REPL
  command lets users change the in-session decision.
- Skills content (`~/.railgun/skills/`) is user-authored Markdown read synchronously at
  session build time. Skill files are not scanned by `scanForThreats` — they are
  authored by the same user running the process, not untrusted third-party input. Only
  the `name` (regex-validated) and `description` (length-bounded) fields are validated;
  the body is passed verbatim to the model when `skill_view` is called or when
  `/skill:<name>` is used. Descriptions and file paths interpolated into XML attributes
  are escaped (`&`, `"`, `<`, `>` → `&amp;`/`&quot;`/`&lt;`/`&gt;`) to prevent
  malformed `<available_skills>` output in the system prompt.
- Compliance is an operational responsibility, not a code-enforced one — see
  `docs/adr/0001-single-provider-devin-via-widevin.md`.
- Extension code (`~/.railgun/extensions/` and `.railgun/extensions/`) runs as untrusted user-supplied JavaScript or TypeScript with the same OS process privileges as Railgun itself. There is no sandbox, capability restriction, or code signing. `tool_call` handlers can block built-in tools; all handlers run before the answer is delivered to the model. Project-local extensions are not yet trust-gated — they load unconditionally when `trusted: true` is passed (the current hardcoded default). See `docs/adr/0013-extension-system.md`.
- MCP server processes are spawned as ordinary child processes with the configured `command`/`args`/`env` and the caller's inherited environment. They run with the same OS privileges as Railgun. There is no sandbox or capability restriction on what an MCP server can do. Only configure servers you trust. Child processes are killed (`process.kill()`) in `try/finally` on session shutdown; a server that exits before `close()` rejects pending RPC calls rather than hanging. See `docs/adr/0014-mcp-client-support.md`.

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
  the compiled `dist/` output, plus a private macOS Electron desktop workspace.
  It has no daemon, server, container, or remote persistence service.
- Node.js 22.19.0 or newer is required. Installation must provide a compatible
  `better-sqlite3` native binary (downloaded or built by pnpm) for the host
  platform.
- Runtime state lives under `~/.railgun/`; project context is rebuilt from the
  directory where each process is launched.
- The root `package.json` remains the publishable CLI manifest;
  `apps/desktop/package.json` is private. `pnpm-lock.yaml` is the sole dependency
  lockfile, and `pnpm-workspace.yaml` declares private apps and repository-wide
  dependency policy.
- Desktop `build` and `package` both use Forge's Vite pipeline. Before packaging,
  the desktop build compiles and deploys the root package's production runtime
  plus the mock backend into Forge resources; these runtime assets are separate
  from the root package's published-file contract.
- The workspace uses pnpm's hoisted linker because Forge's packaging preflight
  requires it, and workspace-package injection makes `pnpm deploy --prod`
  self-contained. Forge dependency pruning is disabled: with one hoisted
  workspace it can remove desktop development dependencies from the shared
  install, while the Vite plugin already limits the ASAR to bundled output.

## Architectural Decision Records

6: | CLI entry (`src/cli.ts`) | Pure argv parsing plus injectable dispatch for `config`, `login`, `logout`, `cron`, `import-notes`, `dream`, fresh REPL, exact/interactive resume, session listing, stateless one-shot, headless RPC, and ACP server modes; config/auth/cron/import commands return before SQLite/session/TUI boundaries | Solo project — no formal ownership split |
7: | Tool registry (`src/tools/registry.ts`) | `createToolRegistry()` factory closing over a `Map<name, RegisteredTool>`; `ToolContext` carries the run-scoped `signal`, required `commandApprovalMode` and `sessionApprovals` fields for the risk gate, optional `devin`/`reviewerModel` for smart-approval LLM calls, optional `clarifyCallback` (`ClarifyCallback`), optional `memoryStore` (`MemoryStore`) for the `memory_write`/`memory_search` tools, optional `noteStore` (`NoteStore`) for the `note_search` and `note_search_semantic` tools, optional `advisoryContext?: AdvisoryContext` that is present only during advisor tool execution, optional `model`/`contextWindow`/`delegationDepth` fields forwarded from `RunTurnOptions` so delegate-tool children inherit session configuration, and optional `emit?: (event: AgentEvent) => Promise<void>` giving tool handlers access to the parent turn's event sink (used by `delegate_task` for `subagent_start`/`subagent_end`); `run` refuses already-aborted work, dispatches handlers, and converts unknown names or thrown failures into error results | Solo project |
8: | Built-in tools (`src/tools/{readFile,writeFile,listDirectory,runShell,todo,clarify,memory,noteSearch,noteSearchSemantic,memoryConsolidate,cron,delegate}.ts`) | Twelve self-registering tools: file I/O, caller-owned todo planning, `run_shell_command`, `clarify`, `memory_write`, `memory_search`, `memory_consolidate`, `note_search`, `note_search_semantic`, `cron`, and `delegate_task`; shell execution is routed through `checkCommandApproval` first — hardline-blocked commands return immediately as errors, safe commands execute directly, and dangerous commands go through configurable approval (manual y/n prompt, LLM smart review, or off); approved dangerous patterns are added to the per-session `sessionApprovals` set so the same class does not re-prompt within one conversation; the shell child is detached into a POSIX process group, sent `SIGTERM` on abort, then `SIGKILL` after a two-second grace period; `clarify` routes a question (with optional up-to-4 choices) to the injected `ClarifyCallback` and returns `{ question, answer }` JSON; memory tools read/write the `MemoryStore` injected via `ToolContext`; `note_search` performs FTS5 full-text search over imported notes via `NoteStore` injected via `ToolContext`; `note_search_semantic` performs embedding-based semantic search over the same notes via `NoteStore` injected via `ToolContext`; the self-registering `advise` tool (toolset `"advisory"`) is available only when `advisoryContext` is present on `ToolContext` — three emission guards (content-free phrase suppression, per-run dedupe, one-note-per-update rate limit) keep it quiet; all severities are routed through the steering queue | Solo project |
| Delegation tool (`src/tools/delegate.ts`) | Self-registering `delegate_task` tool under the `"delegation"` toolset. Accepts a single `goal` string or a `tasks` array and spawns independent child agent loops via `runTurn` — each child gets its own `IterationBudget` (50 steps), `AbortController`, and empty message history. Children run in batches of 3 (`MAX_CONCURRENT_CHILDREN`) via `Promise.all`. Leaf children (default) receive every standard toolset except `"delegation"`; orchestrator children at depth below the cap (2) also receive `"delegation"`. Parent abort propagates to all running children via a forwarding event listener. Emits `subagent_start`/`subagent_end` events through `context.emit`. `delegate_task` is listed in `NEVER_PARALLEL_TOOLS` so the turn loop never issues two concurrent delegation calls | Solo project |
| Memory store (`src/persistence/memoryStore.ts`) | Prepared-statement wrapper around the shared SQLite connection: `save(content, category)` inserts a UUID-keyed memory row; `search(query, limit?)` returns case-insensitive LIKE matches newest-first (with `rowid DESC` as tiebreaker for same-millisecond inserts); `recent(limit?)` returns the most recent memories; `all()` returns all memories in ascending creation order; `delete(id)` removes a memory and reports whether it existed; `update(id, content, category)` rewrites a row via `UPDATE … RETURNING` so the returned `Memory` carries the original `created_at`; `runInTransaction(fn)` wraps the callback in a SQLite transaction; `formatMemoriesForPrompt` formats a list for system-prompt injection, returning `null` for empty lists. Categories: `"preference"`, `"fact"`, `"project"` | Solo project |
| Note store (`src/persistence/noteStore.ts`) | FTS5 and vector-search prepared-statement wrapper around the shared SQLite connection (Phases 26–27): `importFolder(folderPath, chunkWords?)` reads `.md`/`.txt` files from the top-level directory, splits content into word chunks (default 500 words), and inserts each chunk inside a single transaction; `search(query, limit?)` sanitizes the query (strips FTS5 syntax characters), runs a `MATCH` query against `notes_fts` with `snippet()` extraction, and returns ranked results with `sourcePath` and `snippet` fields; Phase 27 adds `storeVector(noteId, embedding)`, `searchSemantic(queryVector, limit?)`, `importFolderWithEmbeddings(folderPath, embedFn, chunkWords?)`, and `backfillEmbeddings(embedFn)` against the `notes_vec` sqlite-vec virtual table (`embedding FLOAT[384]`), plus an `EmbedFn` type. The `notes_fts` virtual table is kept in sync by three database triggers (insert/delete/update) defined in the schema migration | Solo project |
9: Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance. See `docs/adr/0013-command-risk-gate-and-smart-approval.md` for the Phase 21 risk-gate design, `docs/adr/0014-mcp-client-support.md` for the Phase 24 MCP client, `docs/adr/0014-persistent-memory.md` for the Phase 25 memory design, `docs/adr/0014-advisor-passive-second-model.md` for the Phase 34 advisor design, `docs/adr/0015-skills-system.md` for the Phase 28 skills system design, `docs/adr/0016-ansi-first-ui-design-system.md` for the Phase 35 shared ANSI design system, `docs/adr/0016-delegate-task-subagent-spawning.md` for the Phase 31 delegation design, `docs/adr/0026-notes-fts5-search.md` for the Phase 26 FTS5 notes search design, and `docs/adr/0027-semantic-note-search.md` for the Phase 27 semantic note search design.
