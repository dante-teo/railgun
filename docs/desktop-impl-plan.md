# Railgun Desktop implementation plan

Target: macOS 26  
Stack: Node.js, pnpm, Electron Forge, TypeScript, React

## Goal

Build a beautiful macOS desktop UI for the Railgun features that already exist.

The Hermes desktop app in `tmp_reference/apps/desktop` is a UX reference only. We will not copy features Railgun does not have, and we will not add placeholder infrastructure for them.

## Feature mapping

### Implement

| Reference desktop area | Existing Railgun capability | Desktop implementation |
| --- | --- | --- |
| Task | Agent session and streaming events | Streaming transcript and composer |
| Tool activity | Typed tool start/end events | Running, success, and error rows |
| Todos | Todo tool and persisted todo state | Sticky plan panel |
| Shell approval | Manual/smart/off approval system | Inline allow/deny prompt |
| Clarification | Clarify tool with text or choices | Inline question prompt |
| Cancel and steering | Abort, steer, and follow-up commands | Stop button and queued message state |
| Sessions | SQLite session checkpoints | New, list, filter, resume |
| Branch and fork | Session branch/fork APIs | Message branch action and Fork action |
| Model selection | Model discovery and switching | Searchable model picker |
| Context compaction | Manual and automatic compaction | Context status and Compact action |
| MoA | MoA presets and progress events | Preset selector and progress |
| Advisor | Advisor config and messages | Settings and severity-styled notes |
| Subagents | Delegation start/end events | Simple current-run activity list |
| Project folder | `--cwd`, project context, trust gate | Folder picker and trust prompt |
| Files | File tools operate in the project folder | Read-only file tree and preview |
| Cron | List/add/update/remove jobs | Simple cron CRUD screen |
| Memories | Memory store CRUD/search | Memory list and editor |
| Notes | Import and keyword/semantic search | Import and search screen |
| Dream | Memory consolidation | Consolidate Memory action |
| Skills | Local skill discovery and viewing | Read-only skills list and detail |
| MCP | `mcpServers` configuration | MCP server configuration form |
| Settings | Railgun config fields | Model, approval, trust, timeout, MoA, advisor, MCP |
| Authentication | Devin login/logout/token handling | Sign-in, sign-out, and recovery UI |

### Do not implement

The reference also has product areas Railgun does not have. They are outside this project and receive no routes, abstractions, or tickets:

- voice, pets, messaging gateways, profiles, cloud/remote connections;
- provider marketplace and multi-provider account management;
- starmap, artifact gallery, skills marketplace, and MCP marketplace;
- interactive terminal, git review/commit/PR UI, and worktree management;
- cron pause/history/delivery features;
- Hermes runtime installer/updater.

## Product layout

Keep the app to four main areas:

1. **Task** — sessions, transcript, composer, todos, tools, approvals, and file preview.
2. **Automation** — cron jobs.
3. **Knowledge** — memories, notes, Dream, and skills.
4. **Settings** — model, agent behavior, trust, MCP, authentication, and diagnostics.

The main content canvas spans the full window. The sidebar is a floating pane
over that canvas rather than a separate grid column, so the area around it and
the main pane read as one uninterrupted surface:

```text
┌──────────────────── full-window content canvas ────────────────────┐
│  ╭─ floating sidebar ─╮  titlebar / toolbar                       │
│  │ New task           │                                           │
│  │ Sessions           │  transcript          optional inspector   │
│  │ Automation         │                                           │
│  │ Knowledge          │  composer                                 │
│  │ Settings           │                                           │
│  ╰────────────────────╯                                           │
└────────────────────────────────────────────────────────────────────┘
```

## macOS 26 design direction

The app should look native to macOS 26, using Liquid Glass deliberately rather than applying blur everywhere.

- Use glass selectively where it communicates hierarchy: the floating sidebar,
  toolbar, anchored popovers, dialogs, and sheets. Keep the effect subtle;
  transparency, tint, blur, borders, and depth should support the content rather
  than become decoration of their own.
