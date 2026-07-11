# 0014. JSONL RPC protocol

Date: 2026-07-12

## Status

Accepted

## Context

The codebase had interactive REPL and one-shot modes but no headless, programmatic session mode. GUI clients (TUI, desktop app, test script) needed a way to drive the agent without importing agent internals or sharing a gateway process. A socket server would add lifecycle complexity (port management, authentication, multiplexing). The AgentSession interface (run/abort/steer/followUp/subscribe) and the AgentSessionEvent discriminated union already provide a complete session API; what was missing was a transport that exposes it over a process boundary.

## Decision

Add a JSONL RPC protocol over stdio, plus a consumer-side client, wired into `railgun --mode rpc`.

**JSONL over stdio (`src/rpc/jsonl.ts`):** One JSON object per line, terminated by `0x0a`. `makeLineReader` buffers raw bytes and splits on the literal `0x0a` byte rather than using Node's `readline` module, which would also split on U+2028 (line separator) and U+2029 (paragraph separator) — those are valid inside JSON string values and must not be treated as line boundaries. `serializeJsonLine` appends a literal `\n`.

**Command/response types (`src/rpc/types.ts`):** `RpcCommand` is a discriminated union of 10 command types: `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `set_model`, `get_available_models`, `compact`, and `set_auto_compaction`. Each may carry an optional `id` field for correlation. Responses carry `{ type: "response", command, success, id? }` plus `data` on success or an `error` string on failure. `AgentSessionEvent` objects are forwarded verbatim as JSONL with no envelope — the absence of a `type: "response"` field is the client's signal that a line is an event, not a response.

**One-in-flight-prompt model (`src/rpc/rpcMode.ts`):** A single run slot holds the current `AgentSession` and its promise. A second `prompt` command while the slot is occupied returns an error response immediately. This matches `createAgentSession`'s own invariant (already running throws). `steer`, `follow_up`, and `abort` are dispatched synchronously to the in-flight session or return an error response if the slot is empty (`steer`/`follow_up`) or succeed immediately as a no-op (`abort` when idle).

**Fire-and-forget prompt execution:** The dispatch function is synchronous (called from the `makeLineReader` data callback). The prompt run is started fire-and-forget; the success/error response is written from the `.then()`/`.catch()` chain. This keeps `steer`/`abort` commands processed immediately without being blocked behind an awaited run.

**Auto-approve and clarify in headless mode:** `confirmShellCommand` always returns `true` — there is no human at the terminal to mediate approval. `clarifyCallback` throws — the tool result surfaces as an error in the transcript; the client can detect it via `tool_execution_end` events and handle it at the application layer. This is a deliberate trade-off: adding a `confirm_shell` or `clarify_request` command to the protocol would require the client to handle a blocking request/response round-trip, which complicates simple scripting use cases. The auto-approve decision is recorded in the plan as a contingency — if it proves unsafe, `confirm_shell` can be added as a protocol extension.

**No persistence:** RPC mode does not open `SessionStore` or create saved sessions. The client is responsible for session persistence if needed. A `save_session` command can be added later.

**RpcClient (`src/rpc/rpcClient.ts`):** A TypeScript consumer utility class that spawns the child, manages the pending `Map`, and provides `call()`/`onEvent()`/`stop()`. It uses the same JSONL framing utilities as the server side.

**DI for testability:** `runRpcMode` accepts injectable `stdin`/`stdout` streams via `RpcModeOptions` instead of hardcoding `process.stdin`/`process.stdout`. It is injected into `CliDependencies` as `runRpc` so tests can verify dispatch without running real I/O.

## Consequences

- Any TypeScript process can drive a headless agent by spawning `railgun --mode rpc` as a child and writing/reading JSONL lines.
- The protocol is additive: new command types extend the `RpcCommand` union without breaking existing clients that don't send them.
- One process per client: no multiplexing, no shared gateway. Isolation is free — each client's session state (history, todos, model) is private to its process.
- Shell commands are auto-approved. Clients that want mediated approval must add a `confirm_shell` command in a future protocol version.
- The clarify tool surfaces as a tool error in RPC mode. Clients that want interactive clarification need a `clarify_request` protocol extension.
- No session persistence. RPC clients that need resumable sessions must implement it themselves or use a future `save_session` command.
- `makeLineReader`'s byte-level splitting is a deliberate departure from Node's `readline` behavior, preserving U+2028/U+2029 inside JSON strings.
