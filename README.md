# Railgun

Railgun is a native arm64 macOS agent application with a private Rust backend.
The app and backend communicate over versioned JSONL RPC on standard input and
standard output; diagnostics are structured, redacted, and written only to
standard error.

## Requirements

- macOS 15 or newer on Apple silicon
- Xcode and the macOS SDK
- XcodeGen at the version in `apps/macos/.xcodegen-version`
- The Rust toolchain pinned by `rust-toolchain.toml`
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

Run the native app with its bundled debug backend:

```sh
scripts/run.sh
```

Run with the source or deterministic mock executable:

```sh
scripts/run-source.sh
scripts/run-mock.sh
```

The wrappers preserve the existing CLI and build the required Rust executable
before launching the app. They are launch commands, not verification commands.

The desktop interface uses the shared `RailgunSpacing` 4, 8, 12, 16, 24, and 32 point scale.
Transcript rows keep a comfortable 32-point inter-message gap.
Assistant responses use the same selectable Markdown renderer while streaming,
after completion, and when restored from history. Live updates supply complete
accumulated snapshots rather than deltas, so incomplete emphasis, fenced code,
lists, and tables remain presentable without a final renderer swap. User
prompts remain literal selectable text. Clickable links must be
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
The tool rejects hidden paths, `~/Library`, credential- or secret-like
filenames, private keys and keystores, files outside the configured home, and
files larger than 1 MB before reading them. The context ring shows the latest
provider usage while it is available and reports **Not measured yet** when the
provider has supplied no measurement.

### Archived task browser

Settings → Archived Tasks displays archived sessions without changing their
backend order. Search matches title, model, or the full task ID. Restoring a
task returns it to the active task list without opening or resuming it. Context
actions that restore a task or copy its exact ID require exactly one selected row,
so multi-row selection cannot target an arbitrary task.

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
processor. `dream` runs memory maintenance. `login` and `logout` manage the
credential at `~/.railgun/devin-token`. `DEVIN_TOKEN`, when present, remains
the highest-priority credential.

## Agent tools and safeguards

During a desktop turn, the provider can iteratively call the built-in tools for
safe local file work (`read_file`, `write_file`, and `list_directory`), shell
commands, todos, clarification, memory, cron, diagnostics, skills, public-web
search/fetch, and bounded delegation. Tool results are retained in the session
transcript in provider-call order. MCP and JavaScript extension runtimes are
not part of this restored tool surface.

Local file tools canonicalize paths and operate only on regular files or
directories under the user's home directory. Hidden paths, `Library`,
credential- and secret-like names, private keys, and keystores are protected.
Text reads reject files over 1 MB before allocating their contents and return a
bounded UTF-8 result. Shell commands hard-block destructive patterns; dangerous
commands require a desktop approval, which applies only to the active session.
Scheduled and delegated runs cannot wait for desktop approval or clarification.

Cron tool schedules use five fields and run in local time while Railgun is
open. Due runs are checked at minute boundaries, record their outcome, and are
saved as resumable scheduled-delivery sessions. Memories remain on demand:
they are searched or written only through memory tools, rather than injected
into every prompt. Dream requires at least five memories and consolidates exact
duplicates while reporting before/after counts and progress.

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
{"id":"initialize-1","type":"initialize","version":1,"clientName":"Railgun"}
```

Every response carries the command and preserves the request identifier.
Session, interaction, configuration, MCP, cron, memory, dream, instruction,
skill, and delivery capabilities retain their existing field casing and
ordering rules. The backend emits protocol frames only on stdout.

Session transcript and recent-message projections follow the parent chain from
the session's active `current_leaf_id`. After branching, descendants from the
abandoned branch remain preserved in SQLite but are never projected as active
history or previews.

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

The release workflow continues to publish
`Railgun-<version>-darwin-arm64.zip` and `Railgun-appcast-arm64.xml`.
