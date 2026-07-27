import CryptoKit
import AppKit
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
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration.primaryWindowTitle, "Railgun")
    }

    func testTaskShellUsesANativeMinimumSidebarWidth() {
        XCTAssertEqual(RailgunTaskShell.sidebarMinimumWidth, 180)
    }

    func testTaskShellKeepsFilesInspectorSeparateFromTheMainPane() {
        XCTAssertEqual(RailgunTaskShell.filesInspectorMinimumWidth, 280)
        XCTAssertEqual(RailgunTaskShell.filesInspectorPreferredWidth, 320)
        XCTAssertEqual(RailgunTaskShell.filesInspectorMinimumWindowWidth, 1_024)
    }

    func testTaskShellKeepsScheduledAndTaskWorkspacesSeparated() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("if appStore.state.destination == .scheduled"))
        XCTAssertTrue(source.contains("RailgunScheduledWorkspace("))
        XCTAssertTrue(source.contains("transcriptScrollView"))
        XCTAssertTrue(source.contains("ToolbarItemGroup(placement: .navigation)"))
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
            RailgunTaskCommandAvailability(canCreateTask: false, canStop: false, canRetry: false),
            .init(canCreateTask: false, canStop: false, canRetry: false)
        )
        XCTAssertNotEqual(
            RailgunTaskCommandAvailability(canCreateTask: false, canStop: false, canRetry: false),
            .init(canCreateTask: true, canStop: false, canRetry: false)
        )
    }

    func testNewTaskAvailabilityRespectsTheCompactionLock() {
        var controls = RailgunControlsState.initial
        controls.compactionStatus = .inProgress

        XCTAssertFalse(RailgunTaskShell.canCreateTask(session: .initial, controls: controls))
        XCTAssertTrue(RailgunTaskShell.canCreateTask(session: .initial, controls: .initial))
        XCTAssertFalse(RailgunTaskShell.canCreateTask(
            session: .initial,
            controls: .initial,
            isSessionMutationInFlight: true
        ))
    }

    func testManualCompactionRequiresReadyIdleControlsAndTranscriptHistory() {
        var controls = RailgunControlsState.initial
        controls.isLoaded = true
        controls.compactionStatus = .completed

        XCTAssertFalse(RailgunTaskShell.isCompactionDisabled(
            controls,
            isRunActive: false,
            hasTranscript: true
        ))
        XCTAssertTrue(RailgunTaskShell.isCompactionDisabled(
            controls,
            isRunActive: true,
            hasTranscript: true
        ))
        XCTAssertTrue(RailgunTaskShell.isCompactionDisabled(
            controls,
            isRunActive: false,
            hasTranscript: false
        ))
    }

    func testRetryCommandAvailabilityPrefersExplicitRecoveryTargets() {
        XCTAssertFalse(
            RailgunTaskShell.canRetryComposerSubmission(
                transcript: .initial,
                isComposerEnabled: true
            )
        )

        var failedPrompt = RailgunTranscriptState.initial
        failedPrompt = RailgunTranscriptReducer.reduce(
            failedPrompt,
            .submit(id: "prompt", text: "Retry this", at: 0)
        )
        failedPrompt = RailgunTranscriptReducer.reduce(
            failedPrompt,
            .requestFailed(userID: "prompt", text: "Retry this", message: "Unavailable")
        )
        XCTAssertTrue(
            RailgunTaskShell.canRetryComposerSubmission(
                transcript: failedPrompt,
                isComposerEnabled: true
            )
        )

        var failedQueue = RailgunTranscriptState.initial
        failedQueue = RailgunTranscriptReducer.reduce(
            failedQueue,
            .queueRejected(kind: .followUp, text: "Continue", message: "Unavailable")
        )
        XCTAssertTrue(
            RailgunTaskShell.canRetryComposerSubmission(
                transcript: failedQueue,
                isComposerEnabled: true
            )
        )
        XCTAssertFalse(
            RailgunTaskShell.canRetryComposerSubmission(
                transcript: failedQueue,
                isComposerEnabled: false
            )
        )

        var staleStopFailure = RailgunTranscriptState.initial
        staleStopFailure.failedStopMessage = "Retry stop"
        XCTAssertFalse(
            RailgunTaskShell.canRetryComposerSubmission(
                transcript: staleStopFailure,
                isComposerEnabled: true
            )
        )

        var retryableStopFailure = staleStopFailure
        retryableStopFailure.isRunning = true
        XCTAssertTrue(
            RailgunTaskShell.canRetryComposerSubmission(
                transcript: retryableStopFailure,
                isComposerEnabled: true
            )
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
        XCTAssertFalse(source.contains("@Environment(\\.openSettings)"))
        XCTAssertFalse(source.contains("CommandGroup(replacing: .appSettings)"))
        XCTAssertTrue(source.contains("openWindow(id:"))
        XCTAssertTrue(source.contains("Button(\"Stop\""))
        XCTAssertTrue(source.contains("taskActions?.stop()"))
        XCTAssertTrue(source.contains(".disabled(taskActions?.availability.canStop != true)"))
        XCTAssertTrue(source.contains("Button(\"Retry\")"))
        XCTAssertTrue(source.contains(".keyboardShortcut(\"r\", modifiers: .command)"))
        XCTAssertTrue(source.contains("taskActions?.retry()"))
        XCTAssertTrue(source.contains(".disabled(taskActions?.availability.canRetry != true)"))

        let appSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appSource.contains("SidebarCommands()"))
    }

    func testBranchingUsesANativeModalWithSummaryCancellationAndInFlightLocking() throws {
        let appSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let transcriptSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunTranscriptViewport.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(transcriptSource.contains("Button(\"Branch from this message\")"))
        XCTAssertTrue(appSource.contains(".sheet(isPresented: isBranchSheetPresented)"))
        XCTAssertTrue(appSource.contains("Toggle(\"Summarize later messages\""))
        XCTAssertTrue(appSource.contains("Button(\"Cancel\", action: cancel)"))
        XCTAssertTrue(appSource.contains(".interactiveDismissDisabled(isSubmitting)"))
        XCTAssertTrue(appSource.contains("await sessionCoordinator.branch("))
        XCTAssertTrue(appSource.contains("summarize: branchSummarize"))
        XCTAssertTrue(appSource.contains("branchError = appStore.state.session.error"))
    }

    func testSidebarForkIsOnlyAvailableForPersistedIdleTasks() throws {
        let saved = RailgunSessionSummary(
            id: "saved", model: "gpt-5", startedAt: "Today", messageCount: 1, firstUserPreview: "Task"
        )
        let session = RailgunSessionState(
            activeSessionID: "saved", sessions: [saved], archivedSessions: [], isLoading: false
        )

        XCTAssertTrue(RailgunTaskShell.isForkAvailable(
            sessionID: "saved", session: session, isRunActive: false, isTaskLocked: false, isMutationInFlight: false
        ))
        XCTAssertFalse(RailgunTaskShell.isForkAvailable(
            sessionID: "missing", session: session, isRunActive: false, isTaskLocked: false, isMutationInFlight: false
        ))
        XCTAssertFalse(RailgunTaskShell.isForkAvailable(
            sessionID: "saved", session: session, isRunActive: true, isTaskLocked: false, isMutationInFlight: false
        ))
        XCTAssertFalse(RailgunTaskShell.isForkAvailable(
            sessionID: "saved", session: session, isRunActive: false, isTaskLocked: true, isMutationInFlight: false
        ))
        XCTAssertFalse(RailgunTaskShell.isForkAvailable(
            sessionID: "saved", session: session, isRunActive: false, isTaskLocked: false, isMutationInFlight: true
        ))

        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("Button(\"Fork Task\", systemImage: \"arrow.triangle.branch\")"))
        XCTAssertTrue(source.contains(".contextMenu {"))
        XCTAssertTrue(source.contains("sessionOperationProgressBanner(\"Forking task…\")"))
        XCTAssertTrue(source.contains(".accessibilityIdentifier(\"session-operation-error\")"))
    }

    func testActivityUsesAPopoverWithoutFloatingGlassChrome() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("RailgunActivityPanel("))
        XCTAssertTrue(source.contains(".popover(isPresented: $isActivityPopoverPresented"))
        XCTAssertFalse(source.contains("RailgunActivityPanelBackground"))
        XCTAssertFalse(source.contains("displaysPanelBackground"))

        let activityPanelStart = try XCTUnwrap(
            source.range(of: "private struct RailgunActivityPanel: View {")
        )
        let activityPanelEnd = try XCTUnwrap(
            source.range(
                of: "private struct RailgunBackendStatusView: View {",
                range: activityPanelStart.upperBound..<source.endIndex
            )
        )
        let activityPanelSource = String(
            source[activityPanelStart.lowerBound..<activityPanelEnd.lowerBound]
        )
        XCTAssertFalse(activityPanelSource.contains("content.glassEffect("))
    }

    func testActivityPopoverUsesStableSize() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("@State private var isActivityPopoverPresented = false"))
        XCTAssertTrue(source.contains(".popover(isPresented: $isActivityPopoverPresented"))
        XCTAssertTrue(source.contains(".frame(width: Self.activityPanelPreferredWidth, height: Self.activityPopoverHeight)"))
        XCTAssertFalse(source.contains("detailViewportWidth"))
        XCTAssertFalse(source.contains("transcriptViewportWidth = geometry.viewportWidth"))
        XCTAssertEqual(RailgunTaskShell.activityPanelPreferredWidth, 320)
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

    func testTranscriptUsesScrollViewReaderForReliableBottomAnchoring() throws {
        let transcriptSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunTranscriptViewport.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(transcriptSource.contains("ScrollViewReader { proxy in"))
        XCTAssertTrue(transcriptSource.contains("proxy.scrollTo("))
        XCTAssertTrue(transcriptSource.contains(".onChange(of: contentRevision)"))
        XCTAssertTrue(transcriptSource.contains(".defaultScrollAnchor(.bottom)"))
        XCTAssertFalse(transcriptSource.contains("for: .alignment"))
        XCTAssertFalse(transcriptSource.contains("ScrollPosition("))
        XCTAssertFalse(transcriptSource.contains(".scrollPosition("))
    }

    func testDesktopDocumentationCapturesActivityPopoverAndTranscriptLayoutContracts() throws {
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
        XCTAssertTrue(readme.contains("presents a 320×360 popover"))
        XCTAssertTrue(readme.replacingOccurrences(of: "\n", with: " ").contains("scrolls as one native surface"))
        XCTAssertTrue(nativeUIPolicy.contains("## Activity popover layout invariant"))
        XCTAssertTrue(nativeUIPolicy.contains("Do not reserve transcript width"))
        XCTAssertTrue(nativeUIPolicy.contains("Do not add custom glass"))
        XCTAssertTrue(nativeUIPolicy.contains("Keep the dashboard inside a native `ScrollView`"))
    }

    func testNativeComposerPolicyDocumentsItsAppKitAndSubmissionBoundaries() throws {
        let nativeUIPolicy = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/native-ui-policy.md"),
            encoding: .utf8
        )

        XCTAssertTrue(nativeUIPolicy.contains("### `RailgunComposer`"))
        XCTAssertTrue(nativeUIPolicy.contains("Grow from one through ten visual lines"))
        XCTAssertTrue(nativeUIPolicy.contains("accessible name `Message`"))
        XCTAssertTrue(nativeUIPolicy.contains("macOS 26 and newer"))
        XCTAssertTrue(nativeUIPolicy.contains("macOS 15–25"))
        XCTAssertTrue(nativeUIPolicy.contains("SWFT-032"))
    }

    func testTaskControlDocumentationCapturesTheCurrentShellContract() throws {
        let readme = try String(
            contentsOf: repositoryRoot.appendingPathComponent("README.md"),
            encoding: .utf8
        )
        let nativeUIPolicy = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/native-ui-policy.md"),
            encoding: .utf8
        )

        XCTAssertTrue(readme.contains("native `Menu` whose models are individual `Button`"))
        XCTAssertTrue(nativeUIPolicy.contains("## Task toolbar and composer controls invariant"))
        XCTAssertTrue(nativeUIPolicy.contains("`#if compiler(>=6.2)`"))
        XCTAssertTrue(nativeUIPolicy.contains("Keep model selection as a SwiftUI `Menu` of `Button` actions"))
        XCTAssertTrue(nativeUIPolicy.contains("Do not add multi-agent controls to the Task surface"))
        XCTAssertTrue(nativeUIPolicy.contains("must report `Not measured yet`"))
        XCTAssertTrue(nativeUIPolicy.contains("visible inline error"))
        XCTAssertTrue(nativeUIPolicy.contains("row with Retry"))
    }

    func testTaskComposerUsesTheSharedProductSurfaceHierarchy() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("task-composer-surface"))
        XCTAssertTrue(source.contains("Message Railgun…"))
        XCTAssertTrue(source.contains(".modifier(RailgunComposerGlass())"))
        XCTAssertTrue(source.contains("task-composer-send"))
        XCTAssertTrue(source.contains("task-composer-stop"))
        XCTAssertTrue(source.contains("Image(systemName: \"stop.fill\")"))
        XCTAssertTrue(source.contains(".accessibilityLabel(\"Stop\")"))
        XCTAssertTrue(source.contains(".accessibilityLabel(\"Send\")"))
        XCTAssertTrue(source.contains("contextRing"))
        XCTAssertTrue(source.contains("canRetryComposerSubmission"))
        XCTAssertTrue(source.contains("composerSubmissionError"))
        XCTAssertTrue(source.contains("Button(\"Retry\", action: retryComposerSubmission)"))
        XCTAssertTrue(source.contains("composer-submission-error"))
        XCTAssertEqual(RailgunTaskShell.composerMaximumWidth, 736)
    }

    func testTaskComposerUsesLiquidGlassWithTheMaterialFallback() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("private struct RailgunComposerGlass: ViewModifier"))
        XCTAssertTrue(source.contains("#if compiler(>=6.2)"))
        XCTAssertTrue(source.contains("content.glassEffect(.regular, in: Self.shape)"))
        XCTAssertTrue(source.contains("if #available(macOS 26.0, *)"))
        XCTAssertTrue(source.contains(".background(.regularMaterial, in: Self.shape)"))
        XCTAssertTrue(source.contains(".modifier(RailgunComposerGlass())"))
    }

    func testTaskToolbarUsesNativeModelMenuWithRecoverableControlStatus() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("Menu {"))
        XCTAssertTrue(source.contains("Text(appStore.state.controls.activeModel?.name ?? \"Selected Model\")"))
        XCTAssertTrue(source.contains("Task { await controlsCoordinator.useModel(model.id) }"))
        XCTAssertFalse(source.contains("Picker(\"Model\", selection: modelSelection)"))
        XCTAssertFalse(source.contains("Use for This Task"))
        XCTAssertFalse(source.contains("Use and Make Default"))
        XCTAssertTrue(source.contains("controlsCoordinator.setModelDidChange"))
        XCTAssertTrue(source.contains("refreshAfterModelChange(modelID: modelID)"))
        XCTAssertTrue(source.contains("Label(\"Activity\", systemImage: RailgunTaskSymbol.activity)"))
        XCTAssertEqual(source.components(separatedBy: "ToolbarItem(placement: .primaryAction)").count - 1, 2)
        XCTAssertFalse(source.contains("ToolbarItem(placement: .topBarTrailing)"))
        XCTAssertTrue(source.contains("ToolbarItemGroup(placement: .navigation)"))
        XCTAssertTrue(source.contains("Button(\"Sidebar\", systemImage: \"sidebar.right\")"))
        XCTAssertTrue(source.contains("isFilesInspectorPresented.toggle()"))
        XCTAssertFalse(source.contains("ToolbarItemGroup(placement: .automatic)"))
        XCTAssertTrue(source.contains("#if compiler(>=6.2)"))
        XCTAssertTrue(source.contains("if #available(macOS 26.0, *)"))
        XCTAssertTrue(source.contains("ToolbarSpacer(.flexible, placement: .principal)"))
        XCTAssertTrue(source.contains("ToolbarItem(placement: .principal)"))
        XCTAssertFalse(source.contains(".toolbarRole(.editor)"))
        XCTAssertFalse(source.contains("Menu(\"Mixture of Agents\")"))
        XCTAssertFalse(source.contains("Toggle(\"Enable Advisor\""))
        XCTAssertFalse(source.contains("Menu(\"Advisor Model\")"))
        XCTAssertTrue(source.contains("task-model-menu"))
        XCTAssertTrue(source.contains("toggle-activity"))
        XCTAssertTrue(source.contains("task-controls-error"))
        XCTAssertTrue(source.contains("Compacting context…"))
        XCTAssertTrue(source.contains("context-compaction-completed"))
        XCTAssertTrue(source.contains("context-compaction-error"))
        XCTAssertTrue(source.contains("Button(\"Compact Context\", systemImage: \"arrow.triangle.2.circlepath\")"))
        XCTAssertTrue(source.contains("Task { await compactionCoordinator.compact() }"))
        XCTAssertTrue(source.contains("compactionCoordinator: backendRuntime.compactionCoordinator"))
        XCTAssertTrue(source.contains(".disabled(controlsAreDisabled || isSessionMutationInFlight)"))
        XCTAssertTrue(RailgunTaskShell.controlsAreDisabled(.initial, isRunActive: false))
        XCTAssertTrue(RailgunTaskShell.controlsAreDisabled(.initial, isRunActive: true))
    }

    func testScheduledWorkspaceOffersANavigationPlacedNewTaskAction() throws {
        let appSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let scheduledSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunScheduledView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(appSource.contains("RailgunScheduledWorkspace("))
        XCTAssertTrue(appSource.contains("createTask: createTask"))
        XCTAssertTrue(appSource.contains("canCreateTask: commandAvailability.canCreateTask"))
        XCTAssertTrue(scheduledSource.contains("ToolbarItem(placement: .navigation)"))
        XCTAssertTrue(scheduledSource.contains("Label(\"New Task\", systemImage: \"square.and.pencil\")"))
        XCTAssertTrue(scheduledSource.contains("createTask()"))
        XCTAssertTrue(appSource.contains(
            "private func createTask() {\n        guard commandAvailability.canCreateTask else { return }\n        appStore.send(.destination(.task))"
        ))
    }

    func testNewTaskCreationUsesTheConfiguredDefaultModel() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains(
            "await sessionCoordinator.create(modelID: store.state.controls.defaultModelID)"
        ))
        XCTAssertTrue(source.contains(
            "Task { await sessionCoordinator.create(modelID: appStore.state.controls.defaultModelID) }"
        ))
    }

    func testContextUsagePresentationUsesExactTotalsAndAccessibleProviderSource() throws {
        let model = RailgunModel(id: "model", name: "Model", contextWindow: 200_000)
        var controls = RailgunControlsState.initial
        controls.models = [model]
        controls.activeModelID = model.id
        XCTAssertEqual(controls.activeModel, model)
        XCTAssertEqual(
            RailgunContextUsagePresentation(
                usage: .init(inputTokens: 100_000, outputTokens: 50_000),
                activeModel: model
            ).text,
            "150,000 / 200,000 tokens (75%)"
        )
        XCTAssertEqual(
            RailgunContextUsagePresentation(usage: nil, activeModel: model).text,
            "Not measured yet"
        )

        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("Latest provider-reported input plus output tokens"))
        XCTAssertTrue(source.contains("ContextRing("))
        XCTAssertTrue(source.contains("usedTokens: usage?.totalTokens"))
        XCTAssertFalse(source.contains("usedTokens: usage?.totalTokens ?? 0"))
        XCTAssertTrue(source.contains("Text(\"Not measured yet\")"))
    }

    func testInteractionPromptsUseNativeControlsAndKeepStopAvailable() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("interactionPrompts"))
        XCTAssertTrue(source.contains("Button(\"Deny\", role: .destructive)"))
        XCTAssertTrue(source.contains("TextField(\"Answer\""))
        XCTAssertTrue(source.contains("Picker(\"Choices\""))
        XCTAssertTrue(source.contains(".pickerStyle(.radioGroup)"))
        XCTAssertTrue(source.contains(".onKeyPress(.escape)"))
        XCTAssertTrue(source.contains(".onKeyPress(.return)"))
        XCTAssertTrue(source.contains("RailgunRPCClient.declinedClarificationAnswer"))
        XCTAssertTrue(source.contains("interaction-command-preview-"))
        XCTAssertTrue(source.contains("interaction-answer-"))
        XCTAssertTrue(source.contains("interaction-choices-"))
        XCTAssertTrue(source.contains("interaction-error-"))
        XCTAssertTrue(source.contains("interaction-deny-"))
        XCTAssertTrue(source.contains("interaction-allow-"))
        XCTAssertTrue(source.contains("interactions.requests.isEmpty"))
        XCTAssertTrue(source.contains("var requestID: String"))
        XCTAssertTrue(source.contains("!current.contains(where: { $0.id == interactionFocus.requestID })"))
        XCTAssertTrue(source.contains("focusInteraction(request)"))
        XCTAssertFalse(source.contains(".disabled(!commandAvailability.canStop || !appStore.state.interactions.requests.isEmpty)"))
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
        XCTAssertTrue(source.contains("NavigationSplitView(columnVisibility: $navigationSplitViewVisibility)"))
        XCTAssertTrue(source.contains("isActivityPopoverPresented.toggle()"))
        XCTAssertTrue(source.contains(".popover(isPresented: $isActivityPopoverPresented"))
        XCTAssertFalse(source.contains("close-activity"))
        XCTAssertFalse(source.contains("dismiss: { isActivityCardVisible"))
    }

    func testArchivedTaskBrowserUsesNativeTableSearchAndContextMenu() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunArchivedTaskBrowser.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("Table(tasks, selection:"))
        XCTAssertTrue(source.contains(".searchable(text: $searchText"))
        XCTAssertTrue(source.contains(".contextMenu(forSelectionType:"))
        XCTAssertTrue(source.contains("if taskIDs.count == 1, let taskID = taskIDs.first"))
        XCTAssertTrue(source.contains("Button(\"Copy Task ID\")"))
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
        XCTAssertTrue(
            transcriptSource.contains("#if compiler(>=6.2)"),
            "macOS 26-only SwiftUI APIs must not be parsed by Xcode 16's macOS 15 SDK."
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

    func testArchivedTaskBrowserFiltersTitleModelAndIDAndDistinguishesEmptyStates() {
        let archived = RailgunArchivedSessionSummary(
            session: .init(
                id: "task-archive-123",
                model: "gpt-5",
                startedAt: "Yesterday",
                messageCount: 3,
                firstUserPreview: "Restore this"
            ),
            archivedAt: Date(timeIntervalSince1970: 1_784_457_000)
        )
        let other = RailgunArchivedSessionSummary(
            session: .init(
                id: "other-task",
                model: "gpt-5-mini",
                startedAt: "Yesterday",
                messageCount: 1,
                firstUserPreview: "Different task"
            ),
            archivedAt: Date(timeIntervalSince1970: 1_784_457_001)
        )
        let session = RailgunSessionState(
            activeSessionID: nil,
            sessions: [],
            archivedSessions: [archived, other],
            isLoading: false
        )

        XCTAssertEqual(
            RailgunArchivedTaskBrowserPresentation(session: .initial, query: ""),
            .empty
        )
        XCTAssertEqual(
            RailgunArchivedTaskBrowserPresentation(session: session, query: " Restore "),
            .tasks([archived])
        )
        XCTAssertEqual(
            RailgunArchivedTaskBrowserPresentation(session: session, query: "mini"),
            .tasks([other])
        )
        XCTAssertEqual(
            RailgunArchivedTaskBrowserPresentation(session: session, query: "archive-123"),
            .tasks([archived])
        )
        XCTAssertEqual(
            RailgunArchivedTaskBrowserPresentation(session: session, query: "missing"),
            .noResults
        )
    }

    func testArchivedTaskBrowserPresentsLoadingAndDisablesRestoreWhenUnavailableOrMutating() {
        XCTAssertEqual(
            RailgunArchivedTaskBrowserPresentation(
                session: .init(activeSessionID: nil, sessions: [], archivedSessions: [], isLoading: true),
                query: ""
            ),
            .loading
        )
        XCTAssertTrue(RailgunArchivedTaskBrowserAvailability(session: .initial, backendPhase: .ready).canRestore)

        var session = RailgunSessionState.initial
        session.restoreInFlightSessionID = "archived"
        XCTAssertFalse(RailgunArchivedTaskBrowserAvailability(session: session, backendPhase: .ready).canRestore)
        XCTAssertFalse(RailgunArchivedTaskBrowserAvailability(session: .initial, backendPhase: .failed("Offline")).canRestore)
    }

    func testTaskIDPasteboardWritesToAnInjectedNamedPasteboard() {
        let pasteboard = NSPasteboard(name: .init("RailgunXTests-\(UUID().uuidString)"))
        let copier = RailgunTaskIDPasteboard(pasteboard: pasteboard)

        XCTAssertTrue(copier.copy("task-archive-123"))
        XCTAssertEqual(pasteboard.string(forType: .string), "task-archive-123")
    }

    func testNativeUIPolicyDocumentsTheArchivePasteboardBoundary() throws {
        let nativeUIPolicy = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/native-ui-policy.md"),
            encoding: .utf8
        )

        XCTAssertTrue(nativeUIPolicy.contains("### `RailgunTaskIDPasteboard`"))
        XCTAssertTrue(nativeUIPolicy.contains("macOS 15 SwiftUI cannot perform this"))
        XCTAssertTrue(nativeUIPolicy.contains("Archived Tasks table"))
        XCTAssertTrue(nativeUIPolicy.contains("only for exactly one"))
    }

    func testReadmeDocumentsTheArchivedTaskBrowserBehavior() throws {
        let readme = try String(
            contentsOf: repositoryRoot.appendingPathComponent("README.md"),
            encoding: .utf8
        )

        XCTAssertTrue(readme.contains("### Archived task browser"))
        XCTAssertTrue(readme.contains("full task ID"))
        XCTAssertTrue(readme.contains("exactly one selected row"))
        XCTAssertTrue(readme.contains("without opening or resuming it"))
    }

    func testAppUsesThePrimaryLifecycleConfiguration() {
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration, .primary)
    }

    func testSettingsDefaultDestinationIsGeneral() {
        XCTAssertEqual(RailgunSettingsDestination.defaultSelection, .general)
        XCTAssertEqual(RailgunSettingsView.windowID, "settings")
    }

    func testAppearancePreferenceMapsEachChoiceToItsExpectedColorScheme() {
        XCTAssertNil(RailgunAppearance.automatic.colorScheme)
        XCTAssertEqual(RailgunAppearance.light.colorScheme, .light)
        XCTAssertEqual(RailgunAppearance.dark.colorScheme, .dark)
        XCTAssertEqual(RailgunAppearance.allCases.map(\.title), ["Auto", "Light", "Dark"])
    }

    func testNativeUITaskSidebarPolicyDocumentsTheNativeListContract() throws {
        let nativeUIPolicy = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/native-ui-policy.md"),
            encoding: .utf8
        )

        XCTAssertTrue(nativeUIPolicy.contains("## Task sidebar invariant"))
        XCTAssertTrue(nativeUIPolicy.contains("native `.sidebar`-styled `List`"))
        XCTAssertTrue(nativeUIPolicy.contains("`ContentUnavailableView` with the"))
        XCTAssertTrue(nativeUIPolicy.contains("**Fork Task** context menu"))
    }

    func testNativeUIPolicyDocumentsNewTaskAndAdvisorContracts() throws {
        let nativeUIPolicy = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/native-ui-policy.md"),
            encoding: .utf8
        )
        let productGuide = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/PRODUCT.md"),
            encoding: .utf8
        )
        let normalizedPolicy = nativeUIPolicy.replacingOccurrences(of: "\n", with: " ")

        XCTAssertTrue(normalizedPolicy.contains("do not show a Select a Task placeholder"))
        XCTAssertTrue(normalizedPolicy.contains("New Task in its navigation toolbar placement"))
        XCTAssertTrue(nativeUIPolicy.contains("Default model for new tasks"))
        XCTAssertTrue(nativeUIPolicy.contains("selectable advisor notes in a click-to-open popover"))
        XCTAssertTrue(productGuide.contains("starts as an unsaved new task"))
        XCTAssertTrue(productGuide.contains("default model for new tasks"))
    }

    func testPrimaryWindowUsesTheSharedMatchaTintAndSidebarSelection() throws {
        let appSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let sharedTint = ".tint(RailgunColorRole.accent.color)"

        XCTAssertEqual(
            appSource.components(separatedBy: sharedTint).count - 1,
            1,
            "The primary window must inherit the shared matcha tint."
        )
        XCTAssertTrue(appSource.contains("RailgunSidebarSessionRow"))
        XCTAssertTrue(appSource.contains("Section(\"Tasks\")"))
        XCTAssertTrue(appSource.contains(".listStyle(.sidebar)"))
        XCTAssertTrue(appSource.contains("systemImage: \"tray\""))
        XCTAssertTrue(appSource.contains("isSelected ? RailgunColorRole.accent.color : RailgunColorRole.primaryText.color"))
        XCTAssertTrue(appSource.contains("isSelected ? Color.primary.opacity(0.08) : .clear"))
        XCTAssertFalse(appSource.contains("List(selection: selection)"))
    }

    func testSettingsUsesTheSharedMatchaTintAndSplitViewShell() throws {
        let appSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let settingsSource = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunSettingsView.swift"),
            encoding: .utf8
        )
        let sharedTint = ".tint(RailgunColorRole.accent.color)"

        XCTAssertEqual(
            settingsSource.components(separatedBy: sharedTint).count - 1,
            1,
            "The Settings window must inherit the shared matcha tint."
        )
        XCTAssertTrue(settingsSource.contains("NavigationSplitView"))
        XCTAssertTrue(settingsSource.contains("RailgunSidebarSelectionRow"))
        XCTAssertTrue(appSource.contains("RailgunSidebarSelectionRow"))
        XCTAssertTrue(settingsSource.contains("isSelected: displayedDestination == .appearance"))
        XCTAssertFalse(settingsSource.contains("List(selection: $selection)"))
        XCTAssertTrue(settingsSource.contains("@AppStorage(RailgunAppearance.storageKey)"))
        XCTAssertTrue(settingsSource.contains("ThemePickerCard"))
        XCTAssertTrue(settingsSource.contains("ThemePreview(theme: theme, isSelected: isSelected)"))
        XCTAssertTrue(settingsSource.contains("return RailgunColorRole.accent.color"))
        XCTAssertTrue(settingsSource.contains("\"Archived Tasks\",\n                        systemImage: \"archivebox\""))
        XCTAssertTrue(settingsSource.contains("settings-approval-mode"))
        XCTAssertTrue(settingsSource.contains("settings-approval-model"))
        XCTAssertTrue(settingsSource.contains("settings-default-model"))
        XCTAssertTrue(settingsSource.contains("settings-advisor-enabled"))
        XCTAssertTrue(settingsSource.contains("settings-advisor-model"))
        XCTAssertTrue(settingsSource.contains("controlsCoordinator.configureDefaultModel"))
        XCTAssertTrue(settingsSource.contains("controlsCoordinator.configureAdvisor"))
        XCTAssertTrue(settingsSource.contains(".navigationSplitViewColumnWidth("))
        XCTAssertTrue(settingsSource.contains(".navigationSplitViewStyle(.prominentDetail)"))
        XCTAssertTrue(settingsSource.contains("CommandGroup(replacing: .appSettings)"))
        XCTAssertTrue(settingsSource.contains("openWindow(id: RailgunSettingsView.windowID)"))
        XCTAssertTrue(appSource.contains("Window(\"Settings\", id: RailgunSettingsView.windowID)"))
        XCTAssertTrue(appSource.contains("@AppStorage(RailgunAppearance.storageKey)"))
        XCTAssertTrue(appSource.contains(".preferredColorScheme(appearance.colorScheme)"))
        XCTAssertFalse(appSource.contains("Settings {"))
        XCTAssertTrue(appSource.contains("width: RailgunSettingsView.defaultWindowWidth"))
        XCTAssertTrue(appSource.contains(".windowResizability(.contentMinSize)"))
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
        XCTAssertEqual(record.clientName, "Railgun")
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
            bundleID: "io.anvia.other-railgun",
            clientName: "Other Railgun client",
            startTime: "2026-07-18T11:00:00Z"
        )
        try staleRecord.encodedData().write(to: lock.fileURL)
        try staleRecord.encodedData().write(
            to: home.railgunDirectory.appendingPathComponent("desktop-client.lock.recovery")
        )

        let record = try await lock.acquire()

        XCTAssertEqual(record.clientName, "Railgun")
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
            bundleID: "io.anvia.other-railgun",
            clientName: "Other Railgun client",
            startTime: "2026-07-18T11:00:00Z"
        )
        try liveRecord.encodedData().write(to: lock.fileURL)

        do {
            _ = try await lock.acquire()
            XCTFail("Expected the live lock to block Railgun")
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
            bundleID: "io.anvia.other-railgun",
            clientName: "Other Railgun client",
            startTime: "2026-07-18T12:01:00Z"
        )
        _ = try await lock.acquire()
        try replacement.encodedData().write(to: lock.fileURL)

        await lock.release()

        XCTAssertEqual(try DesktopClientLockRecord(data: Data(contentsOf: lock.fileURL)), replacement)
    }

    func testPrimaryWindowLifecycleConfiguration() {
        let configuration = AppLifecycleConfiguration.primary

        XCTAssertEqual(configuration.primaryWindowTitle, "Railgun")
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

    func testMockBackendLaunchUsesTheRustFixtureWithTheRequestedScenario() throws {
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

        XCTAssertEqual(
            launch.executableURL,
            repositoryRoot.appendingPathComponent("target/debug/railgun-mock-backend")
        )
        XCTAssertEqual(launch.arguments, ["ready-idle"])
        XCTAssertEqual(launch.currentDirectoryURL, repositoryRoot.standardizedFileURL)
        XCTAssertEqual(launch.environment?["RAILGUN_DESKTOP_RPC"], "1")
        XCTAssertNil(configuration.schedulerLaunch(resourcesDirectory: repositoryRoot))
    }

    func testSourceSchedulerLaunchRunsThePrivateSchedulerMode() throws {
        let configuration = BackendLaunchConfiguration(
            environment: [:],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=source",
                "--railgunx-source-root=\(repositoryRoot.path)",
            ]
        )

        let launch = try XCTUnwrap(configuration.schedulerLaunch(resourcesDirectory: repositoryRoot))

        XCTAssertEqual(
            launch.executableURL,
            repositoryRoot.appendingPathComponent("target/debug/railgun-backend")
        )
        XCTAssertEqual(launch.arguments, ["scheduler"])
        XCTAssertEqual(launch.currentDirectoryURL, repositoryRoot.standardizedFileURL)
        XCTAssertNil(launch.environment?["RAILGUN_DESKTOP_RPC"])
    }

    func testMockBackendLaunchAlwaysUsesTheSourceRustBinary() throws {
        let resourcesDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgunx-staged-backend-\(UUID().uuidString)", isDirectory: true)
        let stagedBackend = resourcesDirectory.appendingPathComponent("backend/railgun-backend")
        defer { try? FileManager.default.removeItem(at: resourcesDirectory) }

        try FileManager.default.createDirectory(
            at: stagedBackend.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        XCTAssertTrue(FileManager.default.createFile(atPath: stagedBackend.path, contents: Data()))
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: stagedBackend.path
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

        XCTAssertEqual(
            launch.executableURL,
            repositoryRoot.appendingPathComponent("target/debug/railgun-mock-backend")
        )
        XCTAssertEqual(launch.arguments, ["ready-idle"])
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
        XCTAssertEqual(store.state.session.activeSessionID, "mock-new-1")
        XCTAssertFalse(store.state.session.selectedSession?.isPersisted ?? true)
        XCTAssertEqual(store.state.session.sessions.first?.id, "mock-session-complex-task")
        XCTAssertFalse(store.state.session.sessions.contains(where: { $0.id == "mock-new-1" }))
        XCTAssertTrue(store.state.session.archivedSessions.isEmpty)
        XCTAssertTrue(store.state.controls.isLoaded)
        XCTAssertEqual(store.state.controls.activeModelID, "mock-model")
        XCTAssertEqual(store.state.controls.moaPresets.map(\.name), ["review"])
        XCTAssertEqual(store.state.controls.advisor, .init(isEnabled: false, modelID: "mock-reference"))

        await runtime.shutdown()
    }

    func testTaskShellNeverShowsASelectionRequiredPlaceholder() throws {
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(source.contains("\"Select a Task\""))
        XCTAssertFalse(source.contains("Choose a task from the sidebar to continue."))
        XCTAssertTrue(source.contains("case .newTask:\n            EmptyView()"))
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
            ["mock-session-complex-task", "mock-session-paginated-history", "mock-session-rich-history", "mock-session-recent", "mock-session-older"]
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

    func testMockRuntimeRestartIsSingleFlightAndRefreshesFreshBackendState() async {
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

        // A successful recovery must replace stale feature snapshots, while
        // concurrent requests collapse into one new RPC generation.
        store.send(.session(.loaded([])))
        store.send(.controls(.loadFailed("stale controls")))
        async let firstRecovery: Void = runtime.restart()
        async let duplicateRecovery: Void = runtime.restart()
        _ = await (firstRecovery, duplicateRecovery)

        XCTAssertEqual(store.state.backend.phase, .ready)
        XCTAssertEqual(store.state.session.sessions.first?.id, "mock-session-complex-task")
        XCTAssertTrue(store.state.controls.isLoaded)

        await runtime.shutdown()
    }

    func testMockRuntimeKeepsEventsAndInteractionsObservedAfterRestart() async throws {
        let configuration = BackendLaunchConfiguration(
            environment: [:],
            arguments: [
                "RailgunX",
                "--railgunx-backend-mode=mock",
                "--railgunx-mock-scenario=approval",
                "--railgunx-source-root=\(repositoryRoot.path)",
            ]
        )
        let store = RailgunAppStore()
        let runtime = RailgunBackendRuntime(configuration: configuration, store: store)

        await runtime.start()
        await runtime.restart()
        XCTAssertEqual(store.state.backend.phase, .ready)

        let didSubmit = await runtime.promptCoordinator.submit("Run after recovery")
        XCTAssertTrue(didSubmit)
        await waitForInteraction(in: store)

        let request = try XCTUnwrap(store.state.interactions.requests.first)
        guard case .approval = request.kind else {
            return XCTFail("Expected an approval after restarting the backend")
        }
        await runtime.interactionCoordinator.respondToApproval(id: request.id, approved: true)
        await waitForRunToSettle(in: store)

        XCTAssertFalse(store.state.transcript.isRunning)
        XCTAssertTrue(store.state.interactions.requests.isEmpty)

        await runtime.shutdown()
    }

    func testMockRuntimeDeliversAndSettlesApprovalAndClarificationInteractions() async throws {
        for scenario in ["approval", "clarification-free-text", "clarification-choice"] {
            let configuration = BackendLaunchConfiguration(
                environment: [:],
                arguments: [
                    "RailgunX",
                    "--railgunx-backend-mode=mock",
                    "--railgunx-mock-scenario=\(scenario)",
                    "--railgunx-source-root=\(repositoryRoot.path)",
                ]
            )
            let store = RailgunAppStore()
            let runtime = RailgunBackendRuntime(configuration: configuration, store: store)

            await runtime.start()
            _ = await runtime.promptCoordinator.submit("Resolve \(scenario)")
            await waitForInteraction(in: store)

            let request = try XCTUnwrap(store.state.interactions.requests.first)
            switch request.kind {
            case .approval:
                await runtime.interactionCoordinator.respondToApproval(id: request.id, approved: true)
            case .clarification:
                let answer = request.choices?.last ?? "A free-text answer"
                await runtime.interactionCoordinator.respondToClarification(id: request.id, answer: answer)
            }
            await waitForNoInteractions(in: store)
            XCTAssertTrue(store.state.interactions.requests.isEmpty)

            await runtime.shutdown()
        }
    }

    func testBackendPresentationOnlyShowsTheTaskShellWhenReady() {
        XCTAssertEqual(RailgunBackendPresentation(phase: .starting), .starting)
        XCTAssertEqual(RailgunBackendPresentation(phase: .ready), .ready)
        XCTAssertEqual(
            RailgunBackendPresentation(phase: .authenticationRequired(source: .file)),
            .authenticationRequired(
                title: "Authentication Required",
                message: "Sign in with your provider outside Railgun, then retry. Provider sign-in is coming in a later milestone."
            )
        )
        XCTAssertEqual(
            RailgunBackendPresentation(phase: .authenticationRequired(source: .environment)),
            .authenticationRequired(
                title: "Authentication Required",
                message: "Update DEVIN_TOKEN in the environment that launches Railgun, then relaunch Railgun."
            )
        )
        XCTAssertEqual(
            RailgunBackendPresentation(phase: .failed("Launch failed")),
            .unavailable(
                title: "Backend Unavailable",
                message: "Launch failed",
                systemImage: "exclamationmark.triangle.fill",
                retryTitle: "Retry"
            )
        )
        XCTAssertEqual(
            RailgunBackendPresentation(phase: .disconnected("Connection lost")),
            .unavailable(
                title: "Backend Disconnected",
                message: "Connection lost",
                systemImage: "bolt.horizontal.circle",
                retryTitle: "Restart"
            )
        )

        XCTAssertEqual(RailgunBackendAvailability(phase: .starting), .init(canRetry: false))
        XCTAssertEqual(RailgunBackendAvailability(phase: .ready), .init(canRetry: false))
        XCTAssertEqual(RailgunBackendAvailability(phase: .failed("Launch failed")), .init(canRetry: true))
        XCTAssertEqual(RailgunBackendAvailability(phase: .disconnected("Connection lost")), .init(canRetry: true))
        XCTAssertEqual(
            RailgunBackendAvailability(phase: .authenticationRequired(source: .environment)),
            .init(canRetry: true)
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

        XCTAssertTrue(runScript.contains("Debug/Railgun.app"))
        XCTAssertTrue(runScript.contains("Contents/MacOS/Railgun"))
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

    func testNativeBackendStagingContractUsesArm64AndAnAtomicPayload() throws {
        let stagingScriptURL = repositoryRoot.appendingPathComponent("apps/macos/scripts/stage-backend.sh")
        let validationScriptURL = repositoryRoot.appendingPathComponent("apps/macos/scripts/validate-backend.sh")
        let lifecycleValidationScriptURL = repositoryRoot.appendingPathComponent(
            "apps/macos/scripts/validate-packaged-backend-lifecycle.sh"
        )
        let projectURL = repositoryRoot.appendingPathComponent("apps/macos/project.yml")
        let stagingScript = try String(contentsOf: stagingScriptURL, encoding: .utf8)
        let validationScript = try String(contentsOf: validationScriptURL, encoding: .utf8)
        let lifecycleValidationScript = try String(contentsOf: lifecycleValidationScriptURL, encoding: .utf8)
        let project = try String(contentsOf: projectURL, encoding: .utf8)

        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: stagingScriptURL.path))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: validationScriptURL.path))
        XCTAssertTrue(stagingScript.contains("cargo build --locked --release --package railgun-backend"))
        XCTAssertTrue(stagingScript.contains("cargo build --locked --package railgun-backend"))
        XCTAssertTrue(stagingScript.contains("[[ \"$architecture\" == arm64 ]]"))
        XCTAssertTrue(stagingScript.contains("mv \"$staging\" \"$output/backend\""))
        XCTAssertTrue(validationScript.contains("architecture=\"$(uname -m)\""))
        XCTAssertTrue(validationScript.contains("railgun-backend"))
        XCTAssertTrue(validationScript.contains("validate-packaged-backend-lifecycle.sh"))
        XCTAssertTrue(lifecycleValidationScript.contains("authentication_required"))
        XCTAssertTrue(lifecycleValidationScript.contains("env -u DEVIN_TOKEN"))
        XCTAssertTrue(lifecycleValidationScript.contains("kill -KILL"))
        XCTAssertTrue(project.contains("preBuildScripts:"))
        XCTAssertTrue(project.contains("architecture=\"${CURRENT_ARCH:-}\""))
        XCTAssertTrue(project.contains("--architecture \"$architecture\""))
        XCTAssertTrue(project.contains("--configuration \"$CONFIGURATION\""))
        XCTAssertTrue(project.contains("UNLOCALIZED_RESOURCES_FOLDER_PATH"))
    }

    func testNativeProductKeepsItsInternalSwiftModuleNameAcrossThePublicRename() throws {
        let project = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/project.yml"),
            encoding: .utf8
        )

        XCTAssertTrue(project.contains("PRODUCT_NAME: Railgun"))
        XCTAssertTrue(project.contains("PRODUCT_MODULE_NAME: RailgunX"))
        XCTAssertTrue(project.contains("TEST_HOST: \"$(BUILT_PRODUCTS_DIR)/Railgun.app/Contents/MacOS/Railgun\""))
    }

    func testNativeReleaseUsesAnExplicitSparkleInfoPlistAndArchitecture() throws {
        let project = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/project.yml"),
            encoding: .utf8
        )
        let infoPlist = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/Resources/Info.plist"),
            encoding: .utf8
        )
        let archiveScript = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/scripts/archive-release.sh"),
            encoding: .utf8
        )
        let projectGenerator = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/scripts/generate-project.sh"),
            encoding: .utf8
        )
        let projectValidation = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/scripts/validate-project.sh"),
            encoding: .utf8
        )
        let appcastGenerator = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/scripts/generate-appcast.sh"),
            encoding: .utf8
        )

        XCTAssertTrue(project.contains("INFOPLIST_FILE: Resources/Info.plist"))
        XCTAssertTrue(project.contains("CODE_SIGN_ENTITLEMENTS: RailgunXRelease.entitlements"))
        XCTAssertTrue(infoPlist.contains("<key>SUFeedURL</key>"))
        XCTAssertTrue(infoPlist.contains("Railgun-appcast-$(RAILGUNX_SPARKLE_FEED_ARCHITECTURE).xml"))
        XCTAssertTrue(infoPlist.contains("<key>SUPublicEDKey</key>"))
        XCTAssertTrue(archiveScript.contains("RAILGUNX_SPARKLE_FEED_ARCHITECTURE=\"$architecture\""))
        XCTAssertTrue(projectGenerator.contains("cp \"$project_root/Resources/Info.plist\""))
        XCTAssertTrue(projectGenerator.contains("cp \"$project_root/RailgunXRelease.entitlements\""))
        XCTAssertTrue(projectValidation.contains("archive_release_configuration"))
        XCTAssertTrue(projectValidation.contains("-configuration Release"))
        XCTAssertTrue(projectValidation.contains("release_archive=\"$temporary_root/RailgunRelease.xcarchive\""))
        XCTAssertTrue(projectValidation.contains("release_app=\"$release_archive/Products/Applications/Railgun.app\""))
        XCTAssertTrue(projectValidation.contains("\"$sign_nested_code\" --app \"$release_app\" --identity -"))
        XCTAssertTrue(projectValidation.contains("RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY=\"$sparkle_private_key\""))
        XCTAssertTrue(projectValidation.contains("grep -q 'sparkle:edSignature='"))
        XCTAssertTrue(appcastGenerator.contains("/bin/cp \"$archive\""))
        XCTAssertTrue(appcastGenerator.contains("/bin/cp \"$generated_appcast\""))
        XCTAssertFalse(appcastGenerator.contains("/usr/bin/cp"))
    }

    func testNativeReleaseBuildValidatesTheMacOS26SDKForLiquidGlass() throws {
        let publishWorkflow = try String(
            contentsOf: repositoryRoot.appendingPathComponent(".github/workflows/publish.yml"),
            encoding: .utf8
        )

        XCTAssertTrue(publishWorkflow.contains("build-railgun:\n    name: Railgun (arm64)\n    runs-on: macos-26"))
        XCTAssertTrue(publishWorkflow.contains("name: Verify macOS 26 SDK for Liquid Glass"))
        XCTAssertTrue(publishWorkflow.contains("xcodebuild -showsdks | grep -q 'macOS 26'"))
    }

    func testReleaseDocumentationExplainsTheMacOS26LiquidGlassToolchainRequirement() throws {
        let releasingGuide = try String(
            contentsOf: repositoryRoot.appendingPathComponent("docs/RELEASING.md"),
            encoding: .utf8
        )

        XCTAssertTrue(releasingGuide.contains("`macos-26`"))
        XCTAssertTrue(releasingGuide.contains("macOS 26 SDK"))
        XCTAssertFalse(releasingGuide.contains("Xcode 26"))
        XCTAssertTrue(releasingGuide.contains("macOS 15–25 material fallback"))
        XCTAssertTrue(releasingGuide.contains("`macos-15`"))
    }

    func testNativeMockBackendRunsDirectlyFromItsRustFixture() throws {
        let mockBackend = try String(
            contentsOf: repositoryRoot.appendingPathComponent("crates/railgun-mock-backend/src/main.rs"),
            encoding: .utf8
        )
        let appSource = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let projectValidation = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/scripts/validate-project.sh"),
            encoding: .utf8
        )

        XCTAssertTrue(mockBackend.contains("transcript::page"))
        XCTAssertTrue(appSource.contains("target/debug/railgun-mock-backend"))
        XCTAssertTrue(projectValidation.contains("--package railgun-mock-backend"))
        XCTAssertFalse(appSource.contains("--import"))
    }

    func testReleaseValidationRequiresSparkleEdDSASignaturesOnly() throws {
        let validation = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/scripts/validate-release-artifact.sh"),
            encoding: .utf8
        )

        XCTAssertTrue(validation.contains("sparkle:edSignature="))
        XCTAssertFalse(validation.contains("sparkle:signature="))
    }

    func testLegalNoticesAreBundledWithTheApplication() throws {
        let noticesURL = try XCTUnwrap(LegalNotices.noticesURL)
        XCTAssertNotNil(LegalNotices.manifestURL)

        let notices = try String(contentsOf: noticesURL, encoding: .utf8)
        XCTAssertTrue(notices.contains("### Notice"))
        XCTAssertTrue(notices.contains("Permission is hereby granted"))
        XCTAssertTrue(notices.contains("Apache License"))
        XCTAssertFalse(notices.contains("See crate metadata"))

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

        XCTAssertEqual(records["crate:widevin@0.2.0"]?.version, "0.2.0")
        XCTAssertEqual(records["crate:widevin@0.2.0"]?.kind, .rustCrate)
        XCTAssertEqual(records["railgun-icon-artwork"]?.copyright, "© 2026 Dante Teo")
        XCTAssertEqual(records["railgun"]?.license, "MIT")
    }

    func testLegalNoticeManifestContainsTheLockedRustBackendClosure() throws {
        let manifest = try LegalNotices.loadManifest()
        let backendRecords = manifest.components.filter { $0.kind == .rustCrate }
        let backendNames = Set(backendRecords.map(\.name))

        XCTAssertFalse(backendRecords.isEmpty)
        XCTAssertTrue(backendNames.contains("widevin"))
        XCTAssertTrue(backendNames.contains("sqlx"))
        XCTAssertTrue(backendNames.contains("tokio"))
        XCTAssertTrue(backendRecords.allSatisfy { !$0.noticeContentSHA256.isEmpty })
    }

    func testLegalNoticeManifestTracksTheCheckedInBackendLockfile() throws {
        let manifest = try LegalNotices.loadManifest()
        let lockfile = try Data(contentsOf: repositoryRoot.appendingPathComponent("Cargo.lock"))

        XCTAssertEqual(manifest.backendLockfileSHA256, SHA256.hash(data: lockfile).hexString)
    }

    func testLegalNoticeValidatorAcceptsTheCheckedInCatalog() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "cargo",
            "xtask",
            "legal",
            "--check",
        ]
        process.currentDirectoryURL = repositoryRoot
        let inheritedEnvironment = ProcessInfo.processInfo.environment
        let executableSearchPath = [
            inheritedEnvironment["PATH"],
            URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".cargo/bin").path,
            "/opt/homebrew/bin",
            "/usr/local/bin"
        ]
        .compactMap { $0 }
        .joined(separator: ":")
        process.environment = inheritedEnvironment.merging(
            ["PATH": executableSearchPath],
            uniquingKeysWith: { _, replacement in replacement }
        )

        try process.run()
        process.waitUntilExit()

        XCTAssertEqual(process.terminationStatus, 0)
    }
}

@MainActor
private func waitForInteraction(in store: RailgunAppStore) async {
    for _ in 0..<50 {
        if !store.state.interactions.requests.isEmpty { return }
        try? await Task.sleep(for: .milliseconds(20))
    }
}

@MainActor
private func waitForNoInteractions(in store: RailgunAppStore) async {
    for _ in 0..<50 {
        if store.state.interactions.requests.isEmpty { return }
        try? await Task.sleep(for: .milliseconds(20))
    }
}

@MainActor
private func waitForRunToSettle(in store: RailgunAppStore) async {
    for _ in 0..<50 {
        if !store.state.transcript.isRunning { return }
        try? await Task.sleep(for: .milliseconds(20))
    }
}

private extension Digest {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
