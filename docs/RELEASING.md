# Releasing Railgun desktop

`apps/desktop/package.json` is the only release-version authority. Create a
matching `desktop-vX.Y.Z` tag after desktop tests pass.

The release workflow signs, notarizes, staples, and validates arm64 and x64
artifacts for two immutable channels:

- `direct` artifacts are uploaded to the GitHub release and may use the
  in-app updater. Their names retain the updater-required macOS target, for
  example `Railgun-direct-X.Y.Z-darwin-arm64.zip`.
- `homebrew` artifacts are used only by the Cask; updates are exclusively
  `brew upgrade --cask railgun`. They use separate names such as
  `Railgun-homebrew-X.Y.Z-darwin-arm64.zip`.

Do not rename the direct ZIP files after Forge builds them: the `darwin-arm64`
and `darwin-x64` target identifiers are required by the GitHub update service.
Homebrew SHA-256 values must be calculated from its own channel artifacts.

Before tagging, run desktop type-check and tests, build a packaged arm64 app,
and verify signing/notarization when release credentials are present. Confirm
the Cask SHA-256 values from the generated Homebrew artifacts. The direct
updater requires a signed public GitHub Release containing both macOS ZIPs;
Homebrew builds must never invoke it.

The retired npm package is deprecated with a desktop-only migration message;
historical versions remain published and must not be unpublished.
