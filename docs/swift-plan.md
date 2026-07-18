# RailgunX Swift implementation plan

This document is the authoritative implementation roadmap for replacing the
Electron desktop client with a native macOS client. The current-state
[architecture ADR](adr/0001-railgun-current-architecture.md) continues to
describe the shipped Electron application until RailgunX implementation begins.

## Product context

RailgunX is a native client replacement, not a backend rewrite. It reuses the
existing TypeScript backend through versioned JSONL RPC and initially ships
beside the Electron application as a Task-focused alpha. Direct signed and
notarized distribution comes first; Homebrew follows after feature parity.

The native application initially ships as **RailgunX** with bundle ID
`io.anvia.railgun`. At final cutover, RailgunX becomes **Railgun** without
changing that bundle ID, while Electron becomes **Railgun Classic** and is
retired after a published support window. Classic keeps its existing
`sh.railgun.desktop` identity. The new native app-icon system remains in use
when RailgunX becomes Railgun.

Both applications may be installed at the same time. Both clients use
`~/.railgun` in place, without copying or migrating user data, but only one
interactive desktop client may operate on it at a time. A cross-client lock
prevents concurrent access and records the PID, bundle ID, client name, and
start time.

This work does not add a cloud service, telemetry system, App Store channel, or
user-data migration.

## Delivery principles

- Use Swift 6 and SwiftUI, XcodeGen, and Swift Package Manager.
- Prefer native SwiftUI controls and system styling everywhere.
- Add a custom component only when a documented requirement cannot be met by a
  native control, and keep reusable custom UI in a shared module.
- Build with the macOS 26 SDK and deploy to macOS 15. Adopt macOS 26-only APIs
  through availability checks and retain macOS 15 fallbacks.
- Keep the TypeScript backend authoritative for existing agent behavior and
  preserve the versioned RPC command and capability contract.
- Release separate arm64 and x86_64 signed, notarized artifacts and Sparkle
  appcasts.
- Add focused tests before or alongside every behavior change. Tests use
  temporary home directories and must never touch the real `~/.railgun`.

## Architecture decisions

### Project and dependencies

Add `apps/macos/project.yml` as the source of truth for the Xcode project,
targets, schemes, build settings, and test configuration. Generated `.xcodeproj`
files are disposable and must never be hand-edited or committed. Generation and
validation scripts must produce a reproducible project in local development and
CI.

Use Swift Package Manager with exact dependency versions committed in
`Package.resolved`. The initial third-party packages are Swift Markdown and
Sparkle. The generated app must link Markdown and embed Sparkle.framework;
validation checks that the framework is present in the app bundle. Keep app,
core domain, transport, services, `RailgunUI`, and test support boundaries
explicit so feature state is testable without launching the application.

Build with the macOS 26 SDK and deploy to macOS 15. Use `#available` checks for
macOS 26 presentation APIs; newer presentation must be progressive enhancement,
not a second behavior path.

### App structure and concurrency

Use the SwiftUI app lifecycle with a primary window, a `Settings` scene, the
standard Settings command, state restoration, and a documented minimum window
size. Feature commands are deferred to `SWFT-037`. Feature state uses
`@Observable @MainActor`. Process, transport, filesystem,
authentication, automation, and update work belongs in actors so ownership and
cancellation are explicit.

The high-level boundary is:

```text
SwiftUI features and shared RailgunUI
              ↕ observable state and services
Process, transport, filesystem, auth, automation, and update actors
              ↕ versioned JSONL over stdio
Bundled Railgun TypeScript backend
```

### Backend packaging and RPC

Bundle a pinned Node 24 LTS runtime, the production backend, production
dependencies, third-party licenses, and architecture-matched native modules
including `better-sqlite3` and `sqlite-vec`. The production dependency deploy
runs under the staged Node runtime so optional native packages match the
artifact architecture. Staging verifies runtime checksums, Node ABI
compatibility, native extension loading, backend startup, and architecture
before signing.

Initialize RPC v1 with `clientName: "railgunx"`. Preserve existing commands and
capabilities. Transport must bound frames and buffers, reject malformed output,
correlate responses to request IDs and process generations, apply timeouts, and
redact diagnostics. Contract fixtures are shared between TypeScript and Swift.

