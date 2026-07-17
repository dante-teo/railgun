# Railgun for macOS

Railgun is a signed macOS desktop app for working with an AI coding agent. The
Node backend is bundled inside the app and is not a supported command-line or
npm product.

## Install and update

Choose one installation channel:

- Direct: download the signed app from the Railgun GitHub Release. The app
  checks the direct-release update feed, downloads updates in the background,
  and offers to restart when one is ready. Choose **Railgun → Check for
  Updates…** to check manually. A progress dialog remains visible while the
  manual check is running.
- Homebrew: install with `brew install --cask railgun`. Homebrew owns updates;
  run `brew upgrade --cask railgun`. The app deliberately disables its updater
  in this channel.

Do not install one channel over the other. Remove the old app first if you are
switching channels.

## Scheduled work and maintenance

Use the **Scheduled** page to create, edit, or remove prompts. Scheduled data,
credentials, sessions, skills, memories, and logs remain in `~/.railgun`.

Use **Settings → General** to control background automation. It is opt-in and
installs two user launchd agents:

- `sh.railgun.cron` runs scheduled prompts while the app is closed.
- `sh.railgun.dream` runs nightly maintenance at local midnight.

Settings reports whether launchd is healthy. Use **Repair** after moving or
updating the app if it reports an old app location. Disabling automation stops
both services without removing your scheduled jobs or other Railgun data.
If credentials are unavailable, background services exit normally; sign in from
Settings and launchd will run them on their next start.

## Recovery

If the app asks you to sign in, sign in from Settings and then retry. Background
services never open browser authentication; they exit cleanly until credentials
are available. Scheduler logs are retained under `~/.railgun/cron/logs/`.

## Shell command environment

Railgun runs agent shell commands through your login shell in non-interactive
mode. This loads login environment setup—such as Homebrew's `PATH`—without
loading interactive aliases or functions. That boundary ensures the command
shown for approval is the command that runs; use an executable or login-shell
environment configuration rather than an interactive shell alias for commands
you want Railgun to invoke.

## Development and release

`pnpm dev` runs the desktop app from source. `pnpm dev:mock` uses the desktop
mock backend. The release version is defined only in
`apps/desktop/package.json`; releases use `vX.Y.Z` tags and build both
direct and Homebrew artifacts for arm64 and x64. Create the version commit and
tag with `pnpm release:version patch`; see
[release instructions](docs/RELEASING.md) for the artifact and signing checks.

The RailgunX native scaffold requires Xcode and XcodeGen `2.45.4`. The pinned
version is recorded in `apps/macos/.xcodegen-version`; generation fails before
writing project files when the installed version does not match. Install the
pinned XcodeGen version, make it available on `PATH`, and confirm it before
generating a project:

```sh
xcodegen --version
# Version: 2.45.4
```

Generated Xcode projects are disposable. Create one explicitly with:

```sh
./apps/macos/scripts/generate-project.sh /tmp/railgunx-project
```

