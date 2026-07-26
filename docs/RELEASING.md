# Releasing Railgun

Railgun releases support Apple-silicon Macs only. From a clean `main`
checkout, run:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
cargo build --locked --release --package railgun-backend
cargo deny check
cargo xtask legal --check
apps/macos/scripts/validate-project.sh
scripts/release-version.sh patch
git push origin main --tags
```

Use `minor`, `major`, or an explicit semantic version in place of `patch`.
Append `--dry-run` to preview the version commit and annotated tag.

When a release changes `Cargo.toml` or `Cargo.lock`, review every newly
introduced license, update `deny.toml` deliberately, and run
`cargo xtask legal --write` before the checks above. The checked-in notice
catalog must contain the actual license and attribution texts; passing
`cargo deny check` alone is not sufficient for distribution.

The release workflow archives, signs, notarizes, staples, and validates the
native app, its arm64 Rust backend, and its Sparkle framework. It publishes the
same arm64 ZIP and signed appcast assets as previous releases.

The workflow requires the existing Developer ID, Apple notarization, and
Sparkle secrets. The private Sparkle key is passed only to the appcast
generator. Homebrew distribution is not produced by this workflow.