Raw backend activity frames never enter SwiftUI feature state. The transport
normalizes only the supported lifecycle, assistant text, tool, todo, advisor,
MoA, subagent, queue, and context-usage events into a bounded, presentation-safe
stream that survives backend restarts. Unknown or malformed events are withheld;
tool detail, todo text, advisor text, MoA previews, and subagent text are
redacted and bounded before delivery. A malformed todo snapshot withholds only
the snapshot while retaining its containing tool completion event.

Approval and clarification requests travel on a separate presentation-safe
stream. Each request receives an opaque client correlation ID while its backend
request ID stays transport-private. Open requests preserve arrival order and
settle on run end, restart, shutdown, or disconnection. The stream retains its
oldest bounded queue; a newer request that cannot be delivered is safely denied
and removed rather than leaving the backend blocked. Malformed requests,
including blank IDs, take the same safe denial or abort path.

### Shared data and client exclusion

RailgunX reads and writes the existing `~/.railgun` data directly. It does not
copy, transform, or silently repair shared data. Before starting an interactive
backend, RailgunX acquires the [shared desktop-client lock](desktop-client-lock.md)
containing PID, bundle ID, client name, and start time. Railgun Classic must
participate in the same lock protocol. Both clients detect live conflicts,
recover only demonstrably stale locks, and present a clear conflict UI instead
of starting a second backend.

### Signing, updates, and distribution

App Sandbox remains disabled because Railgun executes tools, shells, MCP
servers, and home-directory operations. Hardened Runtime and Developer ID
signing are required. The app, bundled Node runtime, native addons, and other
nested code are signed in the correct inside-out order before notarization and
stapling.

Publish separate arm64 and x86_64 direct artifacts. Sparkle uses separate HTTPS
appcasts for each architecture with EdDSA verification. Classic update channels
remain unchanged during the side-by-side period. Homebrew moves to native
Railgun only during final replacement.

## Native UI implementation contract

The [native-first UI policy](native-ui-policy.md) is the operational reference
for customization decisions, approved AppKit bridges, shared-component
governance, validation, and retirement. This section records the roadmap-level
contract it enforces.

### Native-first rule

Start with native SwiftUI components: `NavigationSplitView`, `List`, `Table`,
`Form`, `Section`, `Toolbar`, `Button`, `TextField`, `TextEditor`, `SecureField`,
`Toggle`, `Picker`, `Menu`, `DisclosureGroup`, `ProgressView`,
`ContentUnavailableView`, `Settings`, `sheet`, `alert`, `confirmationDialog`,
and `inspector`.

Retain system typography, control sizes, focus behavior, keyboard navigation,
menu integration, accessibility semantics, animations, materials, and platform
spacing unless a requirement explicitly demands otherwise. Do not recreate
system controls, menus, dialogs, sidebars, toolbars, forms, or materials with
custom drawing.

Use AppKit bridges only for behavior unavailable in deployment-target SwiftUI.
Approved categories begin with the advanced composer, Quick Look, precise
window coordination, and behavior verified as impossible with the supported
SwiftUI APIs. Every bridge remains narrowly encapsulated and must preserve
native keyboard, focus, selection, and accessibility behavior.

### Custom-component decision record

Before adding a custom component, record:

1. The unmet product or interaction requirement.
2. The native SwiftUI approaches evaluated and why they are insufficient on
   the deployment target.
3. Keyboard, focus, VoiceOver, accessible-name, state, and motion behavior.
4. Every supported content, emphasis, size, semantic role, selection, loading,
   destructive, compact, and material variant that applies.
5. Why customization is necessary and what native API could later replace it.

Place reusable custom UI in the dedicated `RailgunUI` target. Feature targets
must not create independent versions of the same control. Model variants with
enums and configuration values instead of one-off modifiers or boolean
combinations. Centralize appearance through semantic system colors and shared
styles; feature code supplies content and state, not component-local colors or
arbitrary geometry.

Each custom component requires previews covering every variant, light and dark
appearance, increased contrast, reduced transparency, reduced motion, long
content, error/loading/disabled states, and relevant window widths. Each
interactive custom component requires keyboard, focus, VoiceOver,
accessible-name, and state tests. When a newer macOS release supplies an
adequate native replacement, migrate to it and retire the custom implementation.

## Security boundaries

- Treat backend stdout as untrusted framed input. Bound frame and aggregate
  buffer sizes, reject malformed JSON, handle EOF and stderr explicitly, and
  discard responses from stale process generations.
