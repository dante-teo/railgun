# Railgun Desktop

The production Electron application, built with TypeScript, React, React Router, Tailwind CSS, and
shadcn/ui. Its Tasks interface loads and resumes saved conversation sessions from the configured
JSONL backend, streams agent responses, handles in-turn interactions, and optimistically archives
tasks. Its Settings interface owns user configuration, personalization, skills, scheduler
management, and archived-task lifecycle. It is Railgun's sole desktop and release surface.

## Requirements

- pnpm 11.20.0, as pinned by `packageManager`
- Node.js 24.12 or newer within the Node 24 release line

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
`~/.railgun/desktop-client.lock`, so multiple Railgun instances cannot mutate the same data
concurrently. Mock runs remain exempt.

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

The default list also includes the saved `mock-session-all-tools` release-readiness conversation,
with 23 reasoned calls covering all 17 built-in tools in one task for complete tool-row UI review.
Its 53-message transcript includes complete mock arguments, results, thinking, one failed call,
persisted create/write diffs, TODO transitions, and a final answer. Launch `scripts/run-mock.sh`, then select the task beginning
**Prepare a release-readiness brief** to inspect every tool-row presentation without running tools
against the local machine. The renderer still receives only the safe projection described below;
completeness is retained inside the backend fixture for contract testing.

The `ready-idle` fixture seeds deterministic context usage for the active task and every saved
task, so the context ring is populated immediately after launch and remains populated while
switching between mock tasks.

`run-mock.sh` remains the deterministic fixture path. The development launcher uses the
source-built executable at `target/debug/railgun-backend`; packaged applications use the embedded
release executable under `Contents/Resources/backend`.

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
`window.railgun.tasks.create()`, `window.railgun.tasks.open(sessionId)`,
`window.railgun.tasks.archive(sessionId)`, and narrow archived-task list, restore, individual
deletion, and bulk-deletion methods. Active list results contain the session ID, presentation title,
and an ISO-8601 `lastMessageAt` timestamp; archived summaries add model, message count, and archived
time. The main process validates every response before it crosses into the renderer and validates
renderer-supplied session IDs before loading or mutating a task. Opening a task activates the
requested backend session, hydrates its transcript through the separate transcript service, then
refreshes activity and context usage. A failed load restores the previous visible selection unless
the user has already selected something newer.

Creating a task reads the configured default model and the live model catalog, passes the default
only when it is still available, requests a new backend session, validates its ID, and publishes an
empty, ready transcript before returning that ID. If the configured default is stale, the request
omits it so the backend can use its valid active fallback. Activity and context usage are refreshed
for the new active session. The renderer presents this session immediately as “New Task” in the
detail column, but deliberately keeps it out of the saved task list and clears any persisted-row
selection. The backend's automatic first-prompt checkpoint remains the persistence boundary: after
that prompt completes, the renderer makes a fresh list request, replaces the temporary detail with
the matching backend summary, and selects its generated title and timestamp. If the refresh fails
or does not contain the new session yet, the unsaved detail remains usable and the list refresh can
be retried by sending another prompt. Starting another new task replaces an untouched temporary
task without an additional confirmation.

Task opening, task creation, and model selection share one main-process FIFO because each can
replace the backend's single active session. An operation completes its transcript load or adopts
any model fork before the next begins, preventing late work from replacing a newer task. A rejected
operation does not block later mutations.

Settings uses separate narrow preload APIs for models, Advisor, approval configuration,
personalization, managed skills, and scheduler status/install/uninstall. The main process validates
selected models against the live catalog when the setting requires an available model, preserves
unknown backend configuration fields, and keeps unavailable stored model IDs visible without
silently rewriting them. Model, Advisor, and approval mutations require an idle backend; scheduler
management remains independent of task-run state. Personalization and skill services validate and
bound renderer inputs and backend responses before filesystem-backed data reaches the renderer.

#### Transcript boundary

`window.railgun.transcript` exposes a narrow, revisioned API:

- `getSnapshot()` and `subscribe(listener)` provide immutable snapshots with monotonic revisions.
- `send(sessionId, submission)` and `abort(sessionId)` control the active turn.
- `respondToApproval(...)` and `respondToClarification(...)` resolve backend interaction requests.

