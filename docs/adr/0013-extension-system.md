# 0013. Extension system

> Partially superseded: Railgun now loads extensions only from the global
> `~/.railgun/extensions/` directory. Project-local extension discovery and its
> trust plumbing were removed with the fixed home-directory workspace change.

Date: 2026-07-12

## Status

Partially superseded by ADR-0034

## Context

Every behavioral customization to the agent loop previously required editing
core source files — adding a new lifecycle callback, wrapping a tool handler,
or threading a side channel through `runTurn`'s parameter list. There was no
seam that let outside code observe tool calls, rewrite input, or inject new
tools without modifying files shared by every feature. As the surface area
grew this became increasingly fragile: a single shared `LoopCallbacks` or
`AgentEvent` bus gives observers visibility after the fact, but no extension
point lets code block a tool call before the registry dispatches it, rewrite
its result, or intercept user input before it reaches the agent.

## Decision

Add a typed extension layer that slots between the agent loop and the tool
registry, and between user input and agent dispatch.

**Types (`src/extensions/types.ts`):** A discriminated `ExtensionEvent` union
with five members — `tool_call` (interception, can block), `tool_result`
(observation, can transform content/isError), `session_start`,
`session_shutdown` (observers only), and `input` (can transform or consume
user text). Per-event handler return types are conditional: `tool_call`
handlers return `ToolCallResult | void`, `tool_result` handlers return
`ToolResultHandlerResult | void`, `input` handlers return
`InputHandlerResult | void`, and lifecycle handlers return `void`. The
`ExtensionAPI` surface exposes `on` (event + handler) and `registerTool`
(LLM-callable tool with name, description, JSON Schema, and `execute`)
plus four no-op stubs (`registerCommand`, `registerShortcut`, `registerFlag`,
`registerProvider`) for future shape stability. Extension code default-exports
a factory `(api: ExtensionAPI) => void | Promise<void>`.

**Runner (`src/extensions/runner.ts`):** `createExtensionRunner()` returns an
`ExtensionRunner` that dispatches lifecycle events to registered handlers:

- `emitToolCall` — walks handlers without try/catch. A throw propagates to the
  `runStep` error boundary, which converts it to an error tool result for that
  single call (fail-closed per call, not per session). The first handler that
  returns `{ block: true }` short-circuits; remaining handlers are not called.
- `emitToolResult` — walks handlers with per-handler try/catch. Errors are
  reported via `onExtensionError` listeners; other handlers still run. Returned
  overrides (`content`, `details`, `isError`) are merged by later-wins
  accumulation.
- `emitInput` — walks handlers with per-handler try/catch. `"transform"` rewrites
  the running event's text/images and passes the updated value to subsequent
  handlers; `"handled"` returns immediately, skipping the agent entirely.
- `emitSessionStart` / `emitSessionShutdown` — shared observer loop with
  per-handler try/catch; errors are isolated and reported, never propagated.

**Loader (`src/extensions/loader.ts`, amended by ADR-0034):** The original
implementation scanned project-local `.railgun/extensions/` and then the global
directory. The current implementation scans only `~/.railgun/extensions/`. For each
directory it reads entries via `readdir({ withFileTypes: true })`, importing
`.ts`/`.js` files directly and subdirectories that contain an `index.ts` or
`index.js` (preferring `.ts`). Each module is dynamically imported via
`pathToFileURL` (required: module paths are discovered at runtime, not
author-time). A per-extension try/catch reports load failures through
`runner.reportExtensionError` and continues to the next entry. After loading,
`registerExtensionTools(runner, registry, sessionId)` iterates
`runner.getTools()` and registers each as a `RegisteredTool` with
`toolset: "extension"` in the core registry.

**Integration in `turn.ts`:** `runStep` accepts an optional `ExtensionRunner`.
Both the sequential and parallel tool execution paths wrap each call with
`emitToolCall` (before registry dispatch) and `emitToolResult` (after). A
blocked call emits `tool_execution_end` and pushes the error tool message
without invoking the registry. The `"extension"` toolset is added to
`ENABLED_TOOLSETS` so extension-registered tool schemas are included in every
`streamChat` request.

**Bootstrap in `cli.ts`:** `bootstrapExtensions(sessionId, config)` creates the runner,
wires an error listener, loads filesystem extensions, then programmatically bootstraps
MCP servers from the injected `AppConfig` (see ADR-0014), and registers all extension
tools into the core registry. It returns `{ runner, cleanup }` where `cleanup()` kills
MCP child processes; callers wrap session work in `try/finally { cleanup() }`. It is
called once per session for the `fresh`, `resume`, and `print` modes (the
`login`, `logout`, `config`, and `list` modes have no session and load no
extensions). `session_start` is emitted after bootstrap, before the REPL or
one-shot call; `session_shutdown` is emitted after it returns.

**Trust model (superseded):** The original implementation loaded project-local
extensions with a threaded `trusted` parameter. ADR-0034 removed project-local
discovery and that parameter; only user-global extensions are loaded.

## Consequences

- Extension `tool_call` handlers can block any tool call, including built-in
  ones, by returning `{ block: true, reason }`. A throwing handler fails that
  single call closed without crashing the agent.
- Extension `tool_result` handlers can rewrite result content and `isError`
  before the model sees the tool message. Handler errors are isolated.
- Extension `input` handlers can rewrite or consume any user message before it
  reaches the agent. A "handled" input returns silently without pushing a `YOU`
  row or running the model.
- Extensions can register new LLM-callable tools. The model sees them on every
  turn that calls `registry.getSchemas(ENABLED_TOOLSETS)`.
- Session lifetime and session IDs are shared between extensions and the
  persistence layer (the `bootstrapExtensions(sessionId)` call uses the same
  UUID as `persisted.id`).
- Project-local extensions are not supported.
- Dynamic `import()` is used for extension loading. Under `tsx` (development
  runtime), `.ts` files import correctly. A compiled production build requires
  pre-compiled `.js` extension files.
- `registerCommand`, `registerShortcut`, `registerFlag`, and `registerProvider`
  are no-ops. They exist only to keep extension factory code forward-compatible
  with future API surfaces without requiring an API version bump.
- The `createExtensionAPI` function was private to `loader.ts` during Phase 23.
  Phase 24 exports it so `bootstrapExtensions` can create an `ExtensionAPI` for
  the programmatic MCP extension without routing through the filesystem loader.
  This is the only public surface added to `loader.ts`; the rest of the loader
  API is unchanged.
