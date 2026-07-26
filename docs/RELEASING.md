# Releasing Railgun

Railgun releases support Apple silicon (`arm64`) Macs only. The native macOS
app is the sole release artifact; the former Electron release pipeline is
retired. Create a signed `vX.Y.Z` tag from a clean `main` checkout after native
verification passes.

```sh
pnpm run typecheck
pnpm run build
pnpm run test
./apps/macos/scripts/validate-project.sh
git tag vX.Y.Z
git push origin main --tags
```

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
