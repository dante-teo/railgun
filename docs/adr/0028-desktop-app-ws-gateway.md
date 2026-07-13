# ADR 0028 — Desktop App: WebSocket Gateway + Vite/React Renderer

## Status

Accepted (Sprint 0 + Sprint 1 complete; Sprint 2 Composer + slash commands complete; T5 component parity complete; T7 gateway client + production App shell complete)

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

**T5 component parity additions (completed after Sprint 1):**

- **`TodoPanel`** — now renders a `div.todo-panel__header` above the item list. The header shows `"Todos"` on the left and `"{completed}/{total}"` (from `summarizeTodos()`, imported from `@railgun/core/tools/todo.js`) on the right, matching the REPL's summary line. The header only appears when todos are present (not during the skeleton loading state). The item list is wrapped in a dedicated `div[role="list"]` (separate from the outer `.todo-panel` container) so the `todo-panel__header` sibling is not a direct child of a list role — this satisfies the ARIA spec's requirement that all direct children of `role="list"` carry `role="listitem"`.
- **`StatusBar`** — gains a `readonly cwd: string` prop. When `cwd` is non-empty, it is rendered in `.status-bar__left` inside a `<span title="Working directory">` wrapper. A `·` separator (`div.status-bar__separator`) appears between the git branch block and the cwd span only when both are visible (branch non-null and cwd non-empty). The `cwd` value is presentational only; sourcing it from the gateway (`GatewaySessionState`) is deferred to T7.
- **CSS** — three new utility classes added to `styles/layout.css`: `.todo-panel__header` (flex, baseline-aligned, mono 12px bold, `var(--color-strong)`), `.todo-panel__summary` (weight 400, `var(--color-muted)`), and `.status-bar__separator` (`var(--color-dim)`).
- **Tests** — `renderer/components/TodoPanel.test.tsx` (8 cases) and `renderer/components/StatusBar.test.tsx` (9 cases) added; both call components as plain functions and inspect the returned React element tree without a DOM renderer. The Vite config's `test.include` is extended to `["gateway/**/*.test.ts", "renderer/**/*.test.tsx"]`.

`DevShell` (guarded by `import.meta.env.DEV`) mounts all components and simulates a full streaming cycle on each submit — a 600 ms thinking pause, word-by-word streaming at 150 ms/word, then finalization as a committed assistant line — so all three live states (thinking, streaming, settled) are exercisable without a running gateway. Re-entrant submits while busy are silently dropped. The `StatusBar` mock passes `cwd="~/Projects/railgun"`.

### Streaming and thinking model

`DisplayLine.partial: true` signals that an assistant line is still in flight. `MessageBubble` renders partial lines in one of two states:

- **Streaming** (`partial && text !== ""`): renders `line.text` via `react-markdown` + `StreamingCursor`. `Transcript` receives `streaming` as a dedicated prop and renders the streaming bubble independently of the `lines` array — streaming text is never embedded in `lines` while it is still accumulating. The production `App` passes `state.streaming` directly to `<Transcript streaming={...}>` and keeps it out of the `displayLines` memo.
- **Thinking** (`partial && text === ""`): renders `"Thinking" + StreamingCursor` with `.thinking-text` styling (dimmed, italic). Transcript emits this line when `busy && !streaming` (agent is running but no text deltas have arrived yet).

These two states are mutually exclusive: `Transcript` renders at most one ephemeral partial bubble at a time. Tool-call progress lines (ephemeral pending tool labels) are appended to the `lines` prop by the `App` shell's `displayLines` memo while `toolLabels.size > 0`; they never coexist with the streaming bubble because an incoming `tool_execution_start` event flushes any in-progress stream segment before adding the tool label.

### Component tests

Vitest 4.x with `@testing-library/react` covers all renderer components — 41 tests total across `StreamingCursor`, `ToolCallLine`, `MessageBubble`, `Transcript`, `TodoPanel`, and `StatusBar`. Configuration notes:

- `globals: true` in `vite.config.ts` injects `describe`/`it`/`expect`/`beforeAll` at runtime; `"vitest/globals"` must also be added to `tsconfig.json`'s `types` array for TypeScript to resolve them without explicit imports.
- `environmentMatchGlobs` does not exist in vitest 4.x. Each renderer test file carries `// @vitest-environment jsdom` instead.
- A shared `renderer/test-setup.ts` imported via `setupFiles` loads `@testing-library/jest-dom` once for all test suites.
- All `@testing-library/*` and `jsdom` packages belong in `devDependencies`; `@testing-library/dom` is a peer of `@testing-library/react` and must be listed explicitly.

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

## Sprint 1 — Overlay components

Six overlay components (`ModelPicker`, `TrustPicker`, `ClarifyPrompt`, `ShellApproval`, `ActionPicker`, `SessionChooser`) were added to `renderer/components/overlays/`. They mount inside `.overlay-zone` one at a time and cover the four gateway round-trips that park the agent: model selection, trust decision, clarification, and shell approval.

