# Releasing Railgun desktop

`apps/desktop/package.json` is the only release-version authority. Create a
matching `vX.Y.Z` tag after desktop tests pass.

## Stable release procedure

From a clean `main` checkout, run the root release command. It bumps only the
desktop workspace, creates the version commit, and creates the matching
`vX.Y.Z` tag. Do not run `pnpm version` directly at the repository
root: the bundled backend is intentionally private and has no release version.

```sh
pnpm run typecheck
pnpm --filter @dantea/railgun-desktop typecheck
pnpm run test
pnpm --filter @dantea/railgun-desktop test
pnpm release:version patch
git push origin main --tags
```

Use `minor`, `major`, or an explicit version in place of `patch` as needed.
The command uses pnpm's normal commit-and-tag behavior and its standard `v`
prefix, which is recognized by the GitHub-backed updater.

The release workflow signs, notarizes, staples, and validates arm64 and x64
artifacts for two immutable channels:

Before packaging either architecture, the workflow prefetches the Electron
binary with up to three attempts. This avoids Electron's lazy download during
the backend build; if all attempts fail, retry the release job after the
artifact host is available again.

- `direct` artifacts are uploaded to the GitHub release and may use the
  in-app updater, including automatic and **Railgun → Check for Updates…**
  checks. Their names retain the updater-required macOS target, for example
  `Railgun-direct-X.Y.Z-darwin-arm64.zip`.
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
