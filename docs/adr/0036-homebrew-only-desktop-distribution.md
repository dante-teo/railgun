# 0036. Distribute the macOS desktop through Homebrew

Date: 2026-07-15

Status: Accepted

## Context

Railgun now has a private Electron workspace that must produce an installable
macOS application. Distribution must cover both Apple silicon and Intel Macs,
pass Gatekeeper outside the Mac App Store, and stay aligned with the published
CLI version. The project does not need App Store discovery, sandboxing, review,
or receipt-based commerce.

## Decision

Publish the desktop through GitHub Releases and a Cask in
`dante-teo/homebrew-tap`; do not submit it to the Mac App Store.

One `v*` tag drives the npm and desktop releases. Native GitHub-hosted arm64 and
Intel runners each package a ZIP, sign it with the Developer ID Application
identity, submit it to Apple notarization, staple the ticket, and verify the
result. Stable releases update the Cask with per-architecture URLs and SHA-256
digests. Prereleases publish versioned GitHub assets without changing Homebrew.

Release credentials live only in GitHub Actions secrets. The Developer ID
certificate is imported into an ephemeral keychain, and a repository-scoped
write deploy key is used only for the Homebrew tap.

## Consequences

- Users install and upgrade the desktop with Homebrew while GitHub Releases
  remain the underlying artifact source.
- Railgun keeps the broader Developer ID runtime model and does not adopt Mac
  App Store entitlements, packaging, or review constraints.
- The release workflow owns two native builds and Apple notarization, increasing
  release time and making Apple service availability an external dependency.
- CLI publication can complete before a later desktop or tap step fails, so the
  workflow must remain safely rerunnable.
- Stable Homebrew publication intentionally waits for both architectures and
  their signatures to pass.