### Keyboard contract

All overlays attach keydown listeners to `window` (not the focused element) so they intercept input regardless of DOM focus. The four list-based overlays (`ModelPicker`, `TrustPicker`, `ActionPicker`, `SessionChooser`) use a shared `useOverlayKeyNav` hook (`renderer/hooks/useOverlayKeyNav.ts`) that handles Escape unconditionally and arrow/Enter when `length > 0`. The overlays separate cursor movement from selection via `onNavigate(index)` (arrow keys) and `onConfirm(index)` (Enter/click) props:

- Arrow keys → `onNavigate(newIndex)` — parent updates `selectedIndex`; the overlay re-renders.
- Enter → `onConfirm(selectedIndex)` — signals that the highlighted item was chosen.
- Click on an item → `onConfirm(i)` directly — clicking is always a confirmation, not navigation.
- Escape (and Ctrl+C for `SessionChooser`) → `onCancel()`.

Conflating navigation and confirmation into a single `onSelect` callback (the earlier design) made it impossible for the parent to distinguish "the user moved the cursor" from "the user picked something." The split also lets `DevShell` share a single `overlayIndex` state for `selectedIndex` across all overlay variants without triggering premature confirmation on every arrow keystroke.

`useOverlayKeyNav` accepts a `wrap: boolean` option. `TrustPicker` and `SessionChooser` wrap (ArrowDown at the last item goes to index 0); `ModelPicker` and `ActionPicker` clamp.

### Scroll-into-view

`.overlay__list` has `max-height: 240px; overflow-y: auto`. Each list overlay attaches a `selectedRef` to the currently selected `.overlay__item` div and calls `selectedRef.current?.scrollIntoView({ block: "nearest" })` in a `useEffect` keyed on `selectedIndex`. This keeps the highlighted item visible after arrow-key navigation without JS scroll calculation.

### ClarifyPrompt

`ClarifyPrompt` is the only overlay that manages its own `selectedIndex` state (via `useState`) rather than receiving it as a prop. It supports two modes determined by whether the `choices` prop is provided:

- **Choice list** (up to 4 options): arrow-key handler is a `useEffect` on `window`; Enter calls `onAnswer(trimmedChoices[selectedIndex])`.
- **Free text**: renders an `<input>` that auto-focuses on mount (`inputRef.current?.focus()` in a `useEffect`); Enter and Escape are bound on the input's `onKeyDown`.

The gateway's `clarify_request` frame already carries `question` and optional `choices?`, so both modes map directly to protocol fields without any renderer-side transformation.

### DevShell keyboard guard

`DevShell` activates overlays via digit keys 1–7 bound on `window`. The handler checks `e.target.tagName` and `isContentEditable` before acting, so typing digits in the Composer textarea does not spuriously open an overlay.

---

## T7 — Gateway Client + Production App Shell

T7 wires the desktop renderer to the running gateway, replacing the `DevShell` mock with a live stateful shell.

### `renderer/lib/gatewayClient.ts`

`createGatewayClient(url)` returns a `GatewayClient` with five operations:

| Operation | Behaviour |
|---|---|
| `send(cmd)` | Serialises a `GatewayCommand` to JSON and writes it if `readyState === OPEN`; drops silently otherwise |
| `request(cmd)` | `send` + `Promise<GatewayResponse>` keyed by `cmd.id`; resolved when a `{ type: "response", id }` frame arrives; rejects with `{ success: false, error: "Request timed out" }` after 10 s |
| `subscribe(fn)` | Adds `fn` to a `Set` of listeners; returns an unsubscribe thunk; `response` frames bypass broadcast and resolve their `request` promise directly |
| `close()` | Disables reconnect, closes the socket, resolves all pending `request` promises with `{ success: false, error: "Client closed" }` |
| `status()` | Returns `"connecting" \| "connected" \| "disconnected"` from the last socket event |

Auto-reconnect: `onclose`/`onerror` schedule a reconnect via exponential backoff (1 s → 2 s → 4 s → 8 s cap). Backoff index resets on `onopen`. `close()` sets a `closed` flag that suppresses reconnect scheduling.

`nextCmdId()` is a module-level monotonic counter (`"cmd-${++seq}"`) exported for callers that need to fabricate a correlation id before calling `request`.

### `renderer/lib/useAgentEvents.ts`

`useAgentEvents(gatewayUrl)` is the single stateful hook driving the shell. It owns:

