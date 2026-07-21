import CryptoKit
import XCTest
import RailgunCore
import RailgunServices
import RailgunTestSupport
import RailgunTransport
import RailgunUI
@testable import RailgunX

@MainActor
final class RailgunXAppTests: XCTestCase {
    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    func testModuleBoundariesCompile() {}

    func testPrimaryWindowUsesProductName() {
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration.primaryWindowTitle, "RailgunX")
    }

    func testTaskShellDefaultsTheActivityCardToHidden() {
        XCTAssertFalse(RailgunTaskShell.activityCardDefaultVisibility)
    }

    func testTaskShellUsesANativeMinimumSidebarWidth() {
        XCTAssertEqual(RailgunTaskShell.sidebarMinimumWidth, 180)
    }

    func testProjectSourceSupportsBothGeneratedPackageHeaderLayouts() throws {
        let project = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/project.yml"),
            encoding: .utf8
        )

        XCTAssertTrue(project.contains("$(PROJECT_DIR)/../SourcePackages/checkouts/swift-markdown"))
        XCTAssertTrue(project.contains("$(PROJECT_DIR)/../SourcePackages/checkouts/swift-cmark"))
        XCTAssertTrue(project.contains("$(BUILD_DIR)/../../SourcePackages/checkouts/swift-markdown"))
        XCTAssertTrue(project.contains("$(BUILD_DIR)/../../SourcePackages/checkouts/swift-cmark"))
    }

    func testTaskCommandAvailabilityKeepsUnavailableActionsDisabled() {
        XCTAssertEqual(
            RailgunTaskCommandAvailability(canCreateTask: false, canStop: false),
            .init(canCreateTask: false, canStop: false)
        )
        XCTAssertNotEqual(
            RailgunTaskCommandAvailability(canCreateTask: false, canStop: false),
            .init(canCreateTask: true, canStop: false)
        )
    }

    func testTaskCommandsUseNativeSceneRoutingAndKeyboardShortcuts() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunTaskCommands.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("CommandGroup(replacing: .newItem)"))
        XCTAssertTrue(source.contains(".keyboardShortcut(\"n\", modifiers: .command)"))
        XCTAssertTrue(source.contains(".keyboardShortcut(\"1\", modifiers: .command)"))
        XCTAssertTrue(source.contains("@Environment(\\.openSettings)"))
        XCTAssertTrue(source.contains("openWindow(id:"))
        XCTAssertTrue(source.contains("Button(\"Stop\""))
        XCTAssertTrue(source.contains("taskActions?.stop()"))
        XCTAssertTrue(source.contains(".disabled(taskActions?.availability.canStop != true)"))

        let appSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appSource.contains("SidebarCommands()"))
    }

    func testActivityUsesAFloatingGlassPanelAlongsideTheTranscript() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let activitySource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunActivityPresentation.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("RailgunActivityPanel("))
        XCTAssertTrue(source.contains(".contentMargins(\n            .leading,"))
        XCTAssertTrue(source.contains("content.glassEffect("))
        XCTAssertFalse(source.contains(".inspector(isPresented:"))
        XCTAssertTrue(activitySource.contains(".scrollContentBackground(.hidden)"))
    }

    func testActivityPanelPresentationUsesStableDetailWidth() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("@State private var detailViewportWidth: CGFloat = 0"))
        XCTAssertTrue(source.contains("GeometryReader { geometry in"))
        XCTAssertTrue(source.contains("detailViewportWidth = geometry.size.width"))
        XCTAssertFalse(source.contains("transcriptViewportWidth = geometry.viewportWidth"))
    }

    func testActivityPanelUsesCompactMapsLikeDimensions() {
        XCTAssertEqual(RailgunTaskShell.activityPanelPreferredWidth, 320)
        XCTAssertEqual(RailgunTaskShell.activityPanelReservedWidth, 376)
        XCTAssertEqual(RailgunTaskShell.activityPopoverHeight, 360)
    }

    func testTranscriptUsesComfortableExpandedMessageSpacing() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(
            source.contains("LazyVStack(alignment: .center, spacing: RailgunSpacing.expanded.points)")
        )
    }

    func testDesktopDocumentationCapturesActivityAndTranscriptLayoutContracts() throws {
        let readme = try String(
            contentsOf: repositoryRoot.appendingPathComponent("README.md"),
            encoding: .utf8
        )
        let nativeUIPolicy = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/native-ui-policy.md"),
            encoding: .utf8
        )

        XCTAssertTrue(readme.contains("4, 8, 12, 16, 24, and 32 point scale"))
        XCTAssertTrue(readme.contains("32-point inter-message gap"))
        XCTAssertTrue(readme.contains("376 points beside the transcript"))
        XCTAssertTrue(nativeUIPolicy.contains("## Activity panel layout invariant"))
        XCTAssertTrue(nativeUIPolicy.contains("stable detail viewport measurement"))
        XCTAssertTrue(nativeUIPolicy.contains(".scrollContentBackground(.hidden)"))
    }

    func testNativeComposerPolicyDocumentsItsAppKitAndSubmissionBoundaries() throws {
        let design = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/DESIGN.md"),
            encoding: .utf8
        )
        let nativeUIPolicy = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/native-ui-policy.md"),
            encoding: .utf8
        )

        XCTAssertTrue(design.contains("Native macOS composer"))
        XCTAssertTrue(design.contains("one through ten visual lines"))
        XCTAssertTrue(nativeUIPolicy.contains("### `RailgunComposer`"))
        XCTAssertTrue(nativeUIPolicy.contains("accessible name `Message`"))
        XCTAssertTrue(nativeUIPolicy.contains("SWFT-032"))
    }

    func testTaskComposerUsesTheSharedProductSurfaceHierarchy() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("task-composer-surface"))
        XCTAssertTrue(source.contains("Message Railgun…"))
        XCTAssertTrue(source.contains("task-composer-send"))
        XCTAssertTrue(source.contains("task-composer-stop"))
        XCTAssertTrue(source.contains("Image(systemName: \"stop.fill\")"))
        XCTAssertTrue(source.contains(".accessibilityLabel(\"Stop\")"))
        XCTAssertTrue(source.contains("composerKeyboardHint"))
        XCTAssertTrue(source.contains("composerActionRow"))
        XCTAssertTrue(source.contains("canRetryComposerSubmission"))
        XCTAssertEqual(RailgunTaskShell.composerMaximumWidth, 736)
    }

    func testComposerRetryPrioritizesAnExplicitFailedStopOverQueueRetry() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("if isStopFailure {\n            requestStop()"))
        XCTAssertTrue(source.contains("appStore.state.transcript.failedStopMessage != nil"))
    }

    func testActivityVisibilityUsesOnlyTheToolbarToggle() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("accessibilityIdentifier(\"toggle-activity\")"))
        XCTAssertFalse(source.contains("close-activity"))
        XCTAssertFalse(source.contains("dismiss: { isActivityCardVisible"))
    }

    func testSettingsUsesExplicitInterfaceTypographyWithoutANativeListReset() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("RailgunArchivedTaskRow"))
        XCTAssertFalse(source.contains("List(tasks)"))
        XCTAssertTrue(source.contains("Text(\"Restore\").font(RailgunFont.interface(.body, weight: .semibold))"))
    }

    func testTranscriptSoftEdgePreservesTheNativeScrollerContract() throws {
        let sourceDirectory = repositoryRoot
            .appendingPathComponent("apps/macos/Sources/RailgunX")
        let sourceFiles = [
            "RailgunXApp.swift",
            "RailgunTranscriptViewport.swift",
        ]
        let transcriptSource = try sourceFiles
            .map {
                try String(
                    contentsOf: sourceDirectory.appendingPathComponent($0),
                    encoding: .utf8
                )
            }
            .joined(separator: "\n")

        XCTAssertTrue(
            transcriptSource.contains("scrollEdgeEffectStyle(.soft, for: .top)"),
            "The transcript must retain its native macOS 26 soft top-edge effect."
        )

        let forbiddenScrollerOverrides = [
            "showsIndicators: false",
            ".scrollIndicators(.hidden)",
            "hasVerticalScroller = false",
            "verticalScroller?.isHidden = true",
            "RailgunSystemScrollIndicatorSuppressor",
        ]

        for forbiddenOverride in forbiddenScrollerOverrides {
            XCTAssertFalse(
                transcriptSource.contains(forbiddenOverride),
                "The transcript soft edge requires the native scroller; remove \(forbiddenOverride)."
            )
        }
    }

    func testArchiveToolbarActionRequiresAPersistedSelectedSession() {
        let persisted = RailgunSessionSummary(
            id: "selected",
            model: "gpt-5",
            startedAt: "Today",
            messageCount: 1,
            firstUserPreview: "Archive this"
        )
        let unsaved = RailgunSessionSummary(
            id: "unsaved",
            model: "gpt-5",
            startedAt: "Today",
            messageCount: 0,
            firstUserPreview: "",
            isPersisted: false
        )

        XCTAssertTrue(RailgunTaskShell.isArchiveActionDisabled(for: .initial))
        XCTAssertFalse(RailgunTaskShell.isArchiveActionDisabled(for: .init(
            activeSessionID: persisted.id,
            sessions: [persisted],
            archivedSessions: [],
            isLoading: false
        )))
        XCTAssertTrue(RailgunTaskShell.isArchiveActionDisabled(for: .init(
            activeSessionID: unsaved.id,
            sessions: [],
            archivedSessions: [],
            isLoading: false,
            activeSession: unsaved
        )))
    }

    func testSettingsPresentsArchivedTasksForRestoration() {
        let archived = RailgunSessionSummary(
            id: "archived",
            model: "gpt-5",
            startedAt: "Yesterday",
            messageCount: 3,
            firstUserPreview: "Restore this"
        )

        XCTAssertEqual(
            RailgunArchivedTasksSettingsPresentation(session: .initial),
            .empty
        )
        XCTAssertEqual(
            RailgunArchivedTasksSettingsPresentation(session: .init(
                activeSessionID: nil,
                sessions: [],
                archivedSessions: [archived],
                isLoading: false
            )),
            .tasks([archived])
        )
    }

    func testAppUsesThePrimaryLifecycleConfiguration() {
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration, .primary)
    }

    func testPrimaryWindowAndSettingsUseTheSharedMatchaTintAndSidebarSelection() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let sharedTint = ".tint(RailgunColorRole.accent.color)"

        XCTAssertEqual(
            source.components(separatedBy: sharedTint).count - 1,
            2,
            "Both the primary window and Settings scene must inherit the shared matcha tint."
        )
        XCTAssertTrue(source.contains("RailgunSidebarSessionRow"))
        XCTAssertTrue(source.contains("isSelected ? RailgunColorRole.accent.color : .clear"))
        XCTAssertFalse(source.contains("List(selection: selection)"))
    }

    func testDesktopClientLockCreatesAndReleasesTheSharedLockRecord() async throws {
        let home = try temporaryRailgunHome()
        let lock = DesktopClientLock(
            directory: home.railgunDirectory,
            identity: .railgunX,
            processID: ProcessInfo.processInfo.processIdentifier,
            startTime: "2026-07-18T12:00:00Z"
        )

        let record = try await lock.acquire()

        XCTAssertEqual(record.pid, ProcessInfo.processInfo.processIdentifier)
        XCTAssertEqual(record.bundleID, "io.anvia.railgun")
        XCTAssertEqual(record.clientName, "RailgunX")
        XCTAssertEqual(record.startTime, "2026-07-18T12:00:00Z")
        XCTAssertTrue(FileManager.default.fileExists(atPath: lock.fileURL.path))

        await lock.release()
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.fileURL.path))
    }

    func testDesktopClientLockRecoversOnlyAStaleValidRecord() async throws {
        let home = try temporaryRailgunHome()
        let lock = DesktopClientLock(
            directory: home.railgunDirectory,
            identity: .railgunX,
            processID: ProcessInfo.processInfo.processIdentifier,
            startTime: "2026-07-18T12:00:00Z",
            isProcessLive: { $0 == ProcessInfo.processInfo.processIdentifier }
        )
        let staleRecord = DesktopClientLockRecord(
            pid: 99_999,
            bundleID: "sh.railgun.desktop",
            clientName: "Railgun Classic",
            startTime: "2026-07-18T11:00:00Z"
        )
        try staleRecord.encodedData().write(to: lock.fileURL)
        try staleRecord.encodedData().write(
            to: home.railgunDirectory.appendingPathComponent("desktop-client.lock.recovery")
        )

        let record = try await lock.acquire()

        XCTAssertEqual(record.clientName, "RailgunX")
        XCTAssertEqual(try DesktopClientLockRecord(data: Data(contentsOf: lock.fileURL)), record)
        await lock.release()
    }

    func testDesktopClientLockRejectsLiveAndMalformedRecordsWithoutDeletingThem() async throws {
        let home = try temporaryRailgunHome()
        let lock = DesktopClientLock(
            directory: home.railgunDirectory,
            identity: .railgunX,
            processID: ProcessInfo.processInfo.processIdentifier,
            startTime: "2026-07-18T12:00:00Z",
            isProcessLive: { $0 == 4242 }
        )
        let liveRecord = DesktopClientLockRecord(
            pid: 4242,
            bundleID: "sh.railgun.desktop",
            clientName: "Railgun Classic",
            startTime: "2026-07-18T11:00:00Z"
        )
        try liveRecord.encodedData().write(to: lock.fileURL)

        do {
            _ = try await lock.acquire()
            XCTFail("Expected the live Classic lock to block RailgunX")
        } catch let error as DesktopClientLockError {
            XCTAssertEqual(error, .conflict(liveRecord))
        }
        XCTAssertEqual(try DesktopClientLockRecord(data: Data(contentsOf: lock.fileURL)), liveRecord)

        try Data("not JSON".utf8).write(to: lock.fileURL)
        do {
            _ = try await lock.acquire()
            XCTFail("Expected an unreadable lock to remain in place")
        } catch let error as DesktopClientLockError {
            XCTAssertEqual(error, .invalidExistingLock)
        }
        XCTAssertEqual(try Data(contentsOf: lock.fileURL), Data("not JSON".utf8))
    }

    func testDesktopClientLockNeverRemovesAReplacementWhenReleasing() async throws {
        let home = try temporaryRailgunHome()
        let lock = DesktopClientLock(
            directory: home.railgunDirectory,
            identity: .railgunX,
            processID: ProcessInfo.processInfo.processIdentifier,
            startTime: "2026-07-18T12:00:00Z"
        )
        let replacement = DesktopClientLockRecord(
            pid: 4242,
            bundleID: "sh.railgun.desktop",
            clientName: "Railgun Classic",
            startTime: "2026-07-18T12:01:00Z"
        )
        _ = try await lock.acquire()
        try replacement.encodedData().write(to: lock.fileURL)

        await lock.release()

        XCTAssertEqual(try DesktopClientLockRecord(data: Data(contentsOf: lock.fileURL)), replacement)
    }

    func testPrimaryWindowLifecycleConfiguration() {
        let configuration = AppLifecycleConfiguration.primary

        XCTAssertEqual(configuration.primaryWindowTitle, "RailgunX")
        XCTAssertEqual(configuration.primaryWindowRestorationIdentifier, "primary")
        XCTAssertEqual(configuration.primaryWindowDefaultSize, CGSize(width: 1_024, height: 700))
        XCTAssertEqual(configuration.primaryWindowMinimumSize, CGSize(width: 760, height: 520))
        XCTAssertEqual(configuration.primaryWindowResizability, .contentMinimumSize)
    }

    func testBackendLaunchConfigurationDefaultsUnknownAndMissingModesToBundled() {
        XCTAssertEqual(BackendLaunchConfiguration(environment: [:], arguments: []).mode, .bundled)
        XCTAssertEqual(
            BackendLaunchConfiguration(environment: ["RAILGUNX_BACKEND_MODE": "unexpected"], arguments: []).mode,
            .bundled
        )
        XCTAssertEqual(
            BackendLaunchConfiguration(
                environment: ["RAILGUNX_BACKEND_MODE": "mock"],
                arguments: ["RailgunX", "--railgunx-backend-mode=unexpected"]
            ).mode,
            .bundled
        )
    }

    func testBackendLaunchArgumentsTakePrecedenceOverEnvironment() {
        let configuration = BackendLaunchConfiguration(
            environment: ["RAILGUNX_BACKEND_MODE": "mock"],
            arguments: ["RailgunX", "--railgunx-backend-mode=source"]
        )

        XCTAssertEqual(configuration.mode, .source)
        XCTAssertNil(configuration.mockScenario)
    }

    func testSourceBackendResolvesTheGeneratedRepositoryRootMarker() throws {
        let markerDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgunx-source-root-marker-\(UUID().uuidString)", isDirectory: true)
        let marker = markerDirectory.appendingPathComponent(".railgun-source-root")
        defer { try? FileManager.default.removeItem(at: markerDirectory) }

        try FileManager.default.createDirectory(at: markerDirectory, withIntermediateDirectories: true)
        try "\(repositoryRoot.path)\n".write(to: marker, atomically: true, encoding: .utf8)

        let configuration = BackendLaunchConfiguration(
            environment: [
                "RAILGUNX_BACKEND_MODE": "mock",
                "RAILGUNX_SOURCE_ROOT": "/"
            ],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=source",
                "--railgunx-source-root=\(marker.path)"
            ]
        )

        XCTAssertEqual(configuration.mode, .source)
        XCTAssertEqual(configuration.sourceRoot, repositoryRoot.standardizedFileURL)
    }

    func testMockBackendUsesReadyIdleByDefaultAndAcceptsLaunchMetadata() {
        let defaultConfiguration = BackendLaunchConfiguration(
            environment: [
                "RAILGUNX_BACKEND_MODE": "mock",
                "RAILGUNX_MOCK_SCENARIO": "   "
            ],
            arguments: []
        )
        let launchConfiguration = BackendLaunchConfiguration(
            environment: ["RAILGUNX_MOCK_SCENARIO": "ignored-by-argument"],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=mock",
                "--railgunx-mock-scenario=ready-idle"
            ]
        )

        XCTAssertEqual(defaultConfiguration.mode, .mock)
        XCTAssertEqual(defaultConfiguration.mockScenario, BackendLaunchConfiguration.defaultMockScenario)
        XCTAssertEqual(launchConfiguration.mockScenario, "ready-idle")
    }

    func testMockBackendLaunchUsesTheBuiltSourceMockWithTheRequestedScenario() throws {
        let configuration = BackendLaunchConfiguration(
            environment: [:],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=mock",
                "--railgunx-mock-scenario=ready-idle",
                "--railgunx-source-root=\(repositoryRoot.path)",
            ]
        )

        let launch = try XCTUnwrap(configuration.desktopRPCLaunch(resourcesDirectory: repositoryRoot))

        XCTAssertEqual(launch.executableURL.path, "/usr/bin/env")
        XCTAssertEqual(
            launch.arguments,
            ["node", repositoryRoot.appendingPathComponent("apps/desktop/backend/mock-backend.cjs").path, "ready-idle"]
        )
        XCTAssertEqual(launch.currentDirectoryURL, repositoryRoot.standardizedFileURL)
        XCTAssertEqual(launch.environment?["RAILGUN_DESKTOP_RPC"], "1")
    }

    func testMockBackendLaunchPrefersTheBundledNodeRuntime() throws {
        let resourcesDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgunx-bundled-node-\(UUID().uuidString)", isDirectory: true)
        let bundledNode = resourcesDirectory.appendingPathComponent("backend/node/bin/node")
        defer { try? FileManager.default.removeItem(at: resourcesDirectory) }

        try FileManager.default.createDirectory(
            at: bundledNode.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        XCTAssertTrue(FileManager.default.createFile(atPath: bundledNode.path, contents: Data()))
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: bundledNode.path
        )

        let configuration = BackendLaunchConfiguration(
            environment: [:],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=mock",
                "--railgunx-mock-scenario=ready-idle",
                "--railgunx-source-root=\(repositoryRoot.path)",
            ]
        )

        let launch = try XCTUnwrap(configuration.desktopRPCLaunch(resourcesDirectory: resourcesDirectory))

        XCTAssertEqual(launch.executableURL, bundledNode)
        XCTAssertEqual(
            launch.arguments,
            [
                repositoryRoot.appendingPathComponent("apps/desktop/backend/mock-backend.cjs").path,
                "ready-idle",
            ]
        )
    }

    func testMockRuntimeStartsAndLoadsSavedSessions() async {
        let configuration = BackendLaunchConfiguration(
            environment: [:],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=mock",
                "--railgunx-mock-scenario=ready-idle",
                "--railgunx-source-root=\(repositoryRoot.path)",
            ]
        )
        let store = RailgunAppStore()
        let runtime = RailgunBackendRuntime(configuration: configuration, store: store)

        await runtime.start()

        XCTAssertEqual(store.state.backend.phase, .ready)
        XCTAssertEqual(store.state.session.sessions.first?.id, "mock-session-complex-task")
        XCTAssertTrue(store.state.session.archivedSessions.isEmpty)

        await runtime.shutdown()
    }

    func testPersistedSessionEventRefreshesTheSidebarTasks() async {
        let configuration = BackendLaunchConfiguration(
            environment: [:],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=mock",
                "--railgunx-mock-scenario=ready-idle",
                "--railgunx-source-root=\(repositoryRoot.path)",
            ]
        )
        let store = RailgunAppStore()
        let runtime = RailgunBackendRuntime(configuration: configuration, store: store)

        await runtime.start()
        store.send(.session(.loaded([])))

        await runtime.handle(.sessionSaved)

        XCTAssertEqual(
            store.state.session.sessions.map(\.id),
            ["mock-session-complex-task", "mock-session-rich-history", "mock-session-recent", "mock-session-older"]
        )
        await runtime.shutdown()
    }

    func testMockRuntimeMarksTheBackendDisconnectedAfterPostStartupTermination() async {
        let configuration = BackendLaunchConfiguration(
            environment: [:],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=mock",
                "--railgunx-mock-scenario=disconnect-after-ready",
                "--railgunx-source-root=\(repositoryRoot.path)",
            ]
        )
        let store = RailgunAppStore()
        let runtime = RailgunBackendRuntime(configuration: configuration, store: store)

        await runtime.start()
        try? await Task.sleep(for: .milliseconds(250))

        XCTAssertEqual(store.state.backend.phase, .disconnected("The connection to the backend was lost."))

        await runtime.shutdown()
    }

    func testBackendPresentationOnlyShowsTheTaskShellWhenReady() {
        XCTAssertEqual(RailgunBackendPresentation(phase: .starting), .starting)
        XCTAssertEqual(RailgunBackendPresentation(phase: .ready), .ready)
        XCTAssertEqual(
            RailgunBackendPresentation(phase: .authenticationRequired),
            .authenticationRequired
        )
        XCTAssertEqual(
            RailgunBackendPresentation(phase: .failed("Launch failed")),
            .unavailable(title: "Backend Unavailable", message: "Launch failed")
        )
        XCTAssertEqual(
            RailgunBackendPresentation(phase: .disconnected("Connection lost")),
            .unavailable(title: "Backend Disconnected", message: "Connection lost")
        )
    }

    func testShellLaunchersForwardExplicitBackendArgumentsThroughLaunchServices() throws {
        let runScript = try String(
            contentsOf: repositoryRoot.appendingPathComponent("scripts/run.sh"),
            encoding: .utf8
        )
        let runMockScript = try String(
            contentsOf: repositoryRoot.appendingPathComponent("scripts/run-mock.sh"),
            encoding: .utf8
        )
        let runSourceScript = try String(
            contentsOf: repositoryRoot.appendingPathComponent("scripts/run-source.sh"),
            encoding: .utf8
        )

        XCTAssertTrue(runScript.contains("open -n -W \"$app_bundle\""))
        XCTAssertTrue(runScript.contains("--railgunx-backend-mode=source"))
        XCTAssertTrue(runScript.contains("--railgunx-backend-mode=mock"))
        XCTAssertTrue(runScript.contains("--railgunx-mock-scenario=$mock_scenario"))
        XCTAssertTrue(runScript.contains("--railgunx-source-root=$source_root"))
        XCTAssertFalse(runScript.contains("RAILGUNX_BACKEND_MODE"))
        XCTAssertFalse(runMockScript.contains("export RAILGUNX_BACKEND_MODE"))
        XCTAssertTrue(runMockScript.contains("--mock-scenario ready-idle"))
        XCTAssertTrue(runMockScript.contains("--source-root \"$repository_root\""))
        XCTAssertTrue(runSourceScript.contains("--backend-mode source"))
        XCTAssertTrue(runSourceScript.contains("--source-root \"$repository_root\""))
    }

    func testNativeBackendStagingContractUsesTheTargetArchitectureAndAtomicPayload() throws {
        let stagingScriptURL = repositoryRoot.appendingPathComponent("apps/macos/scripts/stage-backend.sh")
        let validationScriptURL = repositoryRoot.appendingPathComponent("apps/macos/scripts/validate-backend.sh")
        let lifecycleValidationScriptURL = repositoryRoot.appendingPathComponent(
            "apps/macos/scripts/validate-packaged-backend-lifecycle.mjs"
        )
        let projectURL = repositoryRoot.appendingPathComponent("apps/macos/project.yml")
        let stagingScript = try String(contentsOf: stagingScriptURL, encoding: .utf8)
        let validationScript = try String(contentsOf: validationScriptURL, encoding: .utf8)
        let lifecycleValidationScript = try String(contentsOf: lifecycleValidationScriptURL, encoding: .utf8)
        let project = try String(contentsOf: projectURL, encoding: .utf8)

        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: stagingScriptURL.path))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: validationScriptURL.path))
        XCTAssertTrue(stagingScript.contains("PATH=\"$staged_node_root/bin:$PATH\""))
        XCTAssertTrue(stagingScript.contains("corepack \"pnpm@$pinned_pnpm_version\""))
        XCTAssertTrue(stagingScript.contains("\"${pinned_pnpm[@]}\" --dir \"$repository_root\""))
        XCTAssertTrue(stagingScript.contains("node_gyp_script=\"$repository_root/node_modules/node-gyp/bin/node-gyp.js\""))
        XCTAssertTrue(stagingScript.contains("npm_config_build_from_source=true"))
        XCTAssertTrue(stagingScript.contains("--nodedir=\"$staged_node_root\""))
        XCTAssertTrue(stagingScript.contains("rm -rf \"$deployed_railgun/node_modules/@types\""))
        XCTAssertTrue(stagingScript.contains("sqlite-vec-darwin-$darwin_arch/vec0.dylib"))
        XCTAssertTrue(stagingScript.contains("mv \"$staging_backend\" \"$output/backend\""))
        XCTAssertTrue(validationScript.contains("for architecture in arm64 x86_64"))
        XCTAssertTrue(validationScript.contains("better-sqlite3"))
        XCTAssertTrue(validationScript.contains("sqliteVec.load(database)"))
        XCTAssertTrue(validationScript.contains("validate-packaged-backend-lifecycle.mjs"))
        XCTAssertTrue(lifecycleValidationScript.contains("authentication_required"))
        XCTAssertTrue(lifecycleValidationScript.contains("SIGKILL"))
        XCTAssertTrue(lifecycleValidationScript.contains("stdin.end()"))
        XCTAssertTrue(lifecycleValidationScript.contains("initialize"))
        XCTAssertTrue(lifecycleValidationScript.contains("get_state"))
        XCTAssertTrue(project.contains("preBuildScripts:"))
        XCTAssertTrue(project.contains("architecture=\"${CURRENT_ARCH:-}\""))
        XCTAssertTrue(project.contains("--architecture \"$architecture\""))
        XCTAssertTrue(project.contains("UNLOCALIZED_RESOURCES_FOLDER_PATH"))
    }

    func testLegalNoticesAreBundledWithTheApplication() throws {
        XCTAssertNotNil(LegalNotices.noticesURL)
        XCTAssertNotNil(LegalNotices.manifestURL)

        let manifest = try LegalNotices.loadManifest()
        XCTAssertFalse(manifest.components.isEmpty)
    }

    func testLegalNoticeManifestRecordsLockedSwiftPackagesAndRequiredFirstPartyMaterial() throws {
        let manifest = try LegalNotices.loadManifest()
        let records = Dictionary(uniqueKeysWithValues: manifest.components.map { ($0.identifier, $0) })

        XCTAssertEqual(records["swift-markdown"]?.version, "0.8.0")
        XCTAssertEqual(records["swift-markdown"]?.revision, "3c6f9523da3a1ec2fd829673e472d95b8097a3b8")
        XCTAssertEqual(records["swift-cmark"]?.version, "0.8.0")
        XCTAssertEqual(records["swift-cmark"]?.revision, "924936d0427cb25a61169739a7660230bffa6ea6")
        XCTAssertEqual(records["sparkle"]?.version, "2.9.4")
        XCTAssertEqual(records["sparkle"]?.revision, "b6496a74a087257ef5e6da1c5b29a447a60f5bd7")
        XCTAssertEqual(records["barlow"]?.version, "1.208")
        XCTAssertEqual(records["barlow"]?.license, "OFL-1.1")
        XCTAssertEqual(records["departure-mono-nerd-font"]?.version, "1.422 / Nerd Fonts 3.4.0")
        XCTAssertEqual(records["departure-mono-nerd-font"]?.license, "OFL-1.1")

        XCTAssertEqual(records["nodejs-24-lts"]?.version, "24.18.0")
        XCTAssertEqual(
            records["nodejs-24-lts"]?.archive,
            "node-v24.18.0-darwin-arm64.tar.xz; node-v24.18.0-darwin-x64.tar.xz"
        )
        XCTAssertEqual(records["railgun-icon-artwork"]?.copyright, "© 2026 Dante Teo")
        XCTAssertEqual(records["railgun"]?.license, "MIT")
    }

    func testLegalNoticeManifestContainsOnlyProductionBackendClosureWithBothMacOSNativeVariants() throws {
        let manifest = try LegalNotices.loadManifest()
        let backendRecords = manifest.components.filter { $0.kind == .backendProductionPackage }
        let backendNames = Set(backendRecords.map(\.name))

        XCTAssertFalse(backendRecords.isEmpty)
        XCTAssertFalse(backendNames.contains("tsx"))
        XCTAssertFalse(backendNames.contains("typescript"))
        XCTAssertFalse(backendNames.contains("vitest"))
        XCTAssertFalse(backendNames.contains("@types/better-sqlite3"))
        XCTAssertTrue(backendNames.contains("sqlite-vec-darwin-arm64"))
        XCTAssertTrue(backendNames.contains("sqlite-vec-darwin-x64"))
        XCTAssertTrue(backendRecords.allSatisfy { !$0.noticeContentSHA256.isEmpty })
    }

    func testLegalNoticeManifestTracksTheCheckedInBackendLockfileAndIncludesFullLGPLTerms() throws {
        let manifest = try LegalNotices.loadManifest()
        let lockfile = try Data(contentsOf: repositoryRoot.appendingPathComponent("pnpm-lock.yaml"))
        let notices = try String(contentsOf: try XCTUnwrap(LegalNotices.noticesURL), encoding: .utf8)

        XCTAssertEqual(manifest.backendLockfileSHA256, SHA256.hash(data: lockfile).hexString)
        XCTAssertTrue(notices.contains("GNU LESSER GENERAL PUBLIC LICENSE"))
    }

    func testLegalNoticeValidatorAcceptsTheCheckedInCatalogWithoutInstalledPackages() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "node",
            "apps/macos/scripts/generate-legal-notices.mjs",
            "--check"
        ]
        process.currentDirectoryURL = repositoryRoot
        let inheritedEnvironment = ProcessInfo.processInfo.environment
        let nodeSearchPath = [
            inheritedEnvironment["PATH"],
            "/opt/homebrew/bin",
            "/usr/local/bin"
        ]
        .compactMap { $0 }
        .joined(separator: ":")
        process.environment = inheritedEnvironment.merging(
            [
                "PATH": nodeSearchPath,
                "RAILGUN_LEGAL_SKIP_INSTALLED_PACKAGES": "1"
            ],
            uniquingKeysWith: { _, replacement in replacement }
        )

        try process.run()
        process.waitUntilExit()

        XCTAssertEqual(process.terminationStatus, 0)
    }
}

private extension Digest {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