- Validate all RPC DTOs and interaction responses. Redact secrets, provider
  payloads, tool arguments/results, environment values, filesystem paths, and
  diagnostics before presentation or logging.
- Root file browsing at the user's home directory. Canonicalize paths, reject
  traversal and escaping symlinks, bound directory and preview sizes, and use
  Quick Look only for validated local URLs.
- Keep credentials and MCP secrets out of observable feature state. Expose
  status and redacted configuration through dedicated actors.
- Serialize configuration mutations and preserve unknown fields expected by
  Classic and the backend.
- Generate and inspect launch agents using fixed identifiers and validated
  paths. Scheduled owns persistent job definitions, while Settings → Background Automation owns
  the opt-in and launch-agent controls.
- Sign and verify all nested executable code. Validate signatures, Gatekeeper,
  notarization tickets, updater feeds, and packaged backend behavior before
  publication.
- Automated tests and previews use isolated temporary homes and deterministic
  mocks; they never acquire the real client lock or modify real user data.

## Milestones and implementation checklist

Checklist IDs are immutable and use `SWFT-001` through `SWFT-999`. Completed or
removed IDs are never reused or renumbered. New work receives a new ID. Tasks
target approximately five engineering hours and must be split before exceeding
eight hours.

### 1. Project foundation and visual identity

- [x] `SWFT-001` — Scaffold `apps/macos/project.yml`, Swift 6 targets, schemes, tests, and `io.anvia.railgun` configuration. `[6h]`
- [x] `SWFT-002` — Add reproducible XcodeGen generation and validation scripts; exclude generated projects from source control. `[4h]`
- [x] `SWFT-003` — Configure SwiftPM and commit resolved pins for Swift Markdown and Sparkle. `[4h]`
- [x] `SWFT-004` — Establish app, core, transport, services, `RailgunUI`, and test-support module boundaries. `[6h]`
- [x] `SWFT-005` — Build the SwiftUI lifecycle, primary window, Settings scene, standard Settings command, restoration, and minimum sizing. `[8h]`
- [x] `SWFT-006` — Add semantic system color, typography, spacing, material, focus, and motion definitions without replacing native control styling. `[8h]`
- [x] `SWFT-007` — Design the new native Railgun icon system and deliver editable masters plus a 1024×1024 production source. `[8h]`
- [x] `SWFT-008` — Add the AppIcon asset catalog, required sizes, XcodeGen settings, and Dock/Finder/About/notification validation. `[6h]`
- [x] `SWFT-009` — Add deterministic backend mocks, isolated temporary homes, fixtures, and XCTest helpers. `[8h]`
- [x] `SWFT-010` — Record Swift dependency, Node runtime, artwork, and bundled-backend license notices. `[4h]`
- [x] `SWFT-081` — Create the native-first component policy, customization decision template, and inventory of approved AppKit bridges. `[5h]`
- [x] `SWFT-082` — Build the shared custom-component foundation with explicit variants, previews, accessibility contracts, and no feature-local substitutes. `[8h]`

Milestone exit: the generated project builds reproducibly, launches a signed
development shell, has its permanent icon source and assets, and provides
deterministic test infrastructure plus an enforceable native-first UI policy.

### 2. Backend packaging and shared runtime

- [x] `SWFT-011` — Add an architecture-aware staging script for the pinned Node 24 LTS runtime, checksums, and licenses. `[8h]`
- [x] `SWFT-012` — Deploy the production backend closure, select architecture-matched optional native packages, and rebuild/verify `better-sqlite3` and `sqlite-vec` against the bundled Node runtime. `[8h]`
- [x] `SWFT-013` — Add Debug source-backend and mock-backend launch configurations. `[5h]`
- [x] `SWFT-014` — Implement the backend `Process` lifecycle actor, pipes, graceful termination, and forced termination. `[8h]`
- [x] `SWFT-015` — Implement bounded JSONL framing with frame, buffer, malformed-output, EOF, and stderr handling. `[8h]`
- [x] `SWFT-016` — Implement initialization, capabilities, request IDs, response matching, timeouts, and stale-generation rejection. `[8h]`
- [x] `SWFT-017` — Port RPC DTOs, validation limits, redaction, and safe diagnostic summaries to Swift. `[8h]`
- [x] `SWFT-018` — Port event normalization for messages, tools, todos, advisor, MoA, subagents, queues, and context usage. `[8h]`
- [x] `SWFT-019` — Implement approval and clarification correlation, ordering, settlement, and invalid-response handling. `[6h]`
- [x] `SWFT-020` — Add the shared desktop-client lock to RailgunX and Classic, including stale-lock recovery and conflict UI. `[8h]`
- [x] `SWFT-021` — Implement login/logout helpers using the bundled backend and coordinated restart. `[6h]`
- [ ] `SWFT-022` — Verify packaged backend startup, SQLite loading, authentication startup, crash, restart, and shutdown on both architectures. `[8h]`