- Keep transcripts, code, forms, cards, the composer, prompts, and long lists on
  calm opaque or lightly tonal surfaces.
- Use a transparent titlebar with correct traffic-light spacing and native window behavior.
- Use restrained depth, edge highlights, adaptive tint, and short fluid transitions.
- Support light/dark appearance, Reduce Transparency, Increase Contrast, and Reduce Motion.
- Use one shared token system for materials, color, type, spacing, radius, shadow, and motion.
- Avoid nested glass cards and generic web-dashboard styling.

### Implemented shell contract

- The main canvas is a flat, continuous surface. The floating sidebar owns its
  subtle glass tint; no divider, shadow seam, or sidebar material may
  extend into the surrounding canvas.
- `--sidebar-gutter` supplies the same outer inset on every sidebar edge.
- Electron's traffic-light position and the renderer's titlebar tokens are a
  coordinated contract. The toolbar title/subtitle block and present or future
  toolbar actions share `--titlebar-control-center-y`, keeping them vertically
  aligned with the traffic lights.
- The toolbar's borderless blurred fade spans the full window behind the inset
  sidebar. Sidebar expansion changes the toolbar content inset, not the material
  width; no sidebar edge may create a toolbar color seam.
- One labelled `PanelLeft` control collapses and restores the sidebar. It is a
  ghost button at the sidebar's top-right while expanded and a circular glass
  button beside the traffic lights while collapsed. Collapse state is
  session-only; the hidden sidebar is inert and removed from the accessibility
  tree.
- Sidebar width is clamped, pointer- and keyboard-resizable, and stored in a
  versioned renderer-local record. Main-pane content follows the live sidebar
  width while the toolbar material remains full-window. The optional inspector
  uses the same infrastructure but is omitted from the DOM and accessibility
  tree until a feature supplies real content.
- Task uses one full-height overlay grid cell for toolbar, transcript, operation
  errors, and composer. Error banners sit below the toolbar fade and follow the
  sidebar inset. The native transcript scrollbar is hidden in favor of one
  centered dash rail that is hidden without overflow, grows from four dashes to
  a height-capped maximum as history accumulates, and changes existing dashes
  to show position. New content follows only while the viewport remains at the
  bottom; any user-driven scroll away preserves the reading position until the
  viewport returns to the bottom.
- Renderer components consume semantic CSS custom properties and shared
  material recipes instead of raw palette values. Reduced Transparency removes
  blur, Reduced Motion removes animated transitions, and Increase Contrast uses
  stronger solid boundaries and focus indicators.
- Liquid glass is contextual to toolbar controls. Ordinary buttons are flat and
  shadow-free; a shaped tonal action must have a visibly distinct fill and at
  least 4.5:1 text contrast, otherwise it should use the plain text treatment.
- Dialogs default to no decorative close button and finish with explicit footer
  actions. Dropdown callouts include an anchored arrow; selects use the same
  dense menu material without a trigger arrow.

Design references:

