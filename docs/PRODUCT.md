# Railgun product

Railgun is an Electron coding-agent application for Apple-silicon Macs running macOS 15 or newer.
The direct signed application is the only supported installation and release surface. Its bundled
Rust backend is an implementation detail, not a separately distributed product.

## Current desktop surface

Railgun opens on Tasks. The resizable shell contains a collapsible Sidebar, Workspace, optional
Detail pane, and collapsible Inspector. Pane dimensions and collapsed state persist locally.

The task list loads conversation sessions from `~/.railgun`, shows each title and last-message
date, resumes complete active-branch transcripts, and keeps selection attached to the backend's
active session. Archiving removes a task optimistically and restores it if the backend rejects the
mutation. Archived Tasks in Settings can search archived rows, restore them, permanently delete one,
or purge the complete archive after confirmation. Archive mutations remain locked while task-run
state is active or unavailable.

The transcript renders user prompts, streaming and persisted assistant Markdown, bounded tool
activity, approvals, and clarifications. Raw thinking, provider arguments, and non-shell result
payloads do not cross the renderer boundary. Shell command and output projections are bounded and
have terminal control sequences removed. Legacy transcript rows without semantic event timing
remain untimed.

The composer supports text plus file and folder attachments. An accepted prompt appears
immediately, remains attached to its session throughout a run, and is reconciled with authoritative
persisted history after completion. The user can stop an active run and respond to approval or
clarification requests without a second preload API surface.

The model selector updates the active session through the backend and adopts a forked session when
the model change creates one. The approval selector exposes Ask for approval, Approve for me, and
Full access. File deletion requires fresh authorization outside Full access. Railgun's backend
still blocks its hard destructive-command patterns in every mode.

The context ring reports the latest provider-measured input and output usage. The Activity surface
shows the current Advisor note, TODO state, and bounded subagent exchanges. Tagged stale activity
frames are rejected after a newer run starts.

Settings is available at `/settings/general`, `/settings/appearance`,
`/settings/personalization`, `/settings/skills`, and `/settings/archived-tasks`; `/settings`
redirects to General. It reuses the primary Sidebar and the persisted Content/Detail split, but the
Inspector and its controls are structurally absent on every Settings route. Returning to Tasks
restores the prior Inspector preference.

General manages the future-task default model, Advisor, approval behavior, and the macOS background
scheduler. Appearance applies Auto, Light, or Dark immediately and persists the choice locally.
Personalization edits `~/.railgun/SOUL.md` and saved memories. Skills manages private Markdown skill
files under `~/.railgun/skills`. Valid editor drafts save before in-app navigation; invalid or failed
saves keep the user on the current route. The Scheduled navigation label remains non-routed because
background scheduler management lives in General. Inspector content on Tasks remains static
presentation data.

## Production lifecycle

The packaged application launches
`Railgun.app/Contents/Resources/backend/railgun-backend desktop`, uses the existing `~/.railgun`
data and credential, and owns `~/.railgun/desktop-client.lock` for the complete child-process
lifetime. A missing executable, launch error, initialization error, or unexpected backend exit is
fatal to the desktop process. Development source and mock launch modes remain explicit.

Electron checks public `dante-teo/railgun` GitHub Releases after startup. Stable versions ignore
prereleases; prerelease versions may follow prerelease updates. Downloads are installed on quit.
Update failures are diagnostic-only and do not terminate Railgun.

The application identity remains `io.anvia.railgun`, so an update from the retired pre-Electron
application keeps `~/.railgun` sessions and credentials in place. Release ZIPs also appear in a
signed compatibility appcast for those older Sparkle installations. Sparkle is not bundled in the
Electron application.

## Distribution

Railgun ships only signed and notarized arm64 DMG and ZIP artifacts for macOS 15 or newer. There are
no Windows, Linux, Intel Mac, Homebrew, Mac App Store, or standalone backend artifacts.