The main process owns transcript state. It validates and collects every `session_transcript` page,
publishes a validated empty snapshot for a newly created session, optimistically appends an accepted
user prompt, reduces validated live frames, and rehydrates after the timeout-free `prompt` request
completes so persisted message IDs and final content remain authoritative. Send and interaction
commands must match the loaded session; duplicate sends, duplicate stops, task creation or loads
during a run, and stale interaction responses are rejected. A model change can fork a session, so
model selection returns the backend's active session ID and the main process adopts and rehydrates
that session before the composer becomes available again. The renderer also applies that forked ID
to a temporary “New Task” detail without prematurely adding it to the saved list.

Only renderer-safe presentation data crosses this boundary. Assistant text deltas are coalesced to
at most one IPC publication every 50 ms. Tool activity contains the bounded tool name, live/failure
state, and a simplified tool-specific detail such as a file basename or item count. Shell commands
carry bounded command and output text stripped of terminal control sequences. Successful file
creates and writes deliberately expand this presentation boundary with a second exception: a
validated, bounded unified diff or an unchanged/unavailable status. The backend stores this as a
dedicated tool-content metadata part so restored and live projections agree, while provider-message
conversion filters it out. The main process validates and bounds the metadata again before copying
it into a renderer snapshot. Nested file-change metadata is cloned when it enters reducer state and
again whenever a snapshot is published, so mutating a returned object cannot modify state owned by
the transcript service. Tool labels expose safe basenames. Diff headers use basename-only tokens
whose separators, whitespace, control characters, and byte-order marks are replaced with `_`; an
unusable basename falls back to `file`. Full tool paths never cross the boundary. Raw thinking and
all other arguments and results remain private. User and final assistant rows may also carry additive
millisecond turn-boundary timestamps sourced from the persisted message `event_at` column. That
column is intentionally nullable: legacy checkpoint `created_at` values are not interpreted as
turn boundaries, so restored legacy rows use the untimed fallback instead of a fabricated duration.
Approval requests expose the command that requires the user's decision; clarification requests
expose only a bounded question and optional bounded choices. Failed interaction submissions remain
visible and retryable.

Assistant Markdown links retain Streamdown's confirmation step. The BrowserWindow still denies all
renderer-created windows; after confirmation, the main process opens only bounded, credential-free
HTTP or HTTPS URLs through Electron's external-shell API. Other schemes, malformed URLs, and URLs
containing embedded credentials are ignored.

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
the task list. Before a production source launch, the manager acquires the shared
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
remain consistent. Spatial rhythm uses Tailwind `2` (8 px) for close relationships, `3` (12 px)
for related subgroups, `4` (16 px) for major separation, and `6` (24 px) for broad section
boundaries. Margins, padding, and gaps use the closest built-in utility; arbitrary values remain
reserved for fixed product or native-window geometry.

Routine feedback reuses the shared 120 ms strong ease-out tokens and animates only opacity and
transform. Presence-managed exits follow their entrance path, become inert and hidden from
assistive technology immediately, and unmount when their opacity transition finishes. Reduced
motion removes spatial movement but retains short opacity feedback. High-frequency navigation,
keyboard flows, transcript streaming, disclosure height, and pane geometry remain immediate.

### Settings route contract

`/settings` redirects to `/settings/general`. The category routes are General, Appearance,
Personalization, Skills, and Archived Tasks. Settings preserves the primary Sidebar and replaces the
Tasks Content/Detail panes with category navigation and the selected category. It reuses the stored
Content width and resizable separator. Inspector content, its topbar, separator, and reveal control
are omitted on every Settings route; the persisted Inspector preference is unchanged and is restored
when the user returns to Tasks.

General changes the default model for future tasks without switching the current task, configures
Advisor and approval behavior, and manages Background Scheduling. Advisor and Approve for me require
available models. A retired reviewer ID may remain stored and visible while Manual or Full access is
selected because those modes do not invoke it. Model, Advisor, and approval controls are locked while
run state is unknown or active; scheduler controls remain available.

Appearance stores `auto`, `light`, or `dark` under `railgun.theme.v1`, applies it to the document
immediately, and follows live system color-scheme changes in Auto. Personalization edits
`~/.railgun/SOUL.md` and searches or manages up to 100 Preference, Fact, and Project memories. Skills
searches and manages private Markdown skills; names match `[a-z0-9-]{1,64}` and cannot change after
creation. SOUL and dialog editors retain explicit Save/Cancel or Save/Revert controls. Valid dirty
drafts save before in-app navigation, while invalid or failed saves cancel navigation and remain
visible.