Milestone exit: both architectures run the bundled backend through RPC v1,
authentication and recovery work, malformed or stale transport data is safely
contained, and RailgunX cannot run concurrently with Classic on shared data.

### 3. Task alpha

- [ ] `SWFT-023` — Build the app store and pure reducers for backend, session, transcript, controls, interactions, and activity. `[8h]`
- [ ] `SWFT-024` — Build the shell using native split navigation, sidebar, toolbar, list selection, and inspector APIs. `[8h]`
- [ ] `SWFT-025` — Implement new, list, resume, archive, and restore-session flows. `[8h]`
- [ ] `SWFT-026` — Implement chronological transcript assembly for restored messages, streaming, tools, errors, and run boundaries. `[8h]`
- [ ] `SWFT-027` — Build transcript virtualization and bottom-follow behavior, introducing custom scrolling only for behavior unavailable natively. `[8h]`
- [ ] `SWFT-028` — Render completed Markdown natively with Swift Markdown while keeping streaming fragments plain. `[8h]`
- [ ] `SWFT-029` — Add encapsulated variants for code blocks and tables while retaining native text selection and scrolling. `[8h]`
- [ ] `SWFT-030` — Build tool activity using native disclosure controls with shared presentation variants. `[8h]`
- [ ] `SWFT-031` — Build the documented `NSTextView` composer bridge with dynamic height, paste, submit/newline, focus, and VoiceOver. `[8h]`
- [ ] `SWFT-032` — Implement prompt, steering, follow-up, Stop, FIFO acknowledgement, and run settlement. `[8h]`
- [ ] `SWFT-033` — Build approval and clarification with native buttons, fields, pickers, focus, and keyboard handling. `[8h]`
- [ ] `SWFT-034` — Implement model selection, persistence, MoA, advisor, context usage, and compaction with native menus and sheets. `[8h]`
- [ ] `SWFT-035` — Build the Activity inspector using native inspector, list, disclosure, and popover behavior. `[8h]`
- [ ] `SWFT-036` — Add native loading, unavailable, authentication, disconnect, retry, and restart recovery surfaces. `[6h]`
- [ ] `SWFT-037` — Add menu-bar commands and shortcuts for Task, Settings, sidebar, Stop, and retry. `[6h]`

Milestone exit: the native app supports the core Task journey, restoration,
streaming, tools, interactions, stop/recovery, and accessibility through a
production-shaped backend package.

### 4. Signed side-by-side alpha and CI/CD

- [ ] `SWFT-038` — Configure Hardened Runtime, entitlements, nested Node/addon signing, and Developer ID export. `[8h]`
- [ ] `SWFT-039` — Integrate Sparkle with architecture-specific HTTPS appcasts and EdDSA verification. `[8h]`
- [ ] `SWFT-040` — Add version injection, archive export, notarization, stapling, ZIP creation, and verification scripts. `[8h]`
- [ ] `SWFT-041` — Extend CI to generate, resolve, build, test, and validate RailgunX assets. `[6h]`
- [ ] `SWFT-042` — Extend publishing to release signed arm64 and x86_64 RailgunX builds beside Electron builds. `[8h]`
- [ ] `SWFT-043` — Generate signed Sparkle appcasts without changing Classic’s update channels. `[8h]`
- [ ] `SWFT-044` — Add packaged signature, Gatekeeper, notarization, backend, icon, and updater smoke checks. `[8h]`

Milestone exit: RailgunX ships as an independently updatable, signed and
notarized alpha beside Electron, with no change to Classic's artifacts or
update feeds.

### 5. Remaining Task, Files, and Scheduled parity

