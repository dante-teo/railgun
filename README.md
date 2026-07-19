# Railgun for macOS

Railgun is a signed macOS desktop app for working with an AI coding agent. The
Node backend is bundled inside the app and is not a supported command-line or
npm product.

## Install and update

Download the signed app from the Railgun GitHub Release. The app checks the
direct-release update feed, downloads updates in the background, and offers to
restart when one is ready. Choose **Railgun → Check for Updates…** to check
manually. A progress dialog remains visible while the manual check is running.

Homebrew distribution is no longer published or updated by the release
pipeline. Existing Homebrew installations retain their legacy update-channel
behavior; use the direct release for current installations.

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
`apps/desktop/package.json`; releases use `vX.Y.Z` tags and build direct
artifacts for arm64 and x64. Create the version commit and tag with
`pnpm release:version patch`; see
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

Do not treat an existing `apps/macos/RailgunX.xcodeproj` as source-controlled
or authoritative. Local `apps/macos/*.xcodeproj` directories are ignored and
can become stale as Swift files are added. Generate a fresh project before
using Xcode directly; the validation script below does this automatically.

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

### Shared desktop-client lock

RailgunX and Railgun Classic coordinate access to `~/.railgun` through the
shared desktop-client lock. Preserve its record and stale-recovery rules when
changing either client; see the [lock protocol](docs/desktop-client-lock.md).

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

In addition to checking architecture, production dependencies, and direct
`better-sqlite3` / `sqlite-vec` loading, this starts each packaged backend in
an isolated temporary home. It verifies the machine-readable
authentication-required startup path without credentials, then uses a
validation-only provider loader to exercise RPC `initialize` and `get_state`,
creation of the SQLite state database, forced-crash recovery, restart, and
graceful stdin-close shutdown. The validation never reads a developer's
credentials or modifies `~/.railgun`.

The generated Xcode project runs the same stager in a pre-signing build phase,
passing `CURRENT_ARCH` and the app's Resources directory. A Debug app therefore
contains `Contents/Resources/backend/node` and
`Contents/Resources/backend/railgun`; `validate-project.sh` validates that final
bundle in addition to isolated staging.

### Native backend process lifecycle

`RailgunTransport.BackendProcess` is the sole owner of one native backend child
process and its standard-input, standard-output, and standard-error pipes.
Start it with `BackendProcessLaunch`, which supplies the executable URL,
arguments, optional working directory, and optional environment. A successful
launch returns `BackendProcessPipes`; callers assign one input writer and one
reader to each output pipe.

The actor rejects concurrent launches, reports `idle`, `running`, or the most
recent `exited` state, and can be reused after either a failed launch or a
recorded exit. `waitForTermination()` returns the exit reason and status for the
active or latest process.

`terminate()` closes stdin, sends `SIGTERM`, and sends `SIGKILL` only if that
same process remains alive after its grace period (two seconds by default).
`forceTerminate()` sends `SIGKILL` immediately; `shutdown()` combines graceful
termination with waiting for the recorded result.

`RailgunTransport` concurrently consumes those raw output pipes. It exposes
validated stdout JSON-object frames as raw `Data` and opaque, bounded stderr
chunks through independent async streams. Its Electron-compatible defaults cap
each stdout frame at 4 MiB, an unfinished stdout buffer at 8 MiB, one queued
stdout frame, and 64 queued stderr chunks. A slow stdout consumer therefore
fails the stdout stream instead of retaining unbounded output; stderr remains
best-effort. Malformed, non-object, oversized, unreadable, or partial-at-EOF
stdout also fails that stream. Closing the transport finishes public streams
but continues draining pipes so it cannot signal the active backend. Clean
stdout EOF and all stderr EOF are normal.

`RailgunRPCClient` owns one transport/process generation above those raw
streams. `start()` sends `initialize-<generation>` for RPC v1 with
`clientName: "railgunx"`, requires `sessions`, `interaction.approval`, and
`interaction.clarification`, retains all negotiated capabilities, then requires
a successful `get_state` readiness probe within a 15-second startup budget.
Ordinary callers provide a JSON-object payload with `type` and no `id`; the
client assigns `request-<generation>-<sequence>`, correlates only the matched
response, and returns its raw response object. Each call supplies its own
timeout. Cancellation, timeout, malformed/mismatched responses, EOF, process
exit, restart, and shutdown settle or discard only the affected generation's
work; late and stale-generation frames are ignored. An unexpected EOF, transport
failure, or process exit after readiness also emits one
`unexpectedTerminations` event. The native app uses that event to leave the
Task shell, mark the backend disconnected, and offer a retry instead of
presenting unavailable task controls.

