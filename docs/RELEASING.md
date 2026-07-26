# Releasing Railgun

Railgun releases support Apple silicon (`arm64`) Macs only. The native macOS
app is the sole release artifact; the former Electron release pipeline is
retired. After native verification passes, use the root version command from a
clean `main` checkout. It updates `MARKETING_VERSION` in
`apps/macos/project.yml`, creates the version commit, and creates the matching
annotated `vX.Y.Z` tag.

```sh
pnpm run typecheck
pnpm run build
pnpm run test
./apps/macos/scripts/validate-project.sh
pnpm run release:version -- patch
git push origin main --tags
```

Use `minor`, `major`, or an explicit semantic version such as `1.2.3` in place
of `patch`. Preview the exact change without editing Git state with
`pnpm run release:version -- patch --dry-run`. Do not run `pnpm version` at the
repository root: the private bundled backend has no release version.

The release workflow archives, signs, notarizes, staples, and validates the
native `Railgun` application. It uploads the arm64 ZIP and its signed Sparkle
appcast to the GitHub Release. Pre-release tags create GitHub pre-releases.

The workflow requires Developer ID and Apple notarization credentials plus
`RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY` and
`RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY`. The private Sparkle key is passed to the
appcast generator on standard input only; store the exported key-file text, not
a base64 wrapper, in the repository secret.

Homebrew distribution is not produced by this workflow. Historical npm
packages remain deprecated and must not be unpublished.