- [ ] `SWFT-045` — Implement archived-task browsing, unarchive, native context menus, and filtering. `[8h]`
- [ ] `SWFT-046` — Implement branch selection, summarization, fork, and authoritative reloads. `[8h]`
- [ ] `SWFT-047` — Build the home-rooted file tree using native outline/list behavior and filesystem protections. `[8h]`
- [ ] `SWFT-048` — Add native text/image preview, safe Quick Look, and Reveal in Finder. `[8h]`
- [ ] `SWFT-049` — Build Scheduled list, loading, empty, error, delete, and refresh states. `[6h]`
- [ ] `SWFT-050` — Build create/edit forms with native fields, cron validation, and schedule summaries. `[8h]`
- [ ] `SWFT-051` — Port launch-agent generation, enable, disable, repair, and status inspection to Swift. `[8h]`
- [ ] `SWFT-052` — Build Background Automation settings while retaining job definitions under Scheduled. `[6h]`

Milestone exit: remaining Task session operations, safe Files behavior,
Scheduled definitions, and background automation management match the backend
contract and Classic's supported behavior.

### 6. Settings, provider, and knowledge parity

- [ ] `SWFT-053` — Build Settings using native navigation, search, forms, sections, controls, and dirty-edit confirmation. `[8h]`
- [ ] `SWFT-054` — Implement General model, timeout, and archive-retention settings. `[6h]`
- [ ] `SWFT-055` — Implement Agent MoA/advisor settings and mutation guards. `[8h]`
- [ ] `SWFT-056` — Implement Trust approval mode and smart-review settings. `[6h]`
- [ ] `SWFT-057` — Implement provider status, sign-in/out, environment-token messaging, and recovery. `[8h]`
- [ ] `SWFT-058` — Implement redacted MCP list, editing, secret replacement, and removal. `[8h]`
- [ ] `SWFT-059` — Implement Memories list, search, create, edit, and delete. `[8h]`
- [ ] `SWFT-060` — Implement note-folder import plus keyword and semantic search. `[8h]`
- [ ] `SWFT-061` — Implement Dream progress and completion/skip results. `[6h]`
- [ ] `SWFT-062` — Implement instruction-file status, editing, shadowing, save, and discard protection. `[8h]`
- [ ] `SWFT-063` — Implement read-only skill list, detail, metadata, and Markdown presentation. `[6h]`
- [ ] `SWFT-064` — Implement bounded diagnostics, health, mock scenarios, and restart controls. `[8h]`

Milestone exit: native Settings, provider access, MCP, knowledge, instructions,
skills, and diagnostics reach functional parity without exposing secrets or raw
backend state.

### 7. Apple-quality hardening

- [ ] `SWFT-065` — Audit macOS 15 fallbacks and macOS 26 Liquid Glass usage. `[8h]`
- [ ] `SWFT-066` — Audit typography, symbols, native controls, toolbar, sidebar, menus, icon treatment, resizing, and full screen. `[8h]`
- [ ] `SWFT-067` — Complete keyboard, VoiceOver, focus, contrast, Reduce Motion, Reduce Transparency, and Increase Contrast support. `[8h]`
- [ ] `SWFT-068` — Test compact, default, wide, full-screen, and multi-display layouts. `[6h]`
- [ ] `SWFT-069` — Measure and optimize large transcripts, streaming, scrolling, Markdown, and memory use. `[8h]`
- [ ] `SWFT-070` — Test malformed transport, crashes, stale responses, restart, cancellation, authentication failure, and termination. `[8h]`
- [ ] `SWFT-071` — Review filesystem, URL, process, secret, diagnostic, update, and release security boundaries. `[8h]`
- [ ] `SWFT-072` — Run native unit, integration, UI, accessibility, packaged, arm64, and x86_64 verification. `[8h]`
- [ ] `SWFT-083` — Audit every custom component, remove unnecessary customization, consolidate duplicate variants, and document retained exceptions. `[8h]`

Milestone exit: the app meets the native quality, accessibility, performance,
recovery, security, layout, and dual-architecture acceptance contracts below.

### 8. Rename and retirement