- [Apple: Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass)
- [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

## Technical shape

```text
apps/desktop/
├── forge.config.ts
└── src/
    ├── main/       # window, Railgun child process, native dialogs
    ├── preload/    # narrow typed bridge
    ├── renderer/   # React UI
    └── shared/     # IPC types and validation
```

The renderer must not run Railgun or access Node directly.

```text
React renderer
    ↕ typed preload API
Electron main
    ↕ JSONL over stdio
Railgun child process
```

Extend Railgun's existing RPC transport for desktop use. Keep current `--mode rpc` behavior compatible, while desktop mode adds:

- persistent session list/load/save/branch/fork;
- shell approval request/response;
- clarification request/response;
- config, cron, memory, notes, skills, and MCP operations;
- authentication and startup status.

Security defaults:

- `contextIsolation: true`;
- `sandbox: true`;
- `nodeIntegration: false`;
- strict CSP and blocked renderer navigation;
- validated IPC messages;
- file access restricted to the selected project folder;
- sanitized Markdown and allowlisted external links;
- no credentials or MCP secrets sent to the renderer.

### Desktop interaction boundary

Approval and clarification requests are the one interactive extension to the
reduced renderer event stream. The backend's RPC request IDs remain main-process
state: `interactionBroker` validates and redacts bounded request content, then
assigns an opaque desktop correlation ID before sending the closed request
shape through preload. Renderer responses accept only that opaque ID and the
fixed approval or clarification payload; they never receive unrestricted IPC or
the backend request ID.

Prompt cards preserve backend arrival order and may remain open concurrently.
They lock the ordinary composer while keeping Stop available. Approval Escape
maps to denial; clarification Escape submits `[user declined to answer]`.
Response failures keep the card open with an inline retryable error. Invalid
backend interaction frames are declined or denied when their request ID is
usable, with abort as the safe fallback, so malformed input cannot crash the
main process or leave a run waiting indefinitely. Broker mappings and renderer
prompt state are cleared on agent run settlement, abort, backend restart,
process exit, shutdown, or disconnection. Hardline shell blocks remain owned by
the backend and have no desktop bypass.

### Desktop session-mutation boundary

Saved transcript messages may carry only an optional positive persistence
`messageId` in addition to their projected role and text. IDs are aligned with
decoded active-branch history before tool-only provider messages are filtered;
internal `branch_summary` rows never receive a renderer projection. Desktop
branch and fork calls set `includeMessages: false`, validate the narrow mutation
acknowledgement in Electron main, and then rebuild the renderer exclusively from
the paginated safe transcript and authoritative session state. Raw provider
messages therefore remain compatible for existing RPC clients without crossing
the desktop IPC boundary. Branch markers are emitted only for persisted,
complete assistant-turn boundaries, and persistence revalidates the selected
prefix before moving its leaf. Forks use bounded independent identifiers rather
than recursively extending their source session IDs.

### Desktop chat-control boundary

The renderer never receives `config_get` output or provider model objects
directly. Electron main combines `get_available_models`, `get_state`, and
`config_get` into a strict bounded snapshot containing display-safe model
metadata, the active and configured-default model IDs, message count, parsed
MoA summaries, advisor state, and the selected model's context window. Preload
exposes only `getChatControls`, `setChatModel`, `updateAgentControls`, and
`compactContext`, validating arguments and results on both sides of IPC.

Model changes are session-only unless the user explicitly selects `Make
default`. That path changes the active task first and then atomically persists
the configured model; persistence failure returns a partial result explaining
that the task changed but the default did not. MoA and advisor updates persist
for subsequent runs and do not alter work already in progress. Selecting MoA
Off uses the generic config patch's narrow `activeMoaPreset: null` deletion
semantics, while advisor updates replace only the advisor object and preserve
unknown configuration fields.

Provider `turn_end` events may include exact input/output usage totals. Main
reduces those totals and automatic compaction lifecycle events into bounded
desktop context events. The renderer never estimates tokens: it displays the
latest exact total against the active model's context window, then clears that
measurement after model changes, compaction, backend restart, or New Task.
Manual Compact remains available inside Agent settings, is disabled during a
run/control mutation or for empty history, and refreshes authoritative controls
after successful completion.

## Local tickets

Status: `[ ]` backlog, `[>]` active, `[x]` complete.

### Foundation

- [x] **DESK-001 — Scaffold Electron Forge app**
  - Add `apps/desktop` to the pnpm workspace.
  - Configure Forge, Vite, React, TypeScript, dev, build, and package scripts.
  - Keep the existing CLI build and package unchanged.
  - Package a production-only root CLI deployment and bundled mock backend as
    Forge resources, launched through Electron's embedded Node runtime.
  - Run the real CLI boundary with `pnpm dev`, or the deterministic mock child
    with `pnpm dev:mock`.
  - Add new mock behavior to the typed scenario registry with success, empty,
    loading, error, cancellation, and disconnection coverage as each desktop
    feature is implemented.

- [x] **DESK-002 — Secure the Electron boundary**
  - Load packaged renderer assets only through the standard, secure
    `railgun://app/` protocol; development remains on Forge's exact Vite origin.
  - Validate every preload argument, response, and pushed event with shared Zod
    schemas, and authorize IPC only from a known Railgun window's trusted main
    frame and expected environment-specific origin.
  - Harden `BrowserWindow`, CSP, navigation, popups, webviews, downloads,
    permissions, and unexpected renderer creation. Production disables DevTools.
  - Apply a complete production fuse policy with ASAR integrity and ASAR-only
    loading. `RunAsNode` is deliberately retained because DESK-001's packaged
    real and mock JSONL backends use Electron's embedded Node runtime.
  - Replace the mock-first diagnostic screen with the desktop task shell. Both
    modes use the same prompt/abort/new-task transport and reduced renderer
    event stream. At this milestone New Task restarted the supervised child so the RPC history was
    actually empty; mock scenarios remain under Settings diagnostics.

- [x] **DESK-003 — Add desktop RPC support**
  - Add protocol handshake/versioning.
  - Add persistent sessions, approval, clarification, and supported store commands.
  - Preserve the existing RPC protocol behavior for current clients.

- [x] **DESK-004 — Supervise the Railgun process**
  - Start, stop, and restart the local Railgun child.
  - Parse size-limited JSONL events and keep bounded, redacted summaries.
  - Terminate with a bounded SIGTERM/SIGKILL sequence, reject calls from stopped
    generations, and ignore stale child events without automatic crash loops.
  - Keep desktop RPC authentication non-interactive: missing or rejected Devin
    credentials surface authentication-required with source-aware recovery
    guidance. File credentials recover through terminal login and Retry;
    rejected environment credentials require updating `DEVIN_TOKEN` and
    relaunching Railgun.
  - Show starting, ready, authentication-required, failed, and disconnected
    states, with retry recovery for terminal states.

### Shell and design

- [x] **DESK-005 — Build the Liquid Glass design system**
  - Create semantic material, color, type, spacing, radius, shadow, and motion tokens.
  - Create shared buttons, inputs, menus, sheets, dialogs, lists, loading, empty, and error states.
  - Add accessibility fallbacks for reduced transparency/motion and increased contrast.

- [x] **DESK-006 — Build the native Mac shell**
  - The transparent titlebar, traffic-light alignment, and session-only
    collapsible floating sidebar foundation are implemented.
  - Reusable sidebar/main/optional-inspector layout, accessible separators,
    clamped resizing, double-click reset, versioned renderer-local pane widths,
    and flexible main/toolbar geometry are implemented. Inspector markup is not
    rendered without content; persistent session navigation remains DESK-011.
  - Native application, Edit, View, and Window menus dispatch only the closed
    app-command enum. If no Railgun window is focused, commands reactivate an
    existing window or create one; preload buffers schema-valid commands until
    the new renderer subscribes.
  - Native context menus expose only applicable standard edit roles. The shared
    renderer registry powers the accessible `⌘K` palette and keyboard handling;
    macOS application shortcuts require Command, preserving Control-only text
    editing keys.

### Task

- [x] **DESK-007 — Build transcript and composer**
  - Stream assistant text efficiently.
  - Render completed sanitized Markdown and code blocks.
  - Support multiline input, send, queued steering/follow-up, stop, and error recovery.
  - Assistant deltas are frame-coalesced and displayed as plain text until the
    backend's assistant message boundary. Completed messages render sanitized
    GFM (headings, lists, tables, inline code, and labelled fenced code); raw
    HTML and non-HTTP(S) links are inert. Valid absolute HTTP(S) links pass
    through validated preload/main IPC and open in the system browser while
    renderer navigation remains blocked.
  - In an idle composer, Enter sends and Shift+Enter inserts a newline. During
    an active run, Enter queues steering and nonempty Tab queues a follow-up;
    empty Tab retains normal focus navigation. Accepted items remain in a
    labelled queue until a backend queue update reports their injection, at
    which point they enter the transcript in FIFO order (including duplicates).
  - Stop is single-flight. An abort RPC acknowledgement confirms signal
    delivery only: it clears cancelled queue presentation, but the composer
    remains in its active/stopping state and late deltas stay in the current
    assistant boundary until `run-end`. That terminal event alone unlocks the
    composer, marks partial output stopped (or normally completed), and clears
    every remaining run-scoped queue entry. Queue acknowledgements that race
    with stopping are ignored without clearing the draft.
  - Initial-command, queued-command, abort, and disconnect failures retain
    recoverable user state: Retry never duplicates the initial user message,
    rejected queue drafts remain editable, stale failures after New Task are
    ignored, and partial assistant output is finalized.

- [x] **DESK-008 — Render agent activity**
  - Tool running/success/error rows use native accessible disclosures with recursively redacted, pretty-formatted input/output capped at 8,000 characters per field. Redaction covers secret-bearing object keys, Bearer/token-shaped credentials, and unstructured assignments such as `PASSWORD=`, `DEVIN_TOKEN=`, and `api_key:`.
  - Successful todo completions replace the sticky inspector snapshot without duplicating transcript rows; todo loading, textual status, completion count, and current-run subagents share the optional non-resizable floating inspector, which becomes an overlay at constrained widths without being unmounted.
  - MoA references/aggregation, severity-labelled advisor notes, and tool activity share one chronological transcript; stop, disconnect, run end, and New Task settle or clear run-scoped work.
  - The main-process event boundary bounds all renderer-facing strings, parses advisory XML without forwarding it, validates normalized todos, and rejects malformed activity. RPC-created sessions activate the configured MoA preset and enabled advisor.
  - Tool-call IDs correlate only an in-flight invocation: settled IDs may be reused by later turns without suppressing their rows. Failed initial/backend runs retain the danger-styled Retry/Restart presentation.
  - The `agent-activity` mock covers parallel success/error tools, todo loading/update, MoA, advisor, and subagent events while cancellation and disconnection scenarios remain available. Mock integration tests use a persistent buffered line reader so fragmented or coalesced stdout frames are never discarded between assertions.

- [x] **DESK-009 — Implement approval and clarification prompts**
  - Correlated shell allow/deny UI that preserves Railgun's hardline blocks;
    mock coverage includes both allow and deny outcomes.
  - Choice and free-text clarification UI, with keyboard navigation, Escape
    decline behavior, inline errors, and multiple prompt ordering.
  - Main-process broker correlation keeps backend IDs private, bounds and
    redacts prompt text, and safely settles malformed requests.
  - Abort, run end, backend restart, process exit, shutdown, and disconnection
    settle every open prompt without hanging; the deterministic mock covers
    cancellation and disconnect behavior.

- [x] **DESK-010 — Add model and context controls**
  - The composer's quiet footer exposes a searchable, keyboard-accessible model
    picker with explicit `This task` and `Make default` choices. Default
    persistence happens after the active-task switch, so write failure can
    report a partial result without losing the successful session change.
  - One Agent settings dialog contains the persisted MoA preset, advisor toggle,
    advisor model, and manual Compact action. Mutations are disabled while a run
    or another control mutation is active; Compact is also disabled for empty
    history and clears measured usage only after success.
  - Context status uses the latest exact provider-reported input and output token
    totals against the selected model's context window. It returns to `Not
    measured yet` after model changes, compaction, backend restart, or New Task.
  - Main and preload expose only bounded control snapshots and fixed validated
    operations. Raw configuration and unknown configuration keys never cross
    into the renderer; MoA Off removes `activeMoaPreset`, advisor replacement
    touches only its object, and unrelated configuration fields are preserved.
  - Deterministic mocks cover populated and empty model catalogs, successful and
    delayed compaction, mutation rejection, cancellation, and disconnection.

### Sessions and projects

- [x] **DESK-011 — Build persistent session navigation**
  - New task, newest-first session list, filter, resume, and checkpoint status.
  - Restore the last valid route after relaunch.
  - Completed contract:
    - Main combines `session_list`, `session_new`, `session_load`, `get_state`,
      and the byte-bounded, paginated `session_transcript` projection behind
      strict desktop schemas. Only textual user/assistant history and normalized
      todos cross the renderer boundary; thinking, tool calls, arguments,
      results, and raw provider fields do not. Desktop requests a metadata-only
      load, so even provider histories larger than a JSONL frame restore safely
      while legacy RPC clients retain the existing full-history response.
    - The sidebar preserves backend newest-first ordering and opens a dedicated
      task-search palette from its top-right action. The palette filters locally
      by preview/model/session ID and exposes loading, empty, no-match, retryable
      error, active, and operation-disabled states. Active runs settle before a
      new or resumed session is activated, and failed switches retain the
      current renderer state.
    - New Task uses `session_new` without restarting the backend. New/resume and
      prompt settlement and model changes broadcast authoritative snapshots so
      transcript, todos, controls, active session identity, checkpoint status,
      and the saved-session list stay synchronized.
    - The toolbar uses the first user preview with bounded fallbacks and exposes
      pending, saved, unsaved, and accessible checkpoint-failure detail states.
      Only the versioned Task/Settings area record is restored after relaunch;
      malformed, obsolete, and unknown values fall back to Task.
    - The deterministic mock includes ordered populated sessions, a long rich
      history fixture with Markdown and every todo state, delayed new/load/list
      operations, empty/error stores, cancellation, disconnection, and
      checkpoint state transitions.

- [x] **DESK-012 — Add branch and fork**
  - Branch from a message, with optional summary.
  - Fork the active session.

- [ ] **DESK-013 — Add project folder and trust flow**
  - Folder picker and recent folders.
  - Resolve canonical cwd and ask for trust before session startup.
  - Persist only the existing Railgun trust choices.

- [ ] **DESK-014 — Add safe file browsing**
  - Lazy read-only tree inside the selected project.
  - Text/image preview and Reveal in Finder.
  - Reject traversal, symlink escape, oversized, unreadable, and binary previews safely.

### Railgun management

- [ ] **DESK-015 — Build Settings**
  - Edit only supported Railgun fields.
  - Preserve unknown config keys and write atomically.
  - Include Devin sign-in/sign-out and redacted diagnostics.

- [ ] **DESK-016 — Build Automation**
  - List, create, edit, and delete cron jobs.
  - Validate five-field cron schedules and show a readable summary.

- [ ] **DESK-017 — Build Knowledge**
  - Memory search/create/edit/delete.
  - Notes folder import plus keyword and semantic test search.
  - Dream/consolidation action with progress.

- [ ] **DESK-018 — Build Skills and MCP screens**
  - Read-only local skills list and detail.
  - Add/edit/remove MCP stdio server configuration.
  - Mask MCP environment secrets and explain that changes apply to new sessions.

### Verification and release

- [ ] **DESK-019 — Add desktop tests and performance fixtures**
  - Unit/component tests, fake-backend protocol integration, and Electron smoke tests.
  - Test long transcripts, rapid streaming, many tool calls, file trees, crashes, and reconnects.
  - Verify the renderer does not rerender the whole app for every token.

- [ ] **DESK-020 — Accessibility and visual QA**
  - Keyboard-only and VoiceOver pass.
  - Light, dark, reduced transparency, increased contrast, and reduced motion pass.
  - Visual QA at minimum, default, and full-screen window sizes.

- [ ] **DESK-021 — Package the macOS app**
  - Build arm64 and x64 DMG/ZIP artifacts.
  - Add the final layered app icon, signing, hardened runtime, and notarization.
  - Run the complete workflow on a clean Mac.

## Delivery order

1. **Foundation:** DESK-001 to DESK-004.
2. **Usable desktop task:** DESK-005 to DESK-011 and DESK-013.
3. **Full existing-feature coverage:** DESK-012 and DESK-014 to DESK-018.
4. **Release quality:** DESK-019 to DESK-021.

The first usable milestone is complete when a user can launch the app, sign in, select and trust a project folder, work with streaming tools/todos, answer approvals and clarifications, stop a run, and resume the saved task after relaunch.
