# Railgun

Railgun contains a production native arm64 macOS agent application and a prototype
Electron client shell. The native app and its private Rust backend communicate
over versioned JSONL RPC on standard input and standard output; diagnostics are
structured, redacted, and written only to standard error.

## Requirements

- macOS 15 or newer on Apple silicon for the native app
- Xcode, the macOS SDK, and XcodeGen at the version in
  `apps/macos/.xcodegen-version` for native development
- The Rust toolchain pinned by `rust-toolchain.toml`
- pnpm 11.20.0 for the Electron app
- `cargo-deny` when reproducing the dependency-policy CI gate locally

## Workspace

The root Cargo workspace contains:

- `railgun-backend`: shared domain/application/adapters library and production
  `railgun-backend` executable.
- `railgun-mock-backend`: deterministic JSONL backend used by native tests and
  development scenarios.
- `railgun-xtask`: migration, fixture, legal-notice, and performance tooling.

The Xcode project is generated from `apps/macos/project.yml`. Generated
`.xcodeproj` directories are disposable and must never be edited.

## Development

Run the Electron app in development mode:

```sh
scripts/run.sh
```

Run it with the deterministic mock backend configuration:

```sh
scripts/run-mock.sh
```

The mock launcher builds `railgun-mock-backend`, selects the `ready-idle`
scenario by default, and then starts Electron. Both scripts forward additional
arguments to `pnpm dev`. They are launch commands, not verification commands.

Electron development and preview commands validate the downloaded Electron
binary before startup. If a package installation was interrupted after the npm
package was linked, the preflight completes the binary installation before
`electron-vite` starts.

The native macOS interface uses the shared `RailgunSpacing` 4, 8, 12, 16, 24,
and 32 point scale.
Transcript rows keep a comfortable 32-point inter-message gap.
Assistant responses use the same selectable Markdown renderer while streaming,
after completion, and when restored from history. Live updates supply complete
accumulated snapshots rather than deltas, so incomplete emphasis, fenced code,
lists, and tables remain presentable without a final renderer swap. Each
assistant row offers **Copy response** for the complete stored Markdown source
and **Select response** for one native selectable surface spanning all Markdown
blocks. User prompts remain literal selectable text. Clickable links must be
credential-free absolute HTTPS URLs; Markdown images may load remotely over
HTTPS, while HTTP and local or bundled image sources remain disabled.
The Activity toolbar button presents a 320×360 popover; it does not reserve
transcript width, and its dashboard scrolls as one native surface when the
content exceeds the popover height. Advisor notes are available from its
Advisor row in a click-to-open, selectable popover.

Model selection remains a native `Menu` whose models are individual `Button`
actions. Selection acknowledges locally before backend confirmation and the
menu locks until that request settles, preventing repeated model changes.
Settings → General also stores a default model for new tasks and an optional
Advisor model; neither setting changes the active task. The model catalog is
loaded at backend startup and cached for ordinary reads and selections.
**Refresh Models** is the explicit network refresh path. If a refresh retires
the active model, Railgun keeps the current task intact and leaves the picker
available so the user can choose a replacement.

When a user supplies an eligible absolute path in their home directory, the
agent can read UTF-8 text files through a local tool; it should not ask for an
upload solely because a file is local.
The tool accepts regular files throughout the user's home directory, including
hidden paths and `~/Library`; macOS privacy controls may still require the user
to grant Railgun folder or Full Disk Access. Reads are bounded in the agent
context, rather than rejected because the file is large. The context ring shows
the latest provider usage while it is available and reports **Not measured yet**
when the provider has supplied no measurement.

### Command approval

Settings → General applies its command-approval mode to the next desktop task:

- **Ask for approval** presents a desktop confirmation for each flagged shell
  command.
- **Approve for me** sends the flagged command and the original user task to
  the selected reviewer model. It runs only when the reviewer returns an exact
  approval; an ambiguous response, missing task context, or reviewer failure
  rejects the command.
- **Full access** runs flagged shell commands without a confirmation prompt.