The client uses `RailgunTransportConfiguration.rpcCompatible`, which retains
validated stdout bursts until the RPC reader consumes them. This is intentional:
backends may emit several event frames before a correlated response. Frame and
unfinished-buffer byte limits remain in force.

`RailgunRPCCommand` provides the validated RPC v1 command envelope for new
callers; it reserves correlation IDs for the client and validates command
fields, pagination limits, MCP environment patches, and interaction bounds
before encoding JSON. `RailgunRPCResponse`, `RailgunRPCInitializeResult`,
`RailgunRPCSessionState`, and `RailgunRPCInteractionRequest` validate the
received protocol data needed by the transport layer. Integer DTO fields use a
non-trapping exact conversion, so malformed out-of-range backend numbers are
rejected as malformed data rather than crashing the client. The raw request API
remains available for fixture replay and forward-compatible protocol probes.

Approval and clarification requests are emitted through the client's separate
`interactions` stream with opaque client correlation IDs; backend request IDs
never reach presentation state. The stream preserves arrival order for its
oldest 128 requests. If it cannot admit a newer request, the client safely
denies that request and removes its correlation state, preventing the backend
from waiting on an unreachable prompt. Duplicate requests are ignored; blank
or otherwise malformed request IDs use the safe denial or abort path. A failed
interaction response remains pending for retry, while run end, restart,
shutdown, and disconnection settle every pending interaction.

`RailgunRPCRedactor` recursively removes credential-like fields, environment
values, token forms, and filesystem paths before values are presented. Its
diagnostic summaries include only bounded protocol metadata (`type`, response
command, whether an ID is present, status, and success); they never include RPC
payloads, tool details, environment values, or error bodies. Event
normalization, diagnostics retention, and logging remain the responsibility of
later protocol layers.

Stdout framing is byte-based: `\n` terminates a frame, blank lines are ignored,
and the `\r` in a CRLF terminator is removed. Each `stdoutFrames` element is
the original JSON-object bytes; malformed JSON and syntactically valid
non-object JSON are distinct terminal errors. `stderrChunks` is deliberately
opaque and best-effort, so diagnostics policy can be added without changing
the transport boundary.

### Native authentication and restart coordination

`RailgunBundledBackendLaunchFactory` launches the staged
`Contents/Resources/backend/node/bin/node` runtime with the staged
`backend/railgun/dist/backend.js` entry point. Desktop RPC launches run the
`desktop` command with `RAILGUN_DESKTOP_RPC=1`; login and logout helpers run
the corresponding command from the user's home directory with that variable
removed. All launches preserve inherited environment values, including an
environment-managed `DEVIN_TOKEN`.

`RailgunAuthenticationService` serializes login and logout. It leaves an
active RPC generation running while the browser-backed helper runs, drains both
helper output streams without retaining or exposing OAuth and credential
details, and restarts RPC only after a zero exit status. Helper launch and exit
failures are intentionally redacted; they leave the current RPC backend in
place. Service shutdown terminates an active helper and prevents a restart.

When the private bundled backend's `desktop` entry point cannot authenticate,
it emits exactly one JSONL startup frame before exiting:

```json
{"type":"startup_status","status":"authentication_required","credential_source":"file"}
```

`credential_source` is either `file` or `environment`. `RailgunRPCClient`
recognizes only the documented type, status, and source values and surfaces a
typed authentication failure; malformed, unknown, and unrelated startup frames
retain ordinary safe transport handling. After logout, a file-backed
authentication-required restart is an expected outcome. An environment-backed
failure still requires the user to update the inherited `DEVIN_TOKEN` and
relaunch. Native presentation and controls remain deferred to `SWFT-036` and
`SWFT-057`.

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
standard macOS Settings command and lists archived tasks with native Restore
actions. The richer searchable preferences and archive-management surfaces
remain deferred to their assigned Swift milestones.

A selected, hydrated task renders its restored and live messages in a native
`ScrollView` and `LazyVStack`. Messages are selectable plain text until the
Markdown milestone: user messages use a compact framed treatment, while
assistant messages remain unframed. Tool, advisor, MoA, and subagent activity is
intentionally withheld from this transcript until the activity milestone.
Loading, empty, selection-required, and stale-selection states retain the same
root scroll view for layout stability but do not render or accessibility-expose
messages retained by the reducer. Their centered state presentations and any
session-operation error banner remain non-scrolling overlays.