RailgunX pins [Swift Markdown](https://github.com/swiftlang/swift-markdown)
`0.8.0` and [Sparkle](https://github.com/sparkle-project/Sparkle) `2.9.4`.
`apps/macos/Package.resolved` is the reviewed source-controlled lockfile;
generation seeds it into each disposable Xcode project. The generated app
links Markdown and packages Sparkle.framework in its bundle. Sparkle is a
binary framework, so `project.yml` includes a guarded `Embed Sparkle Framework`
post-build phase; keep it when changing package declarations because XcodeGen's
generic package embed phase cannot represent its `.framework` filename. To
intentionally refresh the lockfile after changing an exact version, run:

```sh
./apps/macos/scripts/resolve-packages.sh
```

### Native legal notices

RailgunX bundles `ThirdPartyNotices.md` and `LegalNoticeManifest.json` as app
resources; no legal-notices UI is provided yet. The catalog records the locked
Swift packages, Node 24 LTS licensing, first-party icon provenance, Railgun's
MIT license, and the complete macOS production backend closure. The concrete
Node archive metadata and checksums are pinned in
`apps/macos/Runtime/node-runtime.json` and are tracked legal inputs.

After a root `pnpm-lock.yaml`, package-license, Swift pin, first-party license,
or icon-source change, regenerate the catalog from an installed dependency tree:

```sh
pnpm install
node apps/macos/scripts/generate-legal-notices.mjs --write
```

`--write` reads package-provided legal files and refuses a metadata-only license
unless the repository bundles the full matching license text. `--check` is run
by `validate-project.sh`: it compares the complete generated catalog when
packages are installed, or validates the checked-in catalog's tracked-input and
notice hashes in a clean checkout. Neither mode requires the ignored backend
deployment directory.

### Pinned Node runtime

RailgunX stages Node.js `24.18.0` only from the official, checksum-pinned
Darwin archives named in `apps/macos/Runtime/node-runtime.json`; runtime
binaries are never committed. To stage one architecture into a caller-owned
build directory, run:

```sh
apps/macos/scripts/stage-node-runtime.sh --architecture arm64 --output build/runtime-arm64
```

The complete distribution is staged at `build/runtime-arm64/node`. The command
refuses to replace an existing `node` output and verifies the archive checksum,
LICENSE, Node version, archive layout, and Mach-O architecture before staging.
`validate-node-runtime.sh` exercises both `arm64` and `x86_64`; it runs from
`validate-project.sh` and native CI.

### Native backend staging

The production native backend is staged with the matching runtime and a fresh
`better-sqlite3` build:

```sh
apps/macos/scripts/stage-backend.sh \
  --architecture arm64 \
  --output build/native-resources
```

The output layout is:

```text
build/native-resources/backend/node
build/native-resources/backend/railgun/dist/backend.js
build/native-resources/backend/railgun/node_modules/...
```

Each artifact is single-architecture. The stager deploys only the backend's
production dependency closure, removes type-only automatic peers, stages the
pinned Node 24 runtime, and invokes the direct exact root `node-gyp` dependency
with that runtime's headers. It deletes any downloaded `better-sqlite3`
prebuild before compiling, then loads both `better-sqlite3` and the
architecture-specific `sqlite-vec` extension under the staged Node ABI. The
production deploy runs under the staged runtime so pnpm selects optional native
dependencies for the requested architecture. On Apple silicon, x86_64 staging
requires Rosetta 2 and an Xcode Command Line Tools installation capable of
running x86_64 build tools; both architectures also require `pnpm`, Python 3,
`make`, and `clang++`.

Validate both isolated architecture payloads with:

```sh
apps/macos/scripts/validate-backend.sh
```

The generated Xcode project runs the same stager in a pre-signing build phase,
passing `CURRENT_ARCH` and the app's Resources directory. A Debug app therefore
contains `Contents/Resources/backend/node` and
`Contents/Resources/backend/railgun`; `validate-project.sh` validates that final
bundle in addition to isolated staging.

### Native module boundaries

`apps/macos/project.yml` defines static-library modules and their one-way
dependencies. `RailgunX` is the application composition root:

- `RailgunCore` is the Foundation-only domain layer with no project dependencies.
- `RailgunTransport` depends on `RailgunCore`.
- `RailgunServices` depends on `RailgunCore` and `RailgunTransport`.
- `RailgunUI` depends on `RailgunCore` and contains reusable SwiftUI components.
- `RailgunTestSupport` depends on Core, Transport, and Services; only
  `RailgunXTests` links it.
- `RailgunX` depends on Core, Transport, Services, and UI.

`RailgunUI` currently exposes the shared native design definitions described
below, plus the empty custom-component registry and its contract foundation.
Swift Markdown and Sparkle remain application packaging dependencies until a
later milestone assigns an API owner.

### Native deterministic test infrastructure

Native tests must use `TemporaryRailgunHome` from `RailgunTestSupport` rather
than the developer's real home directory. It creates an empty, unique
`$HOME/.railgun`, exposes `environment` for process boundaries, and can be
registered with XCTest teardown through `temporaryRailgunHome()`. Tests must
never acquire the real client lock or read or write the real `~/.railgun`.

The shared RPC v1 corpus is in `fixtures/rpc/v1/`. Its `manifest.json` is the
source of truth for both Swift and desktop mock-backend contract tests. A
scenario contains ordered steps; each step references an exact JSONL request,
one or more raw stdout-chunk files, delay metadata, and an `open` or `eof`
terminal state. Preserve those files and their byte boundaries—do not recreate
the frames through JSON serialization in tests.

The foundational scenarios cover successful initialization, a correlated
command rejection, malformed stdout, delayed success, and EOF after readiness.
The EOF scenario deliberately remains open after `initialize`; it returns a
successful `get_state` response before EOF, matching the desktop
`disconnect-after-ready` mock lifecycle.

`RPCFixtureLoader` loads this corpus from the test bundle, so Swift tests must
not derive repository-relative paths. `ScriptedMockBackend` validates the exact
ordered JSONL input, records received data, and returns the declared raw chunks,
timing metadata, and terminal state without launching a process or sleeping.
When adding a foundational protocol case, update the manifest and raw files,
then add or extend both the Swift and desktop contract tests.

### Native design foundations

Use `RailgunUI` semantic roles when a SwiftUI feature needs an application
appearance decision. They map to macOS system colors, dynamic text styles, and
SwiftUI materials; they do not replace native control styling. Continue to use
native `Button`, `List`, `TextField`, `Toggle`, menus, sheets, and focus
behavior without custom control chrome.

The [native-first UI policy](docs/native-ui-policy.md) defines the required
customization decision record, approved AppKit bridge inventory, shared
component governance, and validation and retirement requirements.

Reusable custom controls are an exception, not a replacement for native
SwiftUI composition. Before adding one, complete the policy decision record,
define and register a `RailgunCustomComponentSpecification` in `RailgunUI`,
use `RailgunCustomComponentPreviewMatrixView` for its `#Preview` matrix, and
add focused contract tests. `RailgunCustomComponentRegistry.components` starts
empty by design; feature-local compositions using native SwiftUI controls do
not belong in it.

- `RailgunColorRole` provides accent, text, destructive, separator, canvas,
  and surface colors. Use its `color` value—for example,
  `RailgunColorRole.secondaryText.color`—rather than fixed color values.
- `RailgunTypographyRole` provides dynamic system fonts for body, emphasized
  body, secondary text, titles, section titles, and captions. Apply its `font`
  value so macOS accessibility settings remain effective.
- `RailgunSpacing` defines the shared 4, 8, 12, 16, and 24 point scale through
  its `points` value.
- `RailgunMaterialRole` selects native regular, bar, thin, and ultra-thick
  materials for content, sidebars, overlays, and HUD-style surfaces.
- `RailgunFocusPolicy` deliberately preserves SwiftUI's standard focus effect;
  do not draw a replacement focus ring.
- `RailgunMotion.animation(reduceMotion:)` returns no animation when reduced
  motion is enabled. Pass SwiftUI's `accessibilityReduceMotion` environment
  value to it instead of branching on a global setting.
- `RailgunCustomComponentValidator` provides deterministic contract failures
  for XCTest, including required preview coverage, unique preview axes, and
  interactive-accessibility requirements. Keep component contracts and the
  registry in `RailgunUI`.

### Native lifecycle shell

RailgunX currently provides one restorable primary SwiftUI scene, identified as
`primary`. It opens at 1024×700, enforces a 760×520 content minimum, and remains
user-resizable above that minimum. The native `Settings` scene provides the
standard macOS Settings command; it is intentionally a non-interactive
placeholder until the Task alpha. Feature commands and editable preferences are
deferred to their assigned Swift milestones.

Validate deterministic generation, clean-cache package resolution, the
checked-in lockfile, legal notices, build, and tests with:

```sh
./apps/macos/scripts/validate-project.sh
```

Launch the native scaffold with `./scripts/run.sh`, or use
`./scripts/run-mock.sh` to select its deterministic mock-backend placeholder.
Set `RAILGUNX_BUILD_ROOT` to retain the generated project and derived data in a
specific location. Both scripts launch the built `.app` bundle through macOS
LaunchServices so bundle metadata, including the AppIcon used by About, is
resolved correctly. Because LaunchServices does not inherit shell environment
variables, `run-mock.sh` forwards mock mode as the
`--railgunx-backend-mode=mock` launch argument. This mock mode is limited to the
native shell until the planned transport and backend integration land.

Run the complete check suite from the repository root with:

```sh
pnpm run typecheck
pnpm run test
pnpm --filter @dantea/railgun-desktop typecheck
pnpm --filter @dantea/railgun-desktop test
```

## Documentation

- [Product overview](docs/PRODUCT.md)
- [Desktop architecture](docs/ARCHITECTURE.md)
- [Design system and interaction contracts](docs/DESIGN.md)
- [Swift implementation plan](docs/swift-plan.md)
- [Current architecture ADR](docs/adr/0001-railgun-current-architecture.md)
- [Release procedure](docs/RELEASING.md)
- [Diagnostics](docs/INTERACTIVE_DIAGNOSTICS.md) and [operational diagnostics](docs/OPERATIONAL_DIAGNOSTICS.md)