Archived Tasks searches title, model, or ID and shows model, message count, and archived time.
Restore, permanent deletion, and Delete All require confirmation and are disabled while run state is
unknown or active. Confirmed list mutations animate only the affected rows and surviving-row
position changes; filtering and category navigation remain immediate.

The Tasks content column lists real saved sessions in backend order. Selecting a row activates that
backend session and opens its complete transcript. Archive actions remove a task optimistically and
restore it at its original position when the backend rejects the request. The displayed date comes
from the latest message on the session's active branch and falls back to the session start when that
branch has no messages. Task selection and archiving are disabled while the selected task is
running, which keeps its Stop control and live frame stream attached to the active backend session.
After a prompt is saved, the Page refetches task summaries so a new title or latest-message timestamp
appears without an application reload. Inspector fields remain static presentation data; archived
task browsing and lifecycle actions live under Settings rather than the Tasks list.

The selected-task Detail is a full-height transcript and composer without a repeated title panel.
The scroll viewport owns the panel-edge scrollbar, while transcript content and the separately
inset composer share a centered 720 px reading column. User prompts are framed and right-aligned;
tool activity is unframed, muted, and left-aligned; assistant responses occupy the full reading
column. Streamdown renders only the active assistant row in streaming mode and completed or restored
rows in static mode. HTML is skipped, no Shiki, math, or Mermaid plugin configuration is supplied,
and historical transcript entries do not animate on load. Each user turn groups intermediate
assistant rows, tool activity, interaction requests, and working status in one disclosure. Active
work defaults open; arrival of the end-turn assistant response remounts it collapsed as **Worked for
3m 27s** (or **Worked** for legacy untimed history), followed by a horizontal separator. Only this
live completion handoff gives the completed label and final answer a subtle 120 ms entrance; the
collapse, separator, and scroll position remain immediate and stationary. The final assistant
response remains visible below that separator, and users can reopen completed work explicitly.
The completion handoff follows the turn's transcript position rather than its user-message ID,
because successful prompt rehydration intentionally replaces `optimistic-user-*` IDs with persisted
`message-*` IDs.

Tool activity is derived immutably in transcript order. Adjacent file reads, directory listings, web
research, memory searches, and Railgun inspections collapse into a single **Explored** row; visible
messages and every consequential tool end the group. A singleton exploration still uses the
category row, while mutations, commands, tasks, clarification, memory changes, schedules, skills,
and delegation remain individually auditable. Every row keeps the compact **icon → readable action
→ chevron** order, with the chevron directly after the name rather than pinned to the far edge.
Completed rows start collapsed; active rows replace the chevron with a loading indicator, stay
expanded, and cannot be collapsed. Failed exploration groups retain their category icon and identify
the failed child in the expanded list; other failed rows use a destructive circled X. Expansion is
immediate and content height does not animate. The trigger keeps its 150 ms press and chevron
feedback. A newly appended live exploration child alone receives a 120 ms fade with a 2 px rise; a
failure indicator that changes during live execution crossfades from 96% scale. Historical rows mount
directly in their final state, and reduced motion keeps only the short opacity feedback. Shell
command/output and all ordinary details are compact, monospace where appropriate, and unframed. Only
an actual changed-file diff receives a bordered, muted, scrollable frame; unchanged, empty-create,
and unavailable states remain plain text.

The transcript initially follows the latest content and keeps following routine streaming updates.
Deliberately scrolling upward pauses that behavior and reveals **Jump to latest**. An explicit jump
uses a critically damped scroll unless reduced motion is requested; submitting a new prompt resumes
following immediately. A persistent **Agent is working…** status remains visible from prompt
acceptance until the backend turn finishes, including periods before any assistant text arrives.
Approval and clarification requests appear inline, keep the turn running while awaiting input, and
default focus to the safe denial/answer control. New request cards use a subtle opacity-and-rise
entrance and return along the same path after resolution. The reserved status line crossfades
submitting and error feedback without announcing the outgoing state twice. Escape denies or
declines the primary request.

The controlled composer fills the available width with 16 px edge spacing. Its textarea starts at
one line, grows with content, and scrolls after ten lines. Return sends, Shift+Return inserts a
newline, and IME composition never submits. The idle Send button remains disabled until the draft
contains non-whitespace text and the matching transcript is ready; the final projected prompt is
limited to 100,000 characters. Accepted sends clear the draft and attachments. A rejected send
restores both and reports the error inline. During a run the control becomes Stop, and attachment,
approval, model, and editor changes are locked until the turn ends.

