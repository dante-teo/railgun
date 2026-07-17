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

The current scaffolding intentionally exposes no module APIs. Swift Markdown
and Sparkle remain application packaging dependencies until a later milestone
assigns an API owner.

Validate deterministic generation, clean-cache package resolution, the
checked-in lockfile, build, and tests with:

```sh
./apps/macos/scripts/validate-project.sh
```

Launch the native scaffold with `./scripts/run.sh`, or use
`./scripts/run-mock.sh` to select its deterministic mock-backend placeholder.
Set `RAILGUNX_BUILD_ROOT` to retain the generated project and derived data in a
specific location. This mock mode is limited to the native shell until the
planned transport and backend integration land.

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