The transcript opens at the latest message, follows content and viewport-size
changes while within four points of the bottom, and preserves the reader's
position after they scroll away. New output then exposes a native **Jump to
Latest** button. On macOS 26 and later, it retains the native vertical scroller
and applies the system soft top-edge effect. Do not hide or replace that
scroller: doing so prevents the edge effect from rendering. The complete
implementation and cold-launch verification contract is documented in
[`docs/native-ui-policy.md`](docs/native-ui-policy.md#transcript-soft-top-edge-invariant).

The Activity toggle lives in the native sidebar toolbar. When Activity is
requested and the detail viewport is at least 900 points wide, a full-height
leading pane reserves 360 points beside the transcript. At narrower widths, the
same toggle presents Activity as a floating popover and reserves no transcript
space. Neither presentation is part of the transcript scroll content.

Validate deterministic generation, clean-cache package resolution, the
checked-in lockfile, legal notices, build, and tests with:

```sh
./apps/macos/scripts/validate-project.sh
```

Launch the native scaffold with `./scripts/run.sh`,
`./scripts/run-source.sh`, or `./scripts/run-mock.sh`. The default uses the
bundled backend selection. The source and mock launchers pass their mode and
repository root explicitly; the mock launcher also passes the `ready-idle`
scenario. Set `RAILGUNX_BUILD_ROOT` to retain the generated project and derived
data in a specific location. All launchers open the built `.app` bundle through
macOS LaunchServices so bundle metadata, including the AppIcon used by About, is
resolved correctly.

Bundled mode uses the pinned Node runtime staged inside the app. Source and mock
modes also prefer that staged runtime when launching their repository scripts,
so LaunchServices and XCTest do not depend on inheriting a developer shell's
`PATH`. The launch configuration retains `/usr/bin/env node` only as a fallback
when used without a staged app resource. The mock script is produced by the
desktop backend-assets or packaging checks. Generate it directly when needed
with:

```sh
pnpm --filter @dantea/railgun-desktop build:backend-assets
```

For a custom source root or mock scenario, invoke the common launcher directly:

```sh
./scripts/run.sh --backend-mode source --source-root "$PWD"
./scripts/run.sh --backend-mode mock --mock-scenario ready-idle --source-root "$PWD"
```

The app gives explicit `--railgunx-*` launch arguments priority over the
equivalent `RAILGUNX_*` environment values, which keeps LaunchServices launches
deterministic. A source-root value may be the repository directory itself or a
generated `.railgun-source-root` marker. Xcode generates shared `RailgunX
Source Backend` and `RailgunX Mock Backend` Debug schemes that use that marker
instead of embedding a developer-specific path. Both selections launch a live
RPC backend: after a successful readiness probe, RailgunX loads active and
archived tasks and enables new, resume, archive, and restore operations.
**Archive Task** is enabled only for a selected persisted task; unsaved new
tasks cannot invoke a backend operation that will be rejected. Restore actions
live in Settings rather than the Task toolbar. A backend launch,
authentication, or later connection failure replaces the task shell with an
actionable status and retry control; rejected task operations are shown next to
the task detail area.

Run the complete check suite from the repository root with:

```sh
pnpm run typecheck
pnpm run build
pnpm run test
pnpm --filter @dantea/railgun-desktop typecheck
pnpm --filter @dantea/railgun-desktop test
pnpm --filter @dantea/railgun-desktop package
./apps/macos/scripts/validate-project.sh
```

`validate-project.sh` validates both backend architectures, generates the
project twice to check determinism, resolves the locked Swift packages in a
clean cache, builds the app, validates the bundle, and runs the generated
project's XCTest suite. A separate test against a local
`apps/macos/RailgunX.xcodeproj` is intentionally omitted because that ignored
project may be stale.

## Documentation

- [Product overview](docs/PRODUCT.md)
- [Desktop architecture](docs/ARCHITECTURE.md)
- [Shared desktop-client lock protocol](docs/desktop-client-lock.md)
- [Design system and interaction contracts](docs/DESIGN.md)
- [Swift implementation plan](docs/swift-plan.md)
- [Current architecture ADR](docs/adr/0001-railgun-current-architecture.md)
- [Release procedure](docs/RELEASING.md)
- [Diagnostics](docs/INTERACTIVE_DIAGNOSTICS.md) and [operational diagnostics](docs/OPERATIONAL_DIAGNOSTICS.md)
