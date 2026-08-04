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

When a release changes `Cargo.toml`, `Cargo.lock`,
`apps/macos/project.yml`, or `apps/macos/Package.resolved`, review every newly
introduced license and run `cargo xtask legal --write` before the checks above.
For Cargo changes, update `deny.toml` deliberately as needed. The checked-in
notice catalog must contain the actual license and attribution texts for the
distributed Rust and Swift runtime graphs; passing `cargo deny check` or
resolving Swift packages alone is not sufficient for distribution.

The release workflow archives, signs, notarizes, staples, and validates the
native app, its arm64 Rust backend, and its Sparkle framework. It publishes the
same arm64 ZIP and signed appcast assets as previous releases.

Notarization-ticket validation runs immediately after stapling, before the app
is copied and zipped. The later artifact smoke check verifies the staged app's
Gatekeeper assessment, code signatures, backend, icon assets, archive layout,
and appcast; it deliberately does not issue a second `stapler validate` call.
This avoids making the release depend on a redundant CloudKit ticket lookup.

## Native UI toolchain

The `build-railgun` release job runs on GitHub Actions `macos-26` and verifies
that the installed toolchain provides the macOS 26 SDK before archiving. The
runner can identify its Xcode installation with a different major version;
the SDK is the requirement that enables Liquid Glass. Liquid Glass is selected
by a compiler guard as well as a runtime availability check, so an older SDK
would compile only the macOS 15–25 material fallback into a release, even when
that app later runs on macOS 26.

Standard pull-request and main-branch CI intentionally remains on `macos-15`.
That keeps the fallback buildable and tested without changing the release
toolchain required to ship the macOS 26 composer.

The workflow requires the existing Developer ID, Apple notarization, and
Sparkle secrets. The private Sparkle key is passed only to the appcast
generator. Homebrew distribution is not produced by this workflow.
