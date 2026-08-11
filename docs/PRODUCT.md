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
mutation. Browsing or restoring already archived tasks is not implemented.

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
Full access. Railgun's backend still blocks its hard destructive-command patterns in every mode.

The context ring reports the latest provider-measured input and output usage. The Activity surface
shows the current Advisor note, TODO state, and bounded subagent exchanges. Tagged stale activity
frames are rejected after a newer run starts.

Scheduled and Settings labels are present in navigation but their application routes are not
implemented. Inspector content is currently static presentation data. Retirement of the previous
desktop implementation does not imply that these remaining surfaces will be ported.

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
