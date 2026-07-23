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
restarts after unexpected crashes and invokes the backend `cron` command; Dream
invokes `dream` as a midnight one-shot task. The private backend resolves
`cron` to its scheduler mode and retains `scheduler` as a compatibility alias.
Missing
credentials cause either background entry to exit normally without browser
authentication.

The scheduler shares the SQLite session store for its full lifecycle. After
each cron attempt settles and its report is generated, it atomically creates a
new `cron-<uuid>` session and `session_deliveries` row. The delivery row owns
the ordered cursor, RPC-bounded job ID, normalized title, run status, delivery
time, and read time; its session reference cascades on session deletion.
Oversized job IDs are deterministically normalized before persistence so one
valid cron definition cannot invalidate the complete desktop session list.
Each delivered session retains only a hidden generic scheduled-result trigger
and one final assistant result; it excludes the cron prompt, required-output
contract, tool and intermediate history, and todo snapshot. Hard or empty runs
use a concise synthetic incomplete or failed result so every delivery remains
openable. A delivery persistence failure fails the cron attempt, atomically
revises the run report with that final failure, and is logged without claiming
successful delivery.

RPC capability `session.delivery` exposes optional scheduled-delivery metadata
on session summaries and active state plus a lightweight
`session_delivery_cursor` command. Successfully activating a scheduled session
marks it read; internal loads remain side-effect free. Its hidden generic
scheduled-result trigger satisfies transcript invariants and is omitted from
the renderer transcript; later user messages are visible. Electron main polls
the cursor every two seconds while the backend is ready and broadcasts a
schema-validated session list only after it advances. Preload validates that
push again, and the renderer updates navigation without changing the active
task. Scheduled delivery overflow is archived oldest-first, and active and
archived summary queries expose the newest 500 entries, matching the validated
desktop boundary without deleting older persisted sessions.

Desktop release configuration is owned by `apps/desktop/package.json`. The
release pipeline publishes direct arm64 builds only. Direct releases retain
`darwin-arm64` in their GitHub ZIP artifact names so the GitHub-backed Electron
updater can find them. Direct installations check
automatically and expose **Railgun → Check for Updates…** for an explicit
check; downloaded updates require the user's restart confirmation. The updater
still recognizes the legacy Homebrew channel so existing installations do not
unexpectedly invoke Electron's updater.

The update-check modal loads the same packaged Vite renderer with
`?surface=update-check`; it does not inject a second HTML/CSS application. The
renderer marks that document surface before mounting so the modal can opt out
of the main app's 760×520 floor while retaining the shared semantic tokens,
system appearance, motion preference, and glass accessibility fallbacks. The
window remains hidden until `ready-to-show` and closes if renderer loading
fails.
