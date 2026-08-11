# Electron desktop packaging

- `apps/desktop` is Railgun's only desktop application and release surface.
- Production packages support macOS 15 or newer on arm64 only and retain the
  `io.anvia.railgun` bundle identifier and `Railgun` product name.
- Keep privileged operations in the Electron main process or behind the
  context-isolated preload boundary. Do not expose packaging or update APIs to
  the renderer.
- Packaged builds must include the locked release `railgun-backend` at
  `Contents/Resources/backend/railgun-backend` and the generated legal notices
  under `Contents/Resources/legal`.
- Preserve source and mock backend environment contracts. Packaged builds must
  resolve their backend from Electron's resources path without an environment
  override.
- `scripts/run.sh` and `scripts/run-mock.sh` launch the Electron GUI. Run them
  only when the user explicitly asks to launch the app; use non-GUI checks for
  verification.
- Tagged releases are signed, notarized, stapled, and published by
  `.github/workflows/publish.yml`. Keep the Sparkle appcast as a compatibility
  artifact only; do not add Sparkle to the Electron runtime.
- Release validation must inspect the staged application and the exact
  `Railgun.app` copies extracted from the ZIP and mounted from the DMG. Preserve
  signature, hardened-runtime, stapling, metadata, legal-notice, embedded
  backend, and backend-lifecycle checks for all three copies.
- Keep the Sparkle bridge fail-closed: the configured public key must match the
  ZIP application's `SUPublicEDKey`, and Sparkle must emit an EdDSA signature
  from the configured private key before the appcast can be published.
- A new release tag must use a build number greater than the latest published
  release. A rerun of the currently published tag may reuse that tag's build
  number so its release assets can be repaired or replaced.
