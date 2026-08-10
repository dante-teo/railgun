# Railgun Desktop

A prototype Electron application shell built with TypeScript, React, React Router, Tailwind CSS,
and shadcn/ui. Its Tasks interface reads saved conversation sessions from the configured JSONL
backend and supports optimistic archiving. It is not yet a supported release surface or complete
domain client.

## Requirements

- pnpm 11.20.0, as pinned by `packageManager`
- Node.js 20.19 or newer

pnpm uses the Node 24 runtime declared in `devEngines` for project scripts when its managed
runtime support is available.

## Setup

```sh
pnpm install
```

## Development

From the repository root, start the Electron shell with:

```sh
scripts/run.sh
```

The default launcher builds `railgun-backend` and connects Electron to its production `desktop`
RPC mode. It uses the existing `~/.railgun` data and either `DEVIN_TOKEN` or the saved
`~/.railgun/devin-token` credential. Production Electron runs participate in the shared
`~/.railgun/desktop-client.lock`, so native Railgun and multiple Electron instances cannot mutate
the same data concurrently. Mock runs remain exempt.

Start it with the deterministic Rust mock backend using:

```sh
scripts/run-mock.sh
```

The mock launcher builds `railgun-mock-backend`, sets `RAILGUNX_BACKEND_MODE=mock`, and uses the
`ready-idle` scenario by default. Override the scenario for a run with, for example:

```sh
RAILGUNX_MOCK_SCENARIO=delayed-startup scripts/run-mock.sh
```

The default task list includes **Inspect the personal agent activity card**. Selecting it plays a
deterministic fixture with advisor notes, persisted TODOs, two subagents, streamed
`subagent_update` text, and final authoritative subagent results. The fixture can also start
automatically during initial state hydration with:

```sh
RAILGUNX_MOCK_SCENARIO=agent-activity scripts/run-mock.sh
```

`run-mock.sh` remains the deterministic fixture path. Production backend packaging is a separate
packaging milestone; the development launcher uses the source-built executable at
`target/debug/railgun-backend`.

Both root launchers forward additional arguments to `pnpm dev`. To work directly in this directory
without a configured backend, run:

```sh
pnpm dev
```

These commands launch the GUI and should not be used as verification commands.

## Renderer Architecture

Renderer UI follows three layers: **Page**, **Layout**, and **Component**. Pages compose the app
without Tailwind classes; Layouts own spatial styling; Components own reusable visual styling and
variants. The complete rules are in [`AGENTS.md`](./AGENTS.md).

The renderer deliberately uses `HashRouter` because production pages are loaded from an Electron
`file://` URL. `AppShellLayout` owns the window chrome and pane geometry; its semantic slots keep
the Page limited to composition. Real topbars use the global `window-drag-region` utility, while
interactive controls inside them use `window-no-drag` through their Component or Layout
implementation.

The renderer runs with context isolation and sandboxing enabled and without Node integration.
Keep privileged APIs behind the preload boundary rather than importing Node or Electron APIs into
renderer code.

### Backend boundaries

The context-isolated preload exposes `window.railgun.tasks.list()`,
`window.railgun.tasks.open(sessionId)`, and `window.railgun.tasks.archive(sessionId)`. List results
contain the session ID, presentation title, and an ISO-8601 `lastMessageAt` timestamp; the main
process validates every response before it crosses into the renderer and validates renderer-supplied
session IDs before loading or archiving. Opening a task activates the backend session without
returning transcript content through this summary-only boundary, verifies that `session_load`
activated the requested session, then refreshes activity state. A failed load restores the previous
visible selection unless the user has already selected something newer.

The read-only activity boundary exposes `window.railgun.activity.getSnapshot()` and
`window.railgun.activity.subscribe(listener)`. The main process consumes only validated advisor,
subagent, TODO, run-start, and run-end frames, bounds presentation text, hydrates persisted TODOs
from `get_state`, and publishes normalized snapshots with monotonic revisions. Run-start, run-end,
and advisor frames carry an additive `runId`; the main process rejects tagged advisor/end frames
from an older run after a newer run begins. Token-level `subagent_update` deltas update the
authoritative snapshot immediately but cross IPC at most once every 50 ms, while terminal results
publish immediately. The renderer subscribes before loading its initial snapshot and ignores stale
revisions, which prevents a live startup update from being overwritten by an older snapshot.
Unsubscribing removes the preload IPC listener.

