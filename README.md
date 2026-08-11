# Railgun

Railgun is an Electron desktop coding agent for Apple-silicon Macs. The application ships with a
private Rust backend and communicates with it over versioned JSONL RPC on standard input and
standard output. Diagnostics are structured, redacted, and written only to standard error.

The supported production platform is macOS 15 or newer on arm64. Windows, Linux, Intel Mac,
Homebrew, the Mac App Store, and separate backend installations are not release targets.

## Requirements

- The Rust toolchain pinned by `rust-toolchain.toml`
- Node.js and pnpm versions declared by `apps/desktop/package.json`
- `cargo-deny` when reproducing the dependency-policy CI gate locally
- `actionlint` and ShellCheck when changing GitHub workflows or release shell scripts

## Workspace

- `apps/desktop`: the production Electron main process, preload boundary, React renderer, tests,
  packaging configuration, and release validators.
- `crates/railgun-backend`: shared domain/application/adapters code and the production
  `railgun-backend` executable.
- `crates/railgun-mock-backend`: deterministic JSONL scenarios for desktop development and tests.
- `crates/railgun-xtask`: migration, fixture, legal-notice, and performance tooling.
- `legal`: checked-in Rust, font, and product-artwork notice inputs and generated distributions.

## Development

Start Electron against a source-built production backend and the existing `~/.railgun` data:

```sh
scripts/run.sh
```

Start it against deterministic in-memory fixtures:

```sh
scripts/run-mock.sh
```

`run-mock.sh` uses the `ready-idle` scenario by default. Select another fixture with, for example:

```sh
RAILGUNX_MOCK_SCENARIO=agent-activity scripts/run-mock.sh
```

The default fixture also includes a saved task beginning **Prepare a release-readiness brief**.
Its 53-message transcript covers all 17 built-in tools across 23 reasoned calls, including success,
failure, long-result, TODO-transition, and final-answer states.

Both commands launch the GUI and forward extra arguments to `pnpm dev`; they are not verification
commands. Direct `pnpm --dir apps/desktop dev` starts the shell without configuring a backend.

Production source launches and packaged launches acquire `~/.railgun/desktop-client.lock` before
starting the backend. Mock launches are exempt. The packaged application resolves its backend from
`Railgun.app/Contents/Resources/backend/railgun-backend` automatically and treats backend launch or
initialization failure as fatal.

The current desktop implements the task list, persisted transcripts, streaming Markdown,
attachments, model and approval selection, context usage, in-turn approval and clarification, the
Activity surface, and route-addressable Settings for General, Appearance, Personalization, Skills,
and Archived Tasks. The Scheduled navigation label remains non-routed, and Inspector data remains
static presentation data on Tasks; Settings intentionally omits the Inspector while preserving its
stored Tasks preference.

The detailed renderer, preload, RPC, and process contracts live in
[`apps/desktop/README.md`](./apps/desktop/README.md).

## Verification

Desktop checks do not launch the GUI:

```sh
pnpm --dir apps/desktop test
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop exec prettier --check .
pnpm --dir apps/desktop build
```

Backend and repository checks:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
cargo build --locked --release --package railgun-backend
cargo deny check
cargo xtask migration check
cargo xtask fixtures
cargo xtask legal --check
git diff --check
```

Run `cargo xtask legal --write` after changing a distributed Cargo dependency, font, product asset,
or legal input. Review any dependency-policy changes before updating `deny.toml`.

## Packaging and release

Inspect an unsigned local arm64 application bundle:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false \
RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY=local-validation-key \
pnpm --dir apps/desktop build:unpack
```

Tagged releases are built only by `.github/workflows/publish.yml`. The workflow creates a signed,
notarized, and stapled `Railgun.app`, then publishes:

- `Railgun-<version>-darwin-arm64.dmg`
- `Railgun-<version>-darwin-arm64.zip`
- Electron updater metadata and blockmaps
- `Railgun-appcast-arm64.xml`, a signed compatibility feed for installations of the retired
  pre-Electron client

Electron updates from public `dante-teo/railgun` GitHub Releases. The compatibility appcast is a
release artifact only; Sparkle is not included in the Electron runtime.

Prepare a version commit and annotated tag with:

```sh
scripts/release-version.sh patch --dry-run
scripts/release-version.sh patch
```

See [`docs/RELEASING.md`](./docs/RELEASING.md) for signing inputs, artifact validation, and the
required release-candidate migration test.

## Backend modes and data

```text
railgun-backend desktop
railgun-backend scheduler
railgun-backend dream
railgun-backend login
railgun-backend logout
```

`desktop` owns RPC v1. `scheduler` processes local-time cron definitions. `dream` remains an
implementation helper. `login` and `logout` manage `~/.railgun/devin-token`; `DEVIN_TOKEN` has
higher priority when present.

Railgun preserves the existing data layout across application updates:

```text
~/.railgun/config.json
~/.railgun/devin-token
~/.railgun/state.db
~/.railgun/desktop-client.lock
~/.railgun/SOUL.md
~/.railgun/cron/jobs.json
~/.railgun/skills/
```

SQLite uses foreign keys, WAL, a five-second busy timeout, embedded up-only SQLx migrations, and
the legacy database importer. Existing sessions and credentials remain in place when the Electron
application replaces an older installation with the same `io.anvia.railgun` bundle identity.

## Security boundaries

The renderer is sandboxed, has context isolation enabled, and has no Node integration. Privileged
operations stay behind the preload boundary. The Electron main process validates renderer inputs,
backend responses, and correlated JSONL frames before exposing bounded presentation data.

Each unterminated backend frame is capped at 8 MiB. Normal reads time out; mutations that may
commit late remain pending until the backend responds or exits. Shell projections strip terminal
control sequences and bound command/output text. Raw thinking and non-shell tool payloads never
cross into renderer snapshots.

Local file tools canonicalize paths under the user's home directory. `create_file` requires an
existing parent and creates or replaces one regular file. `delete_file` permanently removes one
regular file and requires fresh authorization outside Full access. Web fetches reject local,
private, credential-bearing, and unsafe redirect targets. Shell execution hard-blocks destructive
patterns regardless of the configured approval mode.
