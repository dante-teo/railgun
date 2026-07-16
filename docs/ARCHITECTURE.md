# Railgun desktop architecture

Railgun is a macOS Electron app. Electron main owns all privileged work and
exposes a fixed, validated IPC surface through preload. The React renderer
cannot access the filesystem, processes, launchctl, credentials, or arbitrary
IPC channels.

The agent backend is deployed to `Resources/backend/railgun` and is started by
the app’s embedded Electron executable with `ELECTRON_RUN_AS_NODE=1`. Its
versioned JSONL transport is private to Electron main and the child backend.
User state remains under `~/.railgun`.

The Scheduled page manages job definitions through the backend. Settings → General
owns the separate Background automation control, a narrowly scoped main-process
service that writes only the `sh.railgun.cron` and `sh.railgun.dream` launch
agents in the current user `gui/<uid>` domain. The scheduler is long-running and
restarts after unexpected crashes; Dream is a midnight one-shot task. Missing
credentials cause either background entry to exit normally without browser
authentication.

Desktop release configuration is owned by `apps/desktop/package.json`. Direct
and Homebrew builds carry immutable update-channel values, preventing two
updaters from controlling one installed app. Direct releases retain
`darwin-arm64` or `darwin-x64` in their GitHub ZIP artifact names so the
GitHub-backed Electron updater can find them. Direct installations check
automatically and expose **Railgun → Check for Updates…** for an explicit
check; downloaded updates require the user's restart confirmation. Homebrew
archives are a separate channel and only the Cask updates those installations.

The update-check modal loads the same packaged Vite renderer with
`?surface=update-check`; it does not inject a second HTML/CSS application. The
renderer marks that document surface before mounting so the modal can opt out
of the main app's 760×520 floor while retaining the shared semantic tokens,
system appearance, motion preference, and glass accessibility fallbacks. The
window remains hidden until `ready-to-show` and closes if renderer loading
fails.