- A `GatewayClient` in a `useRef` (stable across renders, closed on unmount).
- A `StreamSegments` ref for accumulating streaming text deltas without triggering renders on every character.
- A `toolLabelTextRef` (`Map<toolCallId, label>`) for retaining the display label after a tool call id is removed from the `toolLabels` render state.
- A `useReducer` whose `ReducerState` holds all render-visible fields: `lines`, `streaming`, `busy`, `toolLabels`, `todos`, `overlay`, `composerMode`, `connected`, `pendingCommand`, `pendingClarify`, `availableModels`.

**Event mapping:**

| `GatewayEvent` | Effect |
|---|---|
| `{ type: "event", event: { type: "message_update", streamEvent: { type: "text_delta" } } }` | `appendStreamDelta` into the ref; dispatch `streaming_delta` with the new segment |
| `tool_execution_start` | `flushStreamSegment` (commits in-progress stream to a `DisplayLine` if non-empty); add to `toolLabels`; set `todoLoading` if tool is `"todo"` |
| `tool_execution_end` | Remove from `toolLabels`; if `shouldShowToolLine`, append a `{ kind: "tool" }` line; clear `todoLoading` if tool is `"todo"` |
| `message_start` (role `"user"`) | Flush stream; parse with `parseAdvisoryMessage`; append advisory or user `DisplayLine`; mark `queuedSteer = false` |
| `compaction_end` | Append `"Context compacted."` assistant line |
| `moa_reference_start` / `moa_reference_end` / `moa_aggregating` | Append / mutate MoA progress lines |
| `subagent_start` / `subagent_end` | Append pending/settled subagent tool lines |
| `{ type: "approval_request" }` | Set `pendingCommand`, open approval overlay, set `composerMode = "awaiting_approval"` |
| `{ type: "clarify_request" }` | Set `pendingClarify`, open clarify overlay |
| `{ type: "state_update" }` | Sync `busy`, `model`, `todos`; on `busy → !busy` transition, call `finishStreamSegments` and dispatch `run_complete` (appends final segment, resets streaming/toolLabels) |

**Slash command dispatch** (renderer-local, no round-trip):

| Command | Action |
|---|---|
| `/clear` | `dispatch({ type: "clear_lines" })` |
| `/help` | Append hardcoded help text as assistant line |
| `/model` | `client.request({ type: "get_available_models" })` → populate `availableModels`, open model overlay |
| `/compact` | `client.send({ type: "compact" })`; append `"Compacting…"` assistant line |
| `/settings` | Open action overlay with theme-toggle item |
| `/moa`, `/trust`, `/branch`, `/fork`, `/rollback`, `/exit`, `/dream`, `/cron` | Append error line: `"${command} is not yet implemented in the desktop app."` |

**Initial hydration:** on mount, `client.request({ type: "get_state" })` hydrates `busy`, `model`, `todos` from the gateway's current session state. The renderer starts with an empty transcript; no history replay is attempted (gateway does not return message history in `get_state`).

**Connection status:** polled every 500 ms via `setInterval` calling `client.status()`. This is a lightweight read — no extra WS traffic. The banner is shown in the `App` header when `connected !== "connected"`.

**Type guards:** `GatewayResponse.data` is `unknown`. Two inline type guards (`isStateData`, `isModelArray`) validate network response payloads using `in` / `typeof` checks before reading fields — no unchecked inline casts.

### `renderer/components/App.tsx`

`App` is the production shell (rendered when `import.meta.env.DEV` is false; `DevShell` is rendered in dev mode). It calls `useAgentEvents` and `useComposer`, assembles the layout, and owns overlay dispatch.

**Ephemeral `displayLines` memo:** computed from `[state.lines, state.toolLabels, state.busy]`. When `busy && toolLabels.size > 0`, one `{ kind: "tool", pending: true }` line is appended per active tool call. Streaming text is intentionally excluded — `Transcript` renders it via its own `streaming` prop to avoid double-rendering the streaming bubble.

**Overlay routing** — `renderOverlay()` switches on `state.overlay.kind`:

- `"model"` → `ModelPicker` with `state.availableModels`; confirm calls `state.setModel(model.id)`
- `"approval"` → `ShellApproval` with `state.pendingCommand`; approve/deny calls `state.approveCommand(bool)`
- `"clarify"` → `ClarifyPrompt` with `state.pendingClarify`; answer calls `state.answerClarify(answer)`
- `"action"` → `ActionPicker` with `SETTINGS_ITEMS`; confirm handles theme toggle by reading `document.documentElement.getAttribute("data-theme")` (source of truth written by `applyTheme`) rather than the OS media query (which would get stuck after the first toggle)
- `"trust"` / `"session"` → `TrustPicker` / `SessionChooser` with `dismissOverlay` as confirm (both are stubs pending T8+)

**Test coverage:** `renderer/lib/gatewayClient.test.ts` (12 cases) and `renderer/lib/useAgentEvents.test.ts` (13 cases) added. Both use a synchronous `FakeWebSocket` stub injected via `vi.stubGlobal`. Total suite: 132 tests.