Railgun always blocks the small set of system- or data-destroying command
patterns regardless of the selected mode. Scheduled and delegated tasks cannot
request desktop approval and do not use model-assisted approval.

### Archived task browser

Settings → Archived Tasks displays archived sessions without changing their
backend order. Search matches title, model, or the full task ID. Restoring a
task returns it to the active task list without opening or resuming it. Context
actions that restore a task or copy its exact ID require exactly one selected row,
so multi-row selection cannot target an arbitrary task.

Electron checks (these do not launch the GUI):

```sh
pnpm --dir apps/desktop test
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop exec prettier --check .
pnpm --dir apps/desktop build
```

Backend-only checks:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
cargo build --locked --release --package railgun-backend
cargo deny check
```

Full native verification:

```sh
apps/macos/scripts/validate-project.sh
```

### Dependency policy

Run `cargo deny check` after changing any Cargo manifest or `Cargo.lock`.
Registry licenses must be reviewed before adding their SPDX identifier to
`deny.toml`; the allowlist is an explicit policy decision, not a substitute for
the distributable notice catalog.

Native Swift package declarations live in `apps/macos/project.yml`, with
`apps/macos/Package.resolved` checked in as the resolved graph.
`SwiftStreamingMarkdown` is pinned to the immutable revision for its `0.6.0`
tag, and Railgun's direct `swift-markdown` dependency is pinned exactly to
`0.7.3` to match that package's constraint. Update those pins together. Keep
the explicit-module and header-search workaround on `RailgunUI`, and keep the
package products linked by both `RailgunUI` and the final app while
`RailgunUI` remains a static library.

Workspace path dependencies must declare both `path` and a compatible
`version`. This keeps local workspace resolution while avoiding unbounded
dependency declarations:

```toml
railgun-backend = { version = "0.9.0", path = "../railgun-backend" }
```

Cargo or Swift package changes must also refresh and validate the bundled
license and attribution texts:

```sh
cargo xtask legal --write
cargo xtask legal --check
```

## Backend modes

```text
railgun-backend desktop
railgun-backend scheduler
railgun-backend dream
railgun-backend login
railgun-backend logout
```

`desktop` owns RPC v1. `scheduler` is the long-running local-time cron
processor used by the optional installed background scheduler. Dream memory
maintenance is registered as a protected hidden midnight job inside that
scheduler; the standalone `dream` mode remains an implementation helper.
`login` and `logout` manage the credential at `~/.railgun/devin-token`.
`DEVIN_TOKEN`, when present, remains the highest-priority credential.

The macOS desktop app automatically opens Devin in the default browser when
the file-backed credential is missing or rejected. The same browser-backed
Login, Log out, and Log in again actions are available under Settings →
General → Devin. `DEVIN_TOKEN` remains environment-managed and cannot be
changed from the app.

If the browser helper completes but the RPC backend cannot reconnect, Railgun
shows **Backend Unavailable** with **Retry** instead of leaving the task shell
active. Retry starts a fresh backend generation and does not replay a failed
task.

### Background scheduling

Background scheduling is opt-in under **Settings → General → Background
Scheduling**. Installing it creates the per-user LaunchAgent
`~/Library/LaunchAgents/sh.railgun.cron.plist`, which invokes the bundled
`railgun-backend scheduler` executable directly. The LaunchAgent never invokes
the Railgun app executable, so scheduled work can continue after the app quits
without reopening a window or waking the GUI process. It remains installed for
future user logins until it is uninstalled. Without it, schedules can still be
created and edited, but no background processor evaluates them.

The scheduler writes standard output and error to
`~/.railgun/logs/scheduler.log`. Repair replaces stale definitions, including
definitions whose bundled backend changed after an app update. Existing legacy
cron or Dream LaunchAgents are migrated to the single scheduler agent; Dream
then runs only as the protected hidden midnight cron job inside it.

Uninstall stops the current and legacy background agents and removes their
LaunchAgent definitions. It does not delete scheduled prompts, memories,
delivery history, credentials, or the scheduler log under `~/.railgun`, so a
later reinstall resumes from the existing Railgun data.

## Agent tools and safeguards

During a desktop turn, the provider can iteratively call the built-in tools for
safe local file work (`read_file`, `write_file`, and `list_directory`), shell
commands, todos, clarification, memory, cron, diagnostics, skills, public-web
search/fetch, and bounded delegation. Tool results are retained in the session
transcript in provider-call order. MCP and JavaScript extension runtimes are
not part of this restored tool surface.

Local file tools canonicalize paths and operate only on regular files or
directories under the user's home directory, including hidden paths and
`Library`. macOS privacy controls may require user-granted folder access or
Full Disk Access. Text reads return a bounded result rather than rejecting a
large file. Shell commands hard-block destructive patterns; dangerous commands
follow the selected approval mode and approvals apply only to the active session.
In model-assisted mode, the reviewer receives both the command and the user task
that authorized the run; it must return an exact approval for the command to run.
Scheduled and delegated runs cannot wait for desktop approval or clarification.

Cron tool schedules use five fields and run in local time. When the background
scheduler is installed from Settings, due runs continue after the Railgun app
quits. They are checked at minute boundaries, record their outcome, and are
saved as resumable scheduled-delivery sessions. Memories remain on demand:
they are searched or written only through memory tools, rather than injected
into every prompt. Manual Dream remains available in Personalization; its
nightly run requires the installed background scheduler. Dream requires at
least five memories and consolidates exact duplicates while reporting
before/after counts and progress.

### Skills

Railgun discovers reusable Markdown skills from either of these layouts:

```text
~/.railgun/skills/review.md
~/.railgun/skills/review/SKILL.md
```

Each file starts with YAML frontmatter followed by the Markdown instructions:

```markdown
---
name: review
description: Review a change for correctness and regressions
disable-model-invocation: false
---

