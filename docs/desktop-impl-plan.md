# Railgun desktop implementation plan

Target: macOS 26
Stack: Node.js, pnpm, Electron Forge, TypeScript, React

## Goal

Build and maintain a polished macOS desktop application around the Railgun
agent capabilities that already exist in the bundled backend. The desktop
experience should make agent work, scheduled jobs, knowledge, authentication,
and settings understandable without exposing backend privileges to the
renderer.

## Product scope

Railgun has three primary areas:

1. **Task** — sessions, transcript, composer, todos, tools, approvals,
   clarification, model controls, activity, and file preview.
2. **Scheduled** — create, edit, validate, and remove recurring prompts.
3. **Settings** — general automation, agent behavior, trust, provider access,
   knowledge, skills, MCP, and diagnostics.

Knowledge is a grouped Settings section containing memories, imported notes,
semantic and keyword search, Dream consolidation, global instructions, and
read-only skills. The app does not include voice, messaging gateways, remote
workspaces, provider marketplaces, git review, interactive terminal tooling,
or a general-purpose marketplace.

## Capability coverage

| Railgun capability | Desktop experience |
| --- | --- |
| Agent sessions and streaming events | Transcript, composer, stop, steering, follow-up, and recoverable errors |
| Tool execution | Running, success, and error activity rows with bounded redaction |
| Todos | Sticky activity dashboard with status and progress |
| Shell safety | Inline allow/deny prompt while preserving backend hardline blocks |
| Clarification | Inline free-text and choice prompts with keyboard support |
| Sessions | New, filter, resume, checkpoint status, archive, branch, and fork |
| Models and context | Searchable model picker, default selection, usage status, and Compact |
| Mixture of Agents | Preset selection and advisory/aggregation progress |
| Advisor and delegation | Severity-styled notes and current-run subagent activity |
| Files | Read-only home-directory tree, text/image preview, and Finder reveal |
| Scheduled work | Five-field cron CRUD with readable validation |
| Knowledge | Memory editor, note import/search, Dream action, instructions, and skills |
| MCP | Redacted stdio-server configuration for new sessions |
| Authentication | Provider sign-in, sign-out, recovery, and startup status |

## Layout and interaction

The main window is a continuous content canvas with a floating sidebar. Task
uses a toolbar, transcript, optional Activity Dashboard, optional Files pane,
and composer. Scheduled and Settings are full-page destinations; switching
away from Task preserves the active task controller and session state.

The Task surface must provide:

- Markdown replies with sanitized GFM, safe fenced-code labels, and HTTP(S)-only
  external links;
- frame-coalesced streaming text and bottom-follow scrolling that preserves a
  user's reading position;
- FIFO steering and follow-up queues, single-flight Stop, and terminal run
  settlement before unlocking the composer;
- concurrent approval and clarification cards that retain arrival order and
  keep Stop available;
- Activity Dashboard grouping Advisor, Todos, and current-run delegated work;
- a responsive, session-only Files pane that never overlays unreadable task
  content at normal widths.

The sidebar is keyboard accessible, pointer- and keyboard-resizable, and
session-only when collapsed. Task, Scheduled, Settings, and Files controls
remain above the native draggable titlebar region. Dirty Settings forms require
confirmation before navigation, search, or closing a route.

## macOS visual system

Use one shared semantic token system for materials, color, type, spacing,
radius, shadow, focus, and motion. Liquid Glass is reserved for hierarchy:
the floating sidebar, continuous toolbar, composer shell, anchored popovers,
and dialogs. Transcripts, forms, prompts, cards, and long lists use stable
opaque or tonal surfaces.

The renderer follows system light/dark appearance and supports Reduce
Transparency, Increase Contrast, Reduce Motion, keyboard navigation, and
VoiceOver. Reduced Transparency removes backdrop filters; Increase Contrast
strengthens boundaries and focus rings; Reduce Motion removes decorative
transitions. Ordinary buttons remain flat and shadow-free, and shaped actions
must maintain at least 4.5:1 text contrast.

## Technical architecture

```text
React renderer
    ↕ typed preload bridge
Electron main
    ↕ versioned JSONL over stdio
Bundled Railgun backend
```

Electron main owns the window, backend process, native dialogs, external links,
filesystem, shell, launchd automation, credentials, and all IPC validation.
The preload exposes only fixed typed operations. The renderer uses
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict
CSP, and blocked navigation.

The desktop backend keeps its JSONL protocol private to Electron main and the
child process. Main projects backend responses into bounded renderer-safe
snapshots. Raw provider messages, tool calls, tool results, credentials, MCP
secrets, OAuth URLs, and raw configuration never cross the preload boundary.

The interaction broker assigns opaque desktop IDs to approval and clarification
requests. It bounds and redacts text, validates fixed response payloads, and
clears mappings on run settlement, abort, backend restart, process exit,
shutdown, or disconnection. Invalid requests are safely declined or denied and
cannot leave a run waiting indefinitely.

Session mutations request compact acknowledgements, then rebuild the renderer
from authoritative safe transcript and session snapshots. Saved messages carry
only positive persistence IDs, role, and text. Branch and fork operations
validate their selected persisted prefix in the backend.

The file service accepts only validated relative path segments. It canonicalizes
operations below the current user's home directory, rejects traversal and
escaping symlinks, caps directories at 5,000 entries, caps previews at 10 MiB,
limits text to 1 MiB, and normalizes supported images before returning them.

Settings exposes strict redacted snapshots and validated patches. MCP values
are retained in main; the renderer sees server names, a path-redacted command,
arguments, and environment key presence only. Configuration mutations are
atomic, preserve unknown keys, share a mutation queue, and apply to new backend
sessions.

## Automation and distribution

Scheduled owns persistent job definitions and Settings → General owns the
background-automation opt-in. Enabling it installs only
`sh.railgun.cron` and `sh.railgun.dream` in the current user's `gui/<uid>`
launchd domain. The scheduler restarts after an unexpected crash; Dream runs
once at local midnight. Missing credentials cause both background entries to
exit normally without browser authentication.

Direct signed releases and Homebrew Cask releases use separate immutable
update-channel values. Direct builds use the in-app updater and preserve
`darwin-arm64`/`darwin-x64` artifact names. Homebrew builds disable the in-app
updater. The manual update-check surface reuses the packaged Vite renderer and
requires an explicit restart confirmation after download.

## Implementation checklist

- [x] Keep the backend, preload, and renderer boundaries schema-validated.
- [x] Deliver Task transcript, tool activity, todos, approvals, clarification,
      cancellation, steering, follow-up, model, context, and session flows.
- [x] Deliver Scheduled CRUD and Settings automation controls.
- [x] Deliver safe home-directory browsing and Knowledge screens.
- [x] Deliver provider authentication, MCP configuration, diagnostics, and
      recovery states.
- [x] Apply the shared macOS visual and accessibility contracts.
- [x] Build direct and Homebrew release channels for arm64 and x64.
- [ ] Complete clean-run visual, accessibility, performance, crash, reconnect,
      and packaged Electron smoke verification for each release.

## Verification

Run the root typecheck and test suite, then the desktop typecheck and tests:

```sh
pnpm run typecheck
pnpm run test
pnpm --filter @dantea/railgun-desktop typecheck
pnpm --filter @dantea/railgun-desktop test
```

Documentation tests must continue to cover the root README, desktop
architecture, this implementation plan, and the current-state ADR.