- [ ] `SWFT-073` — Maintain a feature-parity matrix and close every replacement-blocking gap. `[5h]`
- [ ] `SWFT-074` — Run one bounded public-beta feedback and remediation cycle. `[8h]`
- [ ] `SWFT-075` — Rename Electron to **Railgun Classic** while retaining `sh.railgun.desktop`. `[6h]`
- [ ] `SWFT-076` — Rename RailgunX to **Railgun** while retaining `io.anvia.railgun` and the new icon. `[5h]`
- [ ] `SWFT-077` — Update artifacts, Sparkle presentation, documentation, links, and screenshots. `[8h]`
- [ ] `SWFT-078` — Move the Homebrew `railgun` Cask to native Railgun and optionally add a temporary Classic Cask. `[8h]`
- [ ] `SWFT-079` — Announce Classic’s support deadline and remove its release jobs afterward. `[6h]`
- [ ] `SWFT-080` — Remove Electron only after parity, shared-data verification, and the retirement window. `[8h]`

Milestone exit: native Railgun owns the stable name, bundle identity, icon,
direct distribution, and Homebrew Cask; Classic has completed its announced
support window and no longer ships.

## Test and acceptance contract

- Every behavior task adds focused tests before or alongside implementation.
- CI runs XcodeGen validation, SwiftPM resolution, builds, tests, and packaged
  verification.
- Contract fixtures are shared between TypeScript and Swift.
- Tests use temporary homes and never touch the real `~/.railgun`.
- Native components retain platform behavior without snapshotting or overriding
  system appearance.
- Every custom component has a documented justification, centralized variants,
  previews, accessibility coverage, and no feature-local duplicate.
- Icon acceptance covers generated sizes, light and dark appearance, Finder, Dock, Launchpad,
  About, notifications, and updates.
- Alpha acceptance requires core Task behavior, crash and disconnect recovery,
  signing, notarization, Sparkle updates, and production icon assets.
- Replacement acceptance requires full feature parity, accessibility and
  performance audits, arm64 and x86_64 artifacts, shared-data coexistence, and
  packaged smoke tests.

Design and review follow Apple's guidance for
[macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/),
[sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars),
[toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars),
and [materials](https://developer.apple.com/design/human-interface-guidelines/materials).

## Verification commands

Validate the existing repository and documentation from the repository root:

```sh
pnpm run typecheck
pnpm run test
pnpm --filter @dantea/railgun-desktop typecheck
pnpm --filter @dantea/railgun-desktop test
```

The native CI contract will run the checked-in equivalents of:

```sh
xcodegen generate --spec apps/macos/project.yml
xcodebuild -resolvePackageDependencies -project apps/macos/RailgunX.xcodeproj
xcodebuild build -project apps/macos/RailgunX.xcodeproj -scheme RailgunX -destination 'platform=macOS'
xcodebuild test -project apps/macos/RailgunX.xcodeproj -scheme RailgunX -destination 'platform=macOS'
```

Release verification must additionally exercise generated icon assets, nested
code signatures, Gatekeeper assessment, notarization and stapling, packaged
backend startup, SQLite loading, both architecture-specific Sparkle feeds, and
clean install/update behavior.

## Alpha and cutover criteria

### Task-focused alpha

Release RailgunX beside Electron only when:

- new, resumed, and archived Task sessions work against the packaged backend;
- streaming transcripts, Markdown, tools, approvals, clarifications, queues,
  Stop, model controls, activity, and recovery pass focused tests;
- the cross-client lock prevents RailgunX and Classic from concurrently using
  `~/.railgun` and safely recovers stale ownership;
- native keyboard, VoiceOver, focus, contrast, reduced-motion, and
  reduced-transparency behavior has been exercised;
- the production icon is correct in Finder, Dock, Launchpad, About,
  notifications, and update presentation; and
- arm64 and x86_64 builds are signed, notarized, stapled, updateable, and pass
  packaged backend smoke tests.

### Final replacement

Rename RailgunX to Railgun and begin Classic retirement only when:

- the maintained parity matrix has no replacement-blocking gaps across Task,
  Files, Scheduled, Settings, providers, MCP, knowledge, automation, and
  diagnostics;
- macOS 15 fallbacks and macOS 26 enhancements pass the quality audits;
- accessibility, performance, malformed-input, crash, cancellation,
  authentication, filesystem, update, and release security checks pass;
- side-by-side installation and shared-data exclusion have been verified on
  supported upgrades without migration or data loss;
- both architecture-specific direct artifacts pass clean install and update
  smoke tests;
- a bounded public beta and remediation cycle is complete; and
- the Railgun Classic support deadline and Homebrew transition are published.

Electron may be removed only after the announced retirement window ends. The
native application retains `io.anvia.railgun` and its native icon throughout
the rename; Classic retains `sh.railgun.desktop` for its remaining lifetime.
