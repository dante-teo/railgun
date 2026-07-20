# 0001 — Railgun current architecture

Date: 2026-07-17

## Status

Accepted. This document records the architecture and product boundaries
implemented by Railgun today.

## Decision

### Product and runtime

Railgun is a signed macOS Electron application for working with an AI coding
agent. Electron main owns privileged operations and starts the bundled Node
backend from `Resources/backend/railgun` with `ELECTRON_RUN_AS_NODE=1`. The
backend communicates with Electron main over a versioned JSONL stream. The
renderer is not a second backend and does not access Node directly.

The supported product areas are Task, Scheduled, and Settings. Knowledge
features—memories, notes, Dream maintenance, skills, and global instructions—
are grouped under Settings. The primary provider is Devin through the `widevin`
dependency. The package remains private and the backend remains an application
component rather than a separately supported command-line or npm product.

### Agent behavior

The agent runs a streaming session loop with typed lifecycle, assistant,
tool, advisor, delegation, todo, and Mixture of Agents events. Each run has
its own cancellation signal and steering/follow-up queues. Stop, disconnect,
timeouts, and backend shutdown settle run-scoped work and discard late events.

The agent can use shell, filesystem, web, memory, notes, cron, skills, MCP,
todo, clarification, approval, advisor, and delegation tools. Shell commands
pass through manual or smart approval, with hardline blocks enforced by the
backend. Tool inputs and outputs are bounded and redacted before they are
shown in the desktop UI.

The system prompt supplies the Railgun runtime surface, paths, model, provider,
identity, project instructions, memories, and operational guidance. Persistent
identity is stored in `~/.railgun/SOUL.md`; project instructions use
`.railgun.md` or `RAILGUN.md`. Configuration and instruction changes take
effect for a new session or backend restart.

Context compaction is available manually and runs automatically at the model
context threshold. It preserves recent user turns and a bounded handoff
summary. A configured Mixture of Agents preset fans out to up to eight
advisory model slots and then invokes an aggregator; an individual advisory
failure does not prevent the primary turn from completing. An optional advisor
can review a turn and emit bounded severity-tagged notes.

### Configuration and storage

Railgun uses `~/.railgun/config.json` as its configuration source. Defaults
are merged with user values, unknown keys are preserved, malformed values are
rejected, and writes are atomic with user-only permissions. Provider model
selection, approval mode, operation timeout, archive retention, advisor
settings, MCP servers, and Mixture of Agents presets are configured there.

Local durable state is held in SQLite under `~/.railgun`, including session
checkpoints, branches, forks, archived sessions, user memories, imported
notes, full-text note indexes, and optional semantic vectors. Cron definitions,
Dream state, skills, instructions, credentials, and bounded diagnostic logs
remain in Railgun-owned paths below the same home directory.

Sessions restore the selected model and a safe transcript projection. Branch
and fork operations validate the selected persisted prefix before updating the
session leaf or creating a new session. The desktop receives only textual
user/assistant history, normalized todos, and bounded metadata; provider
messages, tool arguments, and tool results stay in the backend.

Each attempted cron run produces a separate scheduler-originated session after
the run settles. SQLite `session_deliveries` rows provide a monotonic delivery
sequence, job and status metadata, and unread state without changing existing
interactive sessions. Delivery is atomic with session creation and retains a
hidden generic scheduled-result trigger plus one final assistant result, not
the cron prompt, tools, intermediate history, or todo snapshot. A synthetic
assistant result keeps hard and empty failures openable. Delivered sessions survive cron-definition removal
and preserve their metadata through follow-ups, branches, archival, and
restoration. Session summary responses remain bounded to the newest 500
entries; when recurring deliveries overflow active capacity, the oldest
scheduled deliveries move to Archive rather than being deleted.

Railgun always uses the current user's home directory as its workspace. There
is no project picker, project-local extension loading, or per-project trust
database. Extensions load from the global Railgun extensions directory. MCP
servers use stdio and are started for a session; one failing server is
isolated from the rest of startup.

### Authentication and security

Devin authentication supports a cached file credential and the process-local
`DEVIN_TOKEN` environment variable. A nonempty environment token takes
precedence and is never modified by logout. Rejected cached credentials are
removed and rejected environment credentials are left unchanged with
source-specific recovery guidance. Failed turns are not replayed automatically.