Activity follows the backend's active session, including when saved task-list selection activates a
different session. Advisor and subagent state resets at the next `agent_start`; completed subagent
exchanges remain readable until that reset, and `agent_end` marks any unfinished subagent
interrupted. TODO state persists across runs and appears in the card only while at least one item is
pending or in progress.

#### Activity frame contract

Activity is derived from the existing JSONL event stream; it is not a second command surface. New
backend producers must preserve these frame responsibilities:

| Frame                                | Required activity fields                                         | Main-process effect                                                                        |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `agent_start`                        | `runId`                                                          | Starts a run and clears advisor and subagent state.                                        |
| Advisor `message_start`              | matching `runId`; advisory severity and text in the user message | Replaces the latest advisor note only when it belongs to the current run.                  |
| `subagent_start`                     | `index`, `count`, `goal`                                         | Creates the delegated user/assistant exchange in running state.                            |
| `subagent_update`                    | `index`, non-empty `delta`                                       | Appends streamed assistant text; snapshot broadcasts are coalesced to the bounded cadence. |
| `subagent_end`                       | `index`, `goal`, authoritative `result`                          | Replaces streamed assistant text with the final result and publishes immediately.          |
| Successful TODO `tool_execution_end` | normalized `todos` in the tool result                            | Replaces the current persisted TODO snapshot.                                              |
| `agent_end`                          | matching `runId`                                                 | Ends the run and interrupts any subagent that did not emit an end frame.                   |

Production and mock prompt runs allocate one `runId` before emitting `agent_start`; detached advisor
work retains that ID through its advisory frame. A newer `agent_start` makes later advisor or end
frames from the older run stale. `subagent_end` remains authoritative even when streamed text has
already reached the renderer.

The Electron process manager initializes JSONL protocol version 1 before serving requests and
correlates every response by request ID. Each stdout JSONL frame is limited to 8 MiB; malformed,
oversized, or invalid correlated output fails the connection instead of remaining buffered. Normal
initialization and read requests time out after 10 seconds. Archive mutations deliberately do not
use that client-side timeout: they remain pending until the backend responds or the process
terminates, so a delayed successful commit cannot be mistaken for a rejection and rolled back in
the task list. Before a production source launch, the manager acquires the native-compatible
`~/.railgun/desktop-client.lock` with exclusive owner-only creation. It rejects live owners,
recovers only valid records whose PIDs are demonstrably absent, preserves malformed records, and
removes only its own exact record when the backend lifetime ends.

## Application Shell Contract

The Tasks route composes one full-height shell:

```text
Sidebar | Content | optional Detail | Inspector
```

The shell renders exactly three 52px topbars. Sidebar and Inspector each own an integrated topbar;
Workspace owns one topbar shared by Content and Detail. The Workspace topbar therefore does not
repeat inside either body pane. The hidden macOS titlebar does not reserve an extra row, and the
native traffic lights are positioned within the Sidebar topbar. The BrowserWindow opens at
1440×900, enforces a 1280×720 minimum, and places the traffic lights at `(16, 18)`.

`AppShellLayout` exposes these semantic slots:

- `sidebar` and optional `sidebarTopBar`
- `content` and optional `detail`
- `workspaceTopBar`
- `inspector` and `inspectorTopBar`

Sidebar and Inspector toggles live in their respective topbars while expanded. When either pane
is collapsed, its toggle moves into the Workspace topbar. Collapsing Sidebar also enables the
native traffic-light clearance before the Sidebar toggle. Controls stay in normal flex flow; pane
geometry does not animate.

### Resizing and persistence

| Region    |  Default | Minimum |  Maximum |                               Collapse |
| --------- | -------: | ------: | -------: | -------------------------------------: |
| Sidebar   |    260px |   240px |    360px |                                    0px |
| Content   |    340px |   300px |    520px |                                     No |
| Detail    | Flexible |   420px | Flexible | Omitted with its separator when unused |
| Inspector |    320px |   280px |    440px |                                    0px |

Workspace has a 720px minimum when Detail is present. Without Detail, Content fills Workspace.
Separators are keyboard accessible. A Sidebar or Inspector collapse caused by a toggle, separator
drag, or keyboard action must update the shell visibility state and move the corresponding toggle;
reopening restores the last non-zero width.

