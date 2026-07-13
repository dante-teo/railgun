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
| Chat | Agent session and streaming events | Streaming transcript and composer |
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
| Rollback | Shadow-git checkpoints | Confirmed Rollback action |
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

1. **Chat** — sessions, transcript, composer, todos, tools, approvals, and file preview.
2. **Automation** — cron jobs.
3. **Knowledge** — memories, notes, Dream, and skills.
4. **Settings** — model, agent behavior, trust, MCP, authentication, and diagnostics.

Use a standard Mac layout:

```text
┌─ sidebar ─────┬─ chat/content ─────────────┬─ optional inspector ─┐
│ New chat      │ transcript                 │ files / tool detail  │
│ Sessions      │                            │                      │
│ Automation    │                            │                      │
│ Knowledge     │ composer                   │                      │
│ Settings      │                            │                      │
└───────────────┴────────────────────────────┴──────────────────────┘
```

## macOS 26 design direction

The app should look native to macOS 26, using Liquid Glass deliberately rather than applying blur everywhere.

- Use glass for the titlebar, sidebar, toolbar controls, floating composer controls, popovers, and sheets.
- Keep transcripts, code, forms, and long lists on calm readable surfaces.
- Use a transparent titlebar with correct traffic-light spacing and native window behavior.
- Use restrained depth, edge highlights, adaptive tint, and short fluid transitions.
- Support light/dark appearance, Reduce Transparency, Increase Contrast, and Reduce Motion.
- Use one shared token system for materials, color, type, spacing, radius, shadow, and motion.
- Avoid nested glass cards and generic web-dashboard styling.

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
  - Replace the mock-first diagnostic screen with the desktop chat shell. Both
    modes use the same prompt/abort/new-chat transport and reduced renderer
    event stream. New Chat restarts the supervised child so the RPC history is
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

- [ ] **DESK-005 — Build the Liquid Glass design system**
  - Create semantic material, color, type, spacing, radius, shadow, and motion tokens.
  - Create shared buttons, inputs, menus, sheets, dialogs, lists, loading, empty, and error states.
  - Add accessibility fallbacks for reduced transparency/motion and increased contrast.

- [ ] **DESK-006 — Build the native Mac shell**
  - Transparent titlebar and correct traffic-light spacing.
  - Session sidebar, main content, optional inspector, resizing, and saved pane widths.
  - Native application menu, context menus, `⌘K` command palette, and keyboard shortcuts.

### Chat

- [ ] **DESK-007 — Build transcript and composer**
  - Stream assistant text efficiently.
  - Render completed sanitized Markdown and code blocks.
  - Support multiline input, send, queued steering/follow-up, stop, and error recovery.

- [ ] **DESK-008 — Render agent activity**
  - Tool running/success/error rows with safe expandable detail.
  - Sticky todo panel.
  - MoA progress, advisor notes, and simple subagent activity.

- [ ] **DESK-009 — Implement approval and clarification prompts**
  - Correlated shell allow/deny UI that preserves Railgun's hardline blocks.
  - Choice and free-text clarification UI.
  - Abort or backend exit must settle every open prompt without hanging.

- [ ] **DESK-010 — Add model and context controls**
  - Searchable model picker with persistent or session-only selection.
  - MoA preset selector and advisor controls.
  - Context status and manual Compact action.

### Sessions and projects

- [ ] **DESK-011 — Build persistent session navigation**
  - New chat, newest-first session list, filter, resume, and checkpoint status.
  - Restore the last valid route after relaunch.

- [ ] **DESK-012 — Add branch, fork, and rollback**
  - Branch from a message, with optional summary.
  - Fork the active session.
  - Confirm rollback and refresh affected UI afterward.

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
2. **Usable desktop chat:** DESK-005 to DESK-011 and DESK-013.
3. **Full existing-feature coverage:** DESK-012 and DESK-014 to DESK-018.
4. **Release quality:** DESK-019 to DESK-021.

The first usable milestone is complete when a user can launch the app, sign in, select and trust a project folder, chat with streaming tools/todos, answer approvals and clarifications, stop a run, and resume the saved session after relaunch.
