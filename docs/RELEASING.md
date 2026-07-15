# Releasing Railgun

Railgun publishes the CLI and macOS desktop from the same `v*` tag. The root
`package.json` is the version authority for both surfaces.

## Release outputs

A stable `vX.Y.Z` tag produces:

- `@dantea/railgun@X.Y.Z` on npm;
- signed and notarized `Railgun-X.Y.Z-arm64.zip` and
  `Railgun-X.Y.Z-x64.zip` GitHub release assets; and
- `Casks/railgun.rb` in `dante-teo/homebrew-tap`.

A prerelease tag such as `vX.Y.Z-beta.1` publishes npm and GitHub prerelease
artifacts, but does not update Homebrew. The full prerelease version remains in
package and artifact metadata. macOS receives the numeric `X.Y.Z` portion as
`CFBundleShortVersionString`, because Apple bundle versions cannot contain a
prerelease label; `CFBundleVersion` uses the GitHub Actions run number.

The desktop is distributed through Homebrew and GitHub Releases only. It is not
submitted to the Mac App Store.

## GitHub configuration

The `Release` Actions workflow requires these secrets in `dante-teo/railgun`:

| Secret                         | Purpose                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID Application certificate and private key (`.p12`)           |
| `MACOS_CERTIFICATE_PASSWORD`   | Password chosen while exporting that `.p12` from Keychain Access                       |
| `APPLE_ID`                     | Apple Account email belonging to the developer team                                    |
| `APPLE_APP_SPECIFIC_PASSWORD`  | App-specific password generated for notarization; it is not the Apple Account password |
| `APPLE_TEAM_ID`                | Apple Developer team identifier                                                        |
| `HOMEBREW_TAP_DEPLOY_KEY`      | Private half of the SSH deploy key scoped to the tap repository                        |

The matching public deploy key must be write-enabled on
`dante-teo/homebrew-tap`. Do not reuse an account-wide SSH key or store the
private key in the tap repository.

The workflow expects this signing identity:

```text
Developer ID Application: Chen Pei Teo (GUKP6SNV36)
```

When the certificate or team changes, update both the certificate secret and
the exact identity check in `.github/workflows/publish.yml` and
`apps/desktop/forge.config.ts`.

To encode a replacement certificate on macOS without printing it to the
terminal:

```sh
base64 < /path/to/Certificates.p12 | tr -d '\n' | gh secret set MACOS_CERTIFICATE_P12_BASE64 --repo dante-teo/railgun
```

Set its export password separately with `gh secret set`; never commit either
value. Rotate the tap deploy key if its private half is exposed, and remove the
old public deploy key from the tap after replacement.

## Prepare and tag a release

1. Update the root version without creating a tag:

   ```sh
   pnpm version X.Y.Z --no-git-tag-version
   ```

2. Run the local release checks:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run typecheck
   pnpm run test
   pnpm run build
   pnpm run smoke:package
   pnpm --filter @dantea/railgun-desktop typecheck
   pnpm --filter @dantea/railgun-desktop test
   pnpm --filter @dantea/railgun-desktop build
   actionlint .github/workflows/ci.yml .github/workflows/publish.yml
   git diff --check
   ```

   The desktop build stages its backend, rebuilds `better-sqlite3` for the
   installed Electron version and host architecture, and smoke-tests an
   in-memory database under Electron before Forge packages the app. A successful
   run prints `Verified better-sqlite3 for Electron <version> (<architecture>).`
   Build each artifact on a host matching its target architecture, as the
   release workflow's native arm64 and Intel runners do.

3. Commit and push the version and release changes, then create and push the
   matching tag:

   ```sh
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

The tag must exactly match the root package version after removing its leading
`v`. A mismatch stops both CLI and desktop release jobs.

## Verify a release

Confirm that the `Release` workflow completed for both native macOS runners and
that its signing checks passed: strict code-signature verification, Gatekeeper
assessment, and stapled notarization-ticket validation. For a stable release,
also verify:

```sh
brew update
brew install --cask dante-teo/tap/railgun
```

Open the installed application once and verify that Settings can complete
provider sign-in and start the backend.

## Recover from a failed release

Use GitHub Actions' **Re-run failed jobs** operation after fixing a transient
credential, notarization, or tap failure. The workflow is designed to resume:

- npm publication is skipped when the exact package version already exists;
- an existing GitHub release receives replacement ZIP assets via
  `gh release upload --clobber`; and
- an unchanged Homebrew Cask exits without creating an empty commit.

Do not delete an already published npm version or move a published tag. If an
artifact is invalid after publication, fix the issue and release a new version.