The attachment control opens the macOS picker for multiple files or folders.
Selections appear once as removable file or folder chips, reset when switching tasks, and remain
unchanged when the picker is cancelled. Picker failures surface inline. Attachments augment a text
draft and are projected into the visible and submitted user prompt as absolute `file` or `folder`
path lines under an `Attachments:` heading.

The approval selector loads and persists the Ask for approval, Approve for me,
and Full access modes; auto approval remains unavailable until a reviewer model is configured and
still present in the model catalog. The context ring restores the selected session's latest
provider-reported usage and streams subsequent updates. It is read-only and keeps the same
appearance on hover; hovering only opens its detail card with usage against the active model's
context window. The model selector applies a choice to the active session and saves it as the
default for future sessions. If the backend forks the task for that model, the task list and
transcript adopt the returned session ID. If the active-session change succeeds but saving the
default fails, the active choice remains and the composer shows a warning. Composer controls retain
individual accessible names and live in a labeled group; the group does not claim toolbar semantics
until it also implements the corresponding keyboard-navigation model.

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
cargo deny check
cargo xtask legal --check
cargo xtask migration check
```

The locked workspace tests include the mock backend's process-level JSONL contract suite, ordered
subagent streaming and cancellation, run-correlated advisor frames, and session listing coverage.
The desktop suite covers correlated requests, exact session-load validation and selection rollback,
activity-frame validation and lifecycle resets, startup revision ordering, subscription cleanup,
coalesced streaming updates with immediate terminal publication, shared-lock
creation, conflict handling, stale recovery and lifecycle release, and the activity card's pointer
and keyboard interactions. Transcript coverage includes pagination, strict snapshot validation,
immutable streaming reduction, safe tool normalization, private-frame rejection, prompt projection,
bounded file-change and shell-output projection, safe diff-header generation, nested snapshot
isolation, legacy timestamp fallback, send/abort lifecycle, approval and clarification responses,
final rehydration, model-fork adoption, preload cleanup, and validated external links. Renderer
coverage exercises role-specific Markdown, loading and error states, working and interaction
indicators, optimistic-to-persisted completion handoff, chronological exploration grouping,
file-diff presentation, tool disclosure and failure states, controlled submission and restoration,
task-summary refreshes, task-switch locking, stick-to-bottom pause, jump and resume behavior,
Settings routing and Inspector exclusion, theme persistence, navigation autosave, configuration
locking, and archived-row mutation transitions.

## Packaging

Create an unpacked arm64 application for local inspection without using a signing identity. This
builds the locked release backend and embeds it with the generated legal notices:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false \
RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY=local-validation-key \
pnpm build:unpack
```

Build arm64 macOS artifacts with:

```sh
pnpm build:mac
```

The production bundle identity is `io.anvia.railgun`, the product name is `Railgun`, and the minimum
system version is macOS 15. The only production architecture is arm64. Electron Builder includes
`railgun-backend` at `Contents/Resources/backend/railgun-backend`, treats it as an additional signed
binary, and copies the Railgun/Rust notices under `Contents/Resources/legal`. Electron's own license
and Chromium notice remain in `Contents/Resources`.

Tagged GitHub releases use the existing Developer ID and Apple notarization secrets to sign,
notarize, and staple the app before producing `Railgun-<version>-darwin-arm64.dmg` and `.zip`.
Electron Builder also creates public GitHub update metadata and blockmaps. Packaged stable clients
ignore prereleases, downloaded updates install on quit, and updater failures do not terminate the
application.

Each release also includes `Railgun-appcast-arm64.xml`, signed with the existing Sparkle EdDSA key,
so installations of the retired pre-Electron application can replace themselves with the same
signed Electron ZIP. Appcast generation verifies that the public release secret exactly matches
the ZIP application's injected `SUPublicEDKey` and requires Sparkle to produce a signature from the
matching private key. Electron does not bundle or execute Sparkle.

The repository-level release command updates this package version, creates the version commit, and
adds the annotated tag:

```sh
scripts/release-version.sh patch --dry-run
```

Release validation scripts live in `scripts/release`. They verify the embedded backend lifecycle,
arm64-only binaries, package metadata, legal/runtime notices, signatures, hardened runtime,
Gatekeeper, stapling, archive layout, update metadata, and the compatibility appcast. Signed
release validation runs the application checks against the staging bundle and the exact
`Railgun.app` copies extracted from the ZIP and mounted from the DMG.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