Layout state is stored under `railgun.shell.layout.v1` with a schema version, Sidebar, Content, and
Inspector widths, and Sidebar/Inspector visibility. Reads validate the complete record, including
width constraints. Malformed, obsolete, or out-of-range records fall back to defaults.

### Visual foundations

The renderer uses the bundled Barlow variable font for interface text and Departure Mono Nerd Font
only for technical literals such as code, paths, identifiers, and commands. Theme values live as
semantic Tailwind tokens in `src/renderer/src/assets/main.css`. Topbar icon actions share the
`TopBarIconButton` contract so sizing, interaction states, drag behavior, and accessible labeling
remain consistent.

The Tasks content column lists real saved sessions in backend order. Selecting a row activates that
backend session and refreshes app-global activity, but still reveals only a visual transcript
placeholder in this milestone; transcript loading and task resumption remain out of scope. Archive
actions remove a task optimistically and restore it at its original position when the backend
rejects the request. The displayed date comes from the latest message on the session's active branch
and falls back to the session start when that branch has no messages. Navigation rows, transcript
content, composer controls, inspector fields, and archived-task browsing remain placeholders or
future work.

When a task is selected, Detail anchors the composer placeholder below the scrollable transcript
scaffolding. The composer fills the available width with `px-4` edge spacing and is centered at
`max-w-180`. Its textarea starts at one line, grows with its content, and scrolls after ten lines.
The attachment, approval mode, context usage, model, and send controls are intentionally inert at
this milestone. They retain individual accessible names and live in a labeled group; the group does
not claim toolbar semantics until it also implements the corresponding keyboard-navigation model.

Focus anywhere inside the composer reveals its animated rainbow bloom. The spectrum pauses while
the composer is idle, and reduced-motion mode keeps static opacity feedback without transform
motion. Component-specific selectors and keyframes are scoped beside the owning components in CSS
modules; only shared theme and motion tokens remain in `src/renderer/src/assets/main.css`.

The Sidebar's bottom card is the app-global personal-agent activity surface. Advisor, subagent, and
active-TODO previews use controlled Radix Popovers: pointer hover and keyboard focus reveal them,
clicking pins them, and Escape dismisses them. Popovers prefer the card's right side, use collision
handling, and cap and scroll long conversations. Their motion is an origin-aware 160 ms opacity and
`scale(0.97)` entrance with a faster exit; reduced-motion mode retains opacity feedback without
transform motion.

## Electron Binary Repair

Electron's JavaScript package and downloaded application binary are installed separately. An
interrupted or script-disabled install can therefore leave the package linked while its executable
is missing; `electron-vite` reports this state as `Error: Electron uninstall`.

`predev`, `prestart`, and `postinstall` run the checked-in preflight automatically. To repair the
binary explicitly, run:

```sh
pnpm ensure:electron
```

The repair requires network access when the Electron archive is not already cached.

## Checks

The check suite does not launch the Electron window:

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm exec prettier --check .
pnpm build
```

From the repository root, the corresponding backend and JSONL contract checks are:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
```

The locked workspace tests include the mock backend's process-level JSONL contract suite, ordered
subagent streaming and cancellation, run-correlated advisor frames, and session listing coverage.
The desktop suite covers correlated requests, exact session-load validation and selection rollback,
activity-frame validation and lifecycle resets, startup revision ordering, subscription cleanup,
coalesced streaming updates with immediate terminal publication, native-compatible shared-lock
creation, conflict handling, stale recovery and lifecycle release, and the activity card's pointer
and keyboard interactions. Renderer coverage also pins the composer textarea, labeled control group,
context progress semantics, and selector/send state attributes used by its motion layer.

## Packaging

Create an unpacked application for local inspection without using a signing identity:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm build:unpack
```

Build platform artifacts with:

```sh
pnpm build:mac
pnpm build:win
pnpm build:linux
```

Electron Builder may automatically use a matching macOS signing identity from the keychain;
timestamped signing also requires access to Apple's timestamp service. The current tagged GitHub
release workflow publishes only the native arm64 macOS application, not Electron artifacts. These
Electron commands do not currently bundle the production Rust backend.

App versions are kept aligned by the repository-level release command:

```sh
scripts/release-version.sh patch --dry-run
```

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
