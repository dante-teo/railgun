# Releasing Railgun and Railgun Classic

`apps/desktop/package.json` is the only release-version authority. Create a
matching `vX.Y.Z` tag after desktop tests pass.

## Stable release procedure

From a clean `main` checkout, run the root release command. It bumps only the
desktop workspace, creates the version commit, and creates the matching
`vX.Y.Z` tag. Do not run `pnpm version` directly at the repository
root: the bundled backend is intentionally private and has no release version.

```sh
pnpm run typecheck
pnpm run build
pnpm --filter @dantea/railgun-desktop typecheck
pnpm run test
pnpm --filter @dantea/railgun-desktop test
pnpm --filter @dantea/railgun-desktop package
pnpm release:version patch
git push origin main --tags
```

Use `minor`, `major`, or an explicit version in place of `patch` as needed.
The command uses pnpm's normal commit-and-tag behavior and its standard `v`
prefix, which is recognized by the GitHub-backed updater.

The release workflow signs, notarizes, staples, and validates arm64 and x64
direct artifacts:

It also ships side-by-side native `Railgun` artifacts for `arm64` and
`x86_64`, with an independently signed Sparkle appcast for each architecture.
The Electron app is named Railgun Classic, while its direct-release feed and
artifact names remain unchanged for updater compatibility.
The native job needs `RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY` and
`RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY` repository secrets. The private key is
provided to Sparkle via standard input only; store the exported key-file text,
not a base64 wrapper, in that secret.

Before packaging either architecture, the workflow prefetches the Electron
binary with up to three attempts. This avoids Electron's lazy download during
the backend build; if all attempts fail, retry the release job after the
artifact host is available again.

- Direct artifacts are uploaded to the GitHub release and use the in-app
  updater, including automatic and **Railgun → Check for Updates…** checks.
  Their names retain the updater-required macOS target, for example
  `Railgun-direct-X.Y.Z-darwin-arm64.zip`.

Homebrew distribution is no longer built or updated by this workflow. The
`homebrew` update channel remains only for compatibility with previously
installed builds and must not be used for new release artifacts.

Do not rename the direct ZIP files after Forge builds them: the `darwin-arm64`
and `darwin-x64` target identifiers are required by the GitHub update service.
Before tagging, run desktop type-check and tests, build a packaged arm64 app,
and verify signing/notarization when release credentials are present. The direct
updater requires a signed public GitHub Release containing both macOS ZIPs.

The retired npm package is deprecated with a desktop-only migration message;
historical versions remain published and must not be unpublished.