All asynchronous provider, tool, extension, advisor, delegation, and
compaction work is bounded by an operation timeout and abort signal where
applicable. Shell cancellation terminates the process group. Credentials,
MCP environment values, OAuth URLs, and raw configuration do not enter the
renderer or ordinary diagnostic output.

### Desktop boundary

Electron main is the sole owner of the backend process, filesystem, shell,
launchd, credentials, native dialogs, and external-link handling. The
preload bridge exposes a narrow typed API with strict schemas. The renderer
uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a
strict content security policy, blocked navigation, and allowlisted HTTP(S)
links.

Renderer-facing data is projected, bounded, normalized, and redacted in main.
Approval and clarification prompts use opaque desktop correlation IDs; backend
request IDs remain private to main. Open prompts preserve arrival order,
support concurrent cards, keep Stop available, and settle on cancellation,
restart, exit, shutdown, or disconnection. Malformed interaction frames use a
safe denial or abort path.

Scheduled delivery metadata crosses the RPC and preload boundaries through
strict additive schemas. Electron main polls a lightweight monotonic delivery
cursor while the backend is ready and pushes a newly validated session list
only when it advances. The renderer updates its navigation without stealing
focus. Loading and other internal operations are side-effect free; only
successful activation after model preparation marks a scheduled session read.
Presentation hides the initial generic scheduled-result trigger while
preserving it in backend history for follow-ups.

The file browser is read-only and rooted at the user's home directory. Main
validates path segments, rejects traversal and escaping symlinks, caps
directory and preview sizes, and returns only text or normalized supported
image payloads. Scheduled jobs expose only bounded editable fields. Settings
exposes redacted snapshots and validated mutations; secrets are retained in
main and changes apply to new backend sessions.

### User interface

Task presents the streaming transcript, composer, approvals, clarification,
todos, tool activity, advisor notes, delegated work, model/context controls,
session navigation, and an optional read-only Files pane. Scheduled provides
cron CRUD and readable five-field schedule validation. Settings provides
General, Agent, Trust, Knowledge, Provider, MCP, and Diagnostics sections.

Each scheduled attempt appears as an unread Task without changing the active
task or sending a macOS notification. Scheduled indicators are exposed in the
sidebar and task palette, the prompt supplies the task title, and incomplete or
failed attempts show an inline warning until the user chooses how to continue.

The renderer uses shared semantic tokens and a restrained macOS Liquid Glass
hierarchy. The floating sidebar and toolbar communicate structure; transcripts,
forms, cards, and long lists use calm opaque or tonal surfaces. Light/dark
appearance, Reduce Transparency, Increase Contrast, Reduce Motion, keyboard
navigation, focus indicators, and VoiceOver-friendly semantics are supported.

### Distribution and automation

Direct signed releases and Homebrew Cask releases are separate immutable
update channels. Direct installations use the in-app updater and retain
`darwin-arm64` or `darwin-x64` artifact names. Homebrew installations disable
the in-app updater so Homebrew owns updates. The update-check modal reuses the
packaged renderer with a dedicated surface flag.

The Scheduled page owns job definitions. Settings → General owns the
background-automation opt-in. When enabled, Railgun installs only
`sh.railgun.cron` and `sh.railgun.dream` in the current user's `gui/<uid>`
launchd domain. The scheduler restarts after unexpected failure and Dream runs
once at local midnight. The scheduler invokes backend `cron` and Dream invokes
`dream`; both exit normally when credentials are unavailable.

## Consequences

The desktop boundary keeps secrets and privileged operations out of React while
allowing the UI to expose the implemented agent features. Local SQLite and
JSON state make sessions, knowledge, scheduled work, and recovery available
without a service dependency. The fixed home-directory workspace simplifies
startup and trust handling, while the private JSONL protocol permits the
desktop and backend to evolve together under strict validation.

The application intentionally has no provider marketplace, remote workspace,
voice or messaging surface, interactive terminal, git-review workflow, or
general-purpose plugin marketplace. Those capabilities are outside the
current Railgun product boundary.