# Review

Inspect the change and report concrete findings first.
```

The effective name must match `[a-z0-9-]{1,64}`. `description` is required and
limited to 1,024 bytes; the Markdown body is limited to 200,000 bytes. `name`
may override the filename-derived name, `disable-model-invocation` defaults to
`false`, and both LF and CRLF files are accepted. Invalid files and symlinked
entries are skipped so they can be repaired directly on disk. If multiple
files declare the same effective name, the first source in deterministic path
order wins and later duplicates are reported in backend diagnostics.

Railgun refreshes discovery at the start of every agent run and advertises only
the names and descriptions of model-visible skills. Bodies are omitted from the
system prompt and returned only on demand; `skill_view` rejects manual-only
skills even if the model guesses their name or frontmatter alias. A user can
explicitly load any valid skill, including a manual-only one, by starting a
prompt with `/skill:<name> [arguments]`; an unknown name is rejected before an
agent run starts. If the skills root cannot be scanned, ordinary desktop and
scheduled prompts continue without skills, while an explicit `/skill:`
invocation returns a targeted load error.

**Settings → Skills** provides search, Markdown preview, create, edit,
visibility toggle, and delete controls. Settings writes managed skills to
`~/.railgun/skills/<name>/SKILL.md` atomically, with `0700` directories and
`0600` files. Names are immutable after creation, and managed mutations reject
symlinked roots, directories, or files. Updating a valid legacy bare file
migrates it to the managed layout, while deleting a skill removes only its
Markdown file and an empty skill directory; sibling asset files are left
intact. Settings lists only valid discovered skills, so malformed external
files remain a manual filesystem repair.

`web_fetch` accepts only public HTTP(S) targets without URL credentials. It
rejects private, loopback, and localhost addresses (including IPv4-mapped IPv6
forms), pins validated DNS addresses for the request, revalidates redirects,
and returns a bounded response with an explicit truncation flag. Delegation
accepts at most three goals, caps depth at two and concurrency at three, and
returns child results in request order. The `advise` tool is reserved for the
private Advisor review path, which may emit at most one note per review.

The bundled executable is staged at:

```text
Railgun.app/Contents/Resources/backend/railgun-backend
```

Source mode uses `target/debug/railgun-backend`; mock mode uses
`target/debug/railgun-mock-backend <scenario>`.

## Data compatibility

Railgun preserves the existing `~/.railgun` layout:

```text
~/.railgun/config.json
~/.railgun/devin-token
~/.railgun/state.db
~/.railgun/SOUL.md
~/.railgun/cron/jobs.json
~/.railgun/skills/
```

Personalization stores the global custom instruction in
`~/.railgun/SOUL.md`. On its first read after upgrading, Railgun copies
non-empty legacy `~/.railgun.md` content into an empty `SOUL.md`; it retains
the legacy file as a backup.

Configuration updates preserve unknown keys. SQLite uses foreign keys, WAL,
a five-second busy timeout, embedded up-only SQLx migrations, and the existing
`user_version` 0–7 importer. Existing `schema_migrations`, retired tables, and
unknown tables are not removed.

Create and check migrations without a global migration tool:

```sh
cargo xtask migration new descriptive_name
cargo xtask migration check
```

## RPC v1

Clients initialize with:

```json
{
  "id": "initialize-1",
  "type": "initialize",
  "version": 1,
  "clientName": "Railgun"
}
```

Every response carries the command and preserves the request identifier.
Session, interaction, configuration, MCP, cron, memory, dream, instruction,
skill, and delivery capabilities retain their existing field casing and
ordering rules. The backend emits protocol frames only on stdout.

Skill management uses the following additive RPC v1 command shapes. Create and
update return a full `skill` object; get returns the same detail, list returns
summary objects without `body`, and delete has no response data.

```json
{"type":"skills_list"}
{"type":"skill_get","name":"review"}
{"type":"skill_create","name":"review","description":"Review a change","body":"Inspect the diff.","disableModelInvocation":false}
{"type":"skill_update","name":"review","description":"Review a change","body":"Inspect the diff and tests.","disableModelInvocation":true}
{"type":"skill_delete","name":"review"}
```

Skill summaries contain `name`, `description`, and
`disableModelInvocation`; details add `body`. `name` identifies the immutable
managed skill during update.

Session transcript and recent-message projections follow the parent chain from
the session's active `current_leaf_id`. After branching, descendants from the
abandoned branch remain preserved in SQLite but are never projected as active
history or previews.

`session_list` summaries include the additive ISO-8601 `lastMessageAt` field. It is the creation
timestamp of the session's active `current_leaf_id`, falling back to the session start when the
active branch has no message. Mock summaries use the latest timestamped message in visible order so
trailing fixture messages without timestamps do not erase known activity time.

`get_available_models` remains compatible with existing callers and returns
the cached model list. Its additive `catalog` object reports cache freshness,
generation, refresh state, and a redacted last refresh error when applicable.
Clients that negotiate `model_catalog.refresh` may send the fieldless
`refresh_model_catalog` command to refresh that cache without blocking normal
model reads or control actions. A `set_model` response includes an additive
active-session snapshot; archive mutations similarly include the affected and
new active session identifiers for prompt client reconciliation.

The mock backend supports readiness, authentication, delayed and malformed
startup, rejection, crash/disconnect, store errors, approval, clarification,
cancellation, agent activity, empty model catalog, and slow compaction
scenarios.

## Packaging and release

`apps/macos/scripts/stage-backend.sh` builds a locked Debug or Release backend,
requires an arm64-only Mach-O, and atomically stages one executable.
`sign-nested-code.sh` signs every nested Mach-O before the enclosing app.
Release archives retain hardened runtime, notarization, stapling, Sparkle ZIP,
and appcast validation.

Legal notices are generated from `Cargo.lock` plus pinned Swift, font, and
artwork inputs:

```sh
cargo xtask legal --write
cargo xtask legal --check
```

Version releases use:

```sh
scripts/release-version.sh patch --dry-run
scripts/release-version.sh patch
```

The version script keeps `apps/macos/project.yml` and
`apps/desktop/package.json` aligned in the same release commit.

The tagged release workflow currently publishes only the native
`Railgun-<version>-darwin-arm64.zip` and `Railgun-appcast-arm64.xml`; Electron
artifact publishing has not been added yet.
