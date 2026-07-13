# ADR 0028 — Desktop App: WebSocket Gateway + Vite/React Renderer

## Status

Accepted (Sprint 0 + Sprint 1 complete; Sprint 2 Composer + slash commands complete)

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

- Gateway process must be started separately in development (`terminal 1: gateway`, `terminal 2: pnpm dev`). Sprint 3 (Electron) will fold this into a single launch command via the main process spawning the gateway.
- The `@railgun/core/*` path alias means Vite (not tsc) resolves gateway imports against the filesystem. The gateway is Node.js-only code and is excluded from Vite's browser bundle.
- `ws` package is added as a production dependency of `@railgun/desktop` only. The root package is unaffected.
- Sprint 3 adds Electron: main process spawns the gateway, passes the chosen port to the BrowserWindow via a query param or IPC, and loads the Vite build.

---

## Sprint 2 — Composer + Slash Command System

### Composer component and `useComposer` hook

`apps/desktop/renderer/components/Composer.tsx` is the user's text entry point. It renders a multi-line auto-resizing `<textarea>` (capped at 6 rows, matching the TUI cap) alongside a `<SlashSuggestions>` dropdown overlay. All input state lives in `useComposer` — the component is a pure projection of that state.

`apps/desktop/renderer/hooks/useComposer.ts` exports a `ComposerState` interface and the `useComposer()` hook. State fields:

| Field | Type | Description |
|---|---|---|
| `draft` | `string` | Current textarea value |
| `liveMatches` | `readonly string[]` | Real-time filtered slash matches (recomputed every render) |
| `completionMatches` | `readonly string[]` | Frozen match list once Tab or arrow key is pressed |
| `completionIndex` | `number \| null` | Currently highlighted suggestion (null = none) |
| `composerRevision` | `number` | Monotonic counter; passed as `key` to the textarea to force DOM remount after Ctrl+U |

`liveMatches` is derived inline (not state): `findMatches(draft)` when `draft` starts with `/` and has no space. It is not stored in state because it is always computable from `draft`.

`completionMatches` is the _frozen_ snapshot of `liveMatches` taken the moment Tab or an arrow key is first pressed. Freezing is necessary so the suggestion list stays stable while the user navigates it (subsequent draft edits via Tab-cycle update `draft` via `setDraftRaw`, bypassing `setDraft`, which would otherwise reset completion state).

### Keyboard bindings

All bindings are handled in `handleKeyDown` on the textarea. Arrow keys are intercepted **only when suggestions are visible** (`activeSuggestions.length > 0`); when no dropdown is shown, they retain native cursor-movement behavior.

| Key | Suggestions visible | Effect |
|---|---|---|
| `↑` / `↓` | Yes | Navigate suggestion list; wraps; freezes live matches if not already frozen |
| `↑` / `↓` | No | Native textarea cursor movement (not intercepted) |
| `Tab` | — | Cycle suggestions (freeze → select index 0 → cycle); single match → auto-complete with trailing space |
| `Escape` | Completion active | Clear completion state (index + frozen matches), keep draft |
| `Escape` | No completion | Clear draft |
| `Ctrl+U` | — | Clear draft + completion; increment `composerRevision` (remounts textarea, restores focus) |
| `Ctrl+C` | — | Call `onAbort()` |
| `Enter` | — | Submit trimmed draft (no-op if empty); `Shift+Enter` inserts newline |

### Slash suggestion state machine

```
  draft = "/"          liveMatches = [all 13 commands]   completionMatches = []   index = null
       │
       ▼ Tab (multiple)
  completionMatches = [...liveMatches]  index = null  draft unchanged
       │
       ▼ Tab again
  index = 0  draft = completionMatches[0]
       │
       ▼ Tab again  (cycles)
  index = 1  draft = completionMatches[1]  …wraps

  draft = "/"  ─ ArrowDown ─►  completionMatches frozen  index = 0
               ─ ArrowDown ─►  index = 1   …wraps at length-1 → 0
               ─ ArrowUp  ─►  index wraps from 0 → length-1

  Escape (completion active) → index = null, completionMatches = []
  Escape (no completion)     → draft = ""
  setDraft (external)        → index = null, completionMatches = [] (resets all completion state)
```

`> 1` is the threshold for displaying (and navigating) a list. A single live match is handled by Tab's auto-complete path (`nextCompletionState` in `src/commands.ts`), not by arrow navigation. This matches the TUI slash-command UX where a unique prefix immediately expands.

### `composerRevision` and the `key` prop

Ctrl+U must reset the textarea DOM node — not just its React value — to clear browser-native state (IME composition, browser autofill overlays, cursor position). This is done by passing `key={composerRevision}` to the `<textarea>`. React unmounts and remounts the element when the key changes. A companion `useEffect([composerRevision, isDisabled])` restores keyboard focus to the new element immediately after mount (guarded by `isDisabled` so focus is not forced when input is locked in `awaiting_approval` mode).

### `SlashSuggestions` scroll behaviour

When the suggestion list is long (all 13 commands on bare `/`) and the user navigates with arrow keys, the selected item may scroll off the visible dropdown area. `SlashSuggestions` attaches a `ref` to the currently-selected `<div>` and calls `scrollIntoView({ block: "nearest" })` in a `useEffect` keyed on `selectedIndex`, keeping the highlighted item visible without disrupting scroll position when no navigation occurs.

### Test infrastructure

`@testing-library/react` (v16+, includes `renderHook`) and `jsdom` are added as devDependencies. The vitest config gains `environmentMatchGlobs: [["renderer/**", "jsdom"]]` so renderer tests run under jsdom while gateway tests remain in the default `node` environment.

`apps/desktop/renderer/hooks/useComposer.test.ts` (13 cases) covers: initial state, live filtering, single-match Tab completion, multi-match Tab cycling with full wrap-around, `handleArrowDown` / `handleArrowUp` freeze-and-navigate, wrap-around in both directions, no-op on non-slash input, two-phase Escape, Ctrl+U revision increment, and submit guard on empty draft.
