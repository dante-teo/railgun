# Releasing Railgun

Railgun releases support macOS 15 or newer on Apple silicon only. The tagged GitHub workflow is the
only production packaging path.

## Prepare and verify

From a clean `main` checkout, run:

```sh
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop test
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop exec prettier --check .
pnpm --dir apps/desktop build
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

When a workflow or release shell script changes, also run:

```sh
actionlint .github/workflows/ci.yml .github/workflows/publish.yml
shellcheck apps/desktop/scripts/release/*.sh scripts/release-version.sh
bash -n apps/desktop/scripts/release/*.sh scripts/release-version.sh
```

When a distributed Cargo dependency, font, product asset, or legal input changes, review the
license and run `cargo xtask legal --write` before these checks. The checked-in notice catalog must
contain the applicable license and attribution texts; `cargo deny check` is not a distributable
notice generator.

Create the version commit and annotated tag with:

```sh
scripts/release-version.sh patch --dry-run
scripts/release-version.sh patch
git push origin main --tags
```

Use `minor`, `major`, or an explicit semantic version in place of `patch`. The version script
updates only `apps/desktop/package.json`.

## CI and release contract

Pull requests and `main` run the Rust suite on Ubuntu plus Electron verification and unsigned
arm64 packaging on GitHub's `macos-15` runner. The unsigned package check verifies:

- `io.anvia.railgun`, the package version, and a macOS 15 minimum
- arm64-only Electron and backend Mach-O binaries
- executable permissions on the embedded backend
- product/Rust notices plus Electron and Chromium runtime notices
- Electron update configuration
- authentication-required backend startup and clean exit under a temporary home

Pushing `vX.Y.Z` or a semantic prerelease tag runs `.github/workflows/publish.yml`. The tag must
match `apps/desktop/package.json`. The workflow uses the GitHub run number for the numeric
`CFBundleVersion`. A new tag must exceed the latest published Railgun build. If the current tag is
already the latest release, rerunning its workflow may reuse that release's build number; a lower
number still fails. The publish step then replaces that tag's existing assets rather than creating
a second release.

The release job signs, notarizes, and staples one `Railgun.app`, then validates its nested
signatures, hardened runtime, Gatekeeper assessment, stapler ticket, metadata, notices, and backend
lifecycle in the staging bundle and in the exact application copies extracted from the ZIP and
mounted from the DMG. It also validates the ZIP/DMG layouts, Electron update metadata and hashes,
blockmaps, and signed compatibility appcast. It publishes:

```text
Railgun-<version>-darwin-arm64.dmg
Railgun-<version>-darwin-arm64.zip
Railgun-<version>-darwin-arm64.dmg.blockmap
Railgun-<version>-darwin-arm64.zip.blockmap
latest-mac.yml
Railgun-appcast-arm64.xml
```

The metadata filename may include Electron Builder's architecture qualifier; release validation
discovers the generated `*-mac.yml` file rather than assuming its exact basename.

Electron reads public GitHub Releases through `electron-updater`. The appcast is a compatibility
bridge for installations of the retired pre-Electron application and is not consumed by Electron.
Keep publishing it until that migration channel is explicitly retired.

## Existing credentials

The workflow consumes these existing repository secrets without displaying, creating, or rotating
them:

```text
MACOS_CERTIFICATE_P12_BASE64
MACOS_CERTIFICATE_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY
RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY
```

The certificate values map to Electron Builder's `CSC_LINK` and `CSC_KEY_PASSWORD`. Apple account
values drive notarization. Before appcast generation, the ZIP application's `SUPublicEDKey` must
exactly match `RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY`. The private EdDSA key is passed only to the
pinned, checksummed Sparkle `generate_appcast` tool, and generation fails unless Sparkle emits an
archive signature from the matching private key. Release validation repeats the public-key check
for the staging, ZIP, and DMG application copies and verifies the archive signature. GitHub
publishing uses the workflow's automatic token.

Before relying on a local inventory, require a valid GitHub CLI session and use read-only commands:

```sh
gh auth status
gh repo view dante-teo/railgun --json nameWithOwner,visibility,url
gh secret list --repo dante-teo/railgun
gh variable list --repo dante-teo/railgun
gh api repos/dante-teo/railgun/environments --jq '.environments[].name'
gh release view --repo dante-teo/railgun --json tagName,isPrerelease,publishedAt,url,assets
```

Stop on authentication failure. Do not create, rotate, print, or delete credentials as part of an
inventory.

## Migration rollout

Publish an arm64 prerelease candidate before a stable tag. Against the preserved latest
pre-Electron release:

1. Override its Sparkle feed with the candidate `Railgun-appcast-arm64.xml`.
2. Confirm the appcast EdDSA signature is accepted and installs the Electron ZIP.
3. Confirm the installed app launches as `io.anvia.railgun` on macOS 15 or newer.
4. Confirm existing `~/.railgun` tasks and credentials remain available.
5. Record the migration result and rollback owner.

Publish the stable tag only after this bridge passes. Historical tags, releases, and release assets
remain rollback and audit history and must not be changed by the new workflow.
