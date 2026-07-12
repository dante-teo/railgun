# ADR 0028 — Desktop App: WebSocket Gateway + Vite/React Renderer

## Status

Accepted (Sprint 0 + Sprint 1 complete)

## Context

Railgun's interactive surface is currently an Ink terminal UI (`src/repl/App.tsx`). The product direction calls for a desktop app that exposes the same agent features in a native-feeling window. Three plausible shapes existed:

1. **Electron + embedded Node + direct import** — load `src/` directly inside Electron's main process, render via a BrowserWindow; no IPC boundary.
2. **Electron + IPC bridge** — main process owns the `AgentSession`; renderer communicates via `ipcRenderer`/`ipcMain`.
3. **Standalone gateway process + browser renderer** — a Node.js WebSocket server wraps the `AgentSession`; any browser connects (Vite dev server in development, Electron BrowserWindow in production).

Option 3 was chosen for Sprint 0–1.

## Decision

Build a WebSocket gateway (`apps/desktop/gateway/`) that wraps `createAgentSession` identically to `src/rpc/rpcMode.ts`, and a React DOM renderer (`apps/desktop/renderer/`) served by Vite. Electron is deferred to Sprint 3.

### Gateway protocol

JSON frames over a single WebSocket connection. Every `GatewayCommand` (client → server) carries a mandatory `id` string for correlation. Every `GatewayEvent` (server → client) is one of:

- `{ type: "event"; event: AgentEvent }` — the raw agent event stream, forwarded verbatim.
- `{ type: "response"; id; command; success; data?; error? }` — correlated command response.
- `{ type: "approval_request"; command }` — shell approval round-trip start.
- `{ type: "clarify_request"; question; choices? }` — clarify round-trip start.
- `{ type: "state_update"; state }` — emitted after each run slot clears.

The `approve` and `clarify_response` commands carry no `cmdId` correlation because they resolve a parked promise in the session manager, not a queued command.

### Session manager

`sessionManager.ts` stores a single `RunSlot | null`. The `confirmShellCommand` and `clarifyCallback` callbacks use `Promise.withResolvers()` to park the running agent, emit the corresponding request frame, and resolve when the matching response command arrives from the client. This is identical in structure to the readline-based prompts in `src/oneShot.ts`, but asynchronous and round-tripped over WS.

A `state_update` frame is emitted from the run slot's `.finally()` block — after `currentRun = null` — so `running: false` is always correct in the frame.

### Workspace conversion

The root `pnpm-workspace.yaml` gains `packages: ["apps/*"]`. The desktop package is `private: true` and has its own `tsconfig.json` (ES2024, `bundler` module resolution, `@railgun/core/*` path alias pointing to `../../src/*`). No root `src/` files are modified; the alias is the only coupling point.

### Renderer

React 19 DOM, no Electron APIs, no Node.js builtins. CSS custom properties drive the entire visual system — palette hex values are copied once from `src/ui/palette.ts` into `styles/tokens.css` and never repeated. Components are named and structured to match their TUI counterparts in `src/repl/`.

`DevShell` (guarded by `import.meta.env.DEV`) mounts all Sprint 1 components with static mock data so the visual design is reviewable without a running gateway.

## Alternatives considered

**Option 1 (direct Electron import)** would skip the IPC boundary but couple the renderer to Node.js APIs and make it impossible to develop the UI in a plain browser. It also prevents future non-Electron deployments (e.g. a web app hosted locally).

**Option 2 (Electron IPC)** works but Electron's `ipcMain`/`ipcRenderer` API is verbose and serialization-limited. The WS approach uses the same JSON framing as `rpcMode.ts` and works in any browser, making the renderer independently testable and Electron-agnostic.

**Shared-memory / worker_threads** was not considered because the renderer must run in a browser context (BrowserWindow), not a Node.js worker.

## Consequences

- Gateway process must be started separately in development (`terminal 1: gateway`, `terminal 2: pnpm dev`). Sprint 2 adds the WS client that connects them.
- The `@railgun/core/*` path alias means Vite (not tsc) resolves gateway imports against the filesystem. The gateway is Node.js-only code and is excluded from Vite's browser bundle.
- `ws` package is added as a production dependency of `@railgun/desktop` only. The root package is unaffected.
- Sprint 3 adds Electron: main process spawns the gateway, passes the chosen port to the BrowserWindow via a query param or IPC, and loads the Vite build.
