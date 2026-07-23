import Foundation
import RailgunCore
import RailgunServices
import RailgunTransport
import RailgunUI
import Observation
import SwiftUI

enum PrimaryWindowResizability: Equatable {
    case contentMinimumSize

    var swiftUIValue: WindowResizability {
        .contentMinSize
    }
}

struct AppLifecycleConfiguration: Equatable {
    let primaryWindowTitle: String
    let primaryWindowRestorationIdentifier: String
    let primaryWindowDefaultSize: CGSize
    let primaryWindowMinimumSize: CGSize
    let primaryWindowResizability: PrimaryWindowResizability

    static let primary = Self(
        primaryWindowTitle: "Railgun",
        primaryWindowRestorationIdentifier: "primary",
        primaryWindowDefaultSize: CGSize(width: 1_024, height: 700),
        primaryWindowMinimumSize: CGSize(width: 760, height: 520),
        primaryWindowResizability: .contentMinimumSize
    )
}

struct BackendLaunchConfiguration: Equatable {
    enum Mode: String, Equatable {
        case bundled
        case source
        case mock
    }

    static let defaultMockScenario = "ready-idle"

    let mode: Mode
    let sourceRoot: URL?
    let mockScenario: String?

    private init(mode: Mode, sourceRoot: URL?, mockScenario: String?) {
        self.mode = mode
        self.sourceRoot = sourceRoot
        self.mockScenario = mockScenario
    }

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = CommandLine.arguments
    ) {
        let requestedMode = Self.configurationValue(
            named: "backend-mode",
            environmentKey: "RAILGUNX_BACKEND_MODE",
            environment: environment,
            arguments: arguments
        )

        switch requestedMode {
        case Mode.source.rawValue:
            self.init(
                mode: .source,
                sourceRoot: Self.sourceRoot(environment: environment, arguments: arguments),
                mockScenario: nil
            )
        case Mode.mock.rawValue:
            let requestedScenario = Self.configurationValue(
                named: "mock-scenario",
                environmentKey: "RAILGUNX_MOCK_SCENARIO",
                environment: environment,
                arguments: arguments
            )
            self.init(
                mode: .mock,
                sourceRoot: Self.sourceRoot(environment: environment, arguments: arguments),
                mockScenario: Self.mockScenario(from: requestedScenario)
            )
        default:
            self.init(mode: .bundled, sourceRoot: nil, mockScenario: nil)
        }
    }

    private static func configurationValue(
        named name: String,
        environmentKey: String,
        environment: [String: String],
        arguments: [String]
    ) -> String? {
        let prefix = "--railgunx-\(name)="
        return arguments.first(where: { $0.hasPrefix(prefix) }).map {
            String($0.dropFirst(prefix.count))
        } ?? environment[environmentKey]
    }

    private static func sourceRoot(environment: [String: String], arguments: [String]) -> URL? {
        resolveSourceRoot(
            at: configurationValue(
                named: "source-root",
                environmentKey: "RAILGUNX_SOURCE_ROOT",
                environment: environment,
                arguments: arguments
            )
        )
    }

    private static func mockScenario(from value: String?) -> String {
        guard let scenario = value?.trimmingCharacters(in: .whitespacesAndNewlines), !scenario.isEmpty else {
            return defaultMockScenario
        }

        return scenario
    }

    private static func resolveSourceRoot(at location: String?) -> URL? {
        guard let location, !location.isEmpty else {
            return nil
        }

        let locationURL = URL(fileURLWithPath: location).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: locationURL.path, isDirectory: &isDirectory) else {
            return nil
        }

        if isDirectory.boolValue {
            return locationURL
        }

        guard let markerContents = try? String(contentsOf: locationURL, encoding: .utf8) else {
            return nil
        }

        let sourceRootPath = markerContents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sourceRootPath.isEmpty else {
            return nil
        }

        let sourceRootURL = URL(fileURLWithPath: sourceRootPath).standardizedFileURL
        return FileManager.default.fileExists(atPath: sourceRootURL.path, isDirectory: &isDirectory)
            && isDirectory.boolValue
            ? sourceRootURL
            : nil
    }

    func desktopRPCLaunch(resourcesDirectory: URL) -> BackendProcessLaunch? {
        switch mode {
        case .bundled:
            return RailgunBundledBackendLaunchFactory(resourcesDirectory: resourcesDirectory).desktopRPCLaunch()
        case .source:
            guard let sourceRoot else { return nil }
            return sourceLaunch(
                root: sourceRoot,
                script: sourceRoot.appendingPathComponent("dist/backend.js"),
                arguments: ["desktop"],
                resourcesDirectory: resourcesDirectory
            )
        case .mock:
            guard let sourceRoot, let mockScenario else { return nil }
            return sourceLaunch(
                root: sourceRoot,
                script: sourceRoot.appendingPathComponent("apps/desktop/backend/mock-backend.cjs"),
                arguments: [mockScenario],
                resourcesDirectory: resourcesDirectory
            )
        }
    }

    private func sourceLaunch(
        root: URL,
        script: URL,
        arguments: [String],
        resourcesDirectory: URL
    ) -> BackendProcessLaunch? {
        guard FileManager.default.fileExists(atPath: script.path) else { return nil }

        let bundledNode = resourcesDirectory.appendingPathComponent("backend/node/bin/node")
        let executableURL: URL
        let launchArguments: [String]
        if FileManager.default.isExecutableFile(atPath: bundledNode.path) {
            executableURL = bundledNode
            launchArguments = [script.path] + arguments
        } else {
            let environmentExecutable = URL(fileURLWithPath: "/usr/bin/env")
            guard FileManager.default.isExecutableFile(atPath: environmentExecutable.path) else {
                return nil
            }
            executableURL = environmentExecutable
            launchArguments = ["node", script.path] + arguments
        }

        var environment = ProcessInfo.processInfo.environment
        environment["RAILGUN_DESKTOP_RPC"] = "1"
        return BackendProcessLaunch(
            executableURL: executableURL,
            arguments: launchArguments,
            currentDirectoryURL: root,
            environment: environment
        )
    }
}

/// Owns a stream-consumption task so it can be cancelled safely even when the
/// runtime is released off the main actor during teardown.
private final class RailgunEventObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    func install(_ task: Task<Void, Never>) {
        lock.lock()
        precondition(self.task == nil, "A stream observation can only be installed once")
        self.task = task
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        let activeTask = task
        task = nil
        lock.unlock()
        activeTask?.cancel()
    }

    deinit {
        cancel()
    }
}

@MainActor
@Observable
final class RailgunBackendRuntime {
    let sessionCoordinator: RailgunSessionCoordinator
    let promptCoordinator: RailgunPromptCoordinator
    let interactionCoordinator: RailgunInteractionCoordinator
    let controlsCoordinator: RailgunControlsCoordinator
    let compactionCoordinator: RailgunCompactionCoordinator

    private let client: RailgunRPCClient
    private let launch: BackendProcessLaunch?
    private let store: RailgunAppStore
    private var isConnectionAttemptInFlight = false
    private nonisolated let terminationObservationTask: Task<Void, Never>
    private nonisolated let eventObservation = RailgunEventObservation()
    private nonisolated let interactionObservation = RailgunEventObservation()

    init(
        configuration: BackendLaunchConfiguration,
        store: RailgunAppStore,
        resourcesDirectory: URL = Bundle.main.resourceURL ?? URL(fileURLWithPath: "/")
    ) {
        let client = RailgunRPCClient()
        self.client = client
        self.store = store
        self.launch = configuration.desktopRPCLaunch(resourcesDirectory: resourcesDirectory)
        let controlsCoordinator = RailgunControlsCoordinator(
            store: store,
            service: RailgunControlsService(rpcClient: client)
        )
        self.controlsCoordinator = controlsCoordinator
        self.compactionCoordinator = RailgunCompactionCoordinator(
            store: store,
            service: RailgunCompactionService(rpcClient: client)
        )
        let sessionCoordinator = RailgunSessionCoordinator(
            store: store,
            service: RailgunSessionService(rpcClient: client),
            controlsDidActivate: { [weak controlsCoordinator] in await controlsCoordinator?.refresh() }
        )
        self.sessionCoordinator = sessionCoordinator
        controlsCoordinator.setModelDidChange { [weak sessionCoordinator] modelID in
            await sessionCoordinator?.refreshAfterModelChange(modelID: modelID)
        }
        self.promptCoordinator = RailgunPromptCoordinator(
            store: store,
            service: RailgunPromptService(rpcClient: client)
        )
        self.interactionCoordinator = RailgunInteractionCoordinator(
            store: store,
            service: RailgunInteractionService(rpcClient: client)
        )
        terminationObservationTask = Task { @MainActor [weak store, client] in
            for await _ in client.unexpectedTerminations {
                guard let store else { return }
                guard case .ready = store.state.backend.phase else { continue }
                store.send(.backend(.disconnected(message: "The connection to the backend was lost.")))
            }
        }
        // These client streams span process generations. Keep exactly one
        // consumer for the runtime lifetime so restart cannot terminate them.
        observeEvents()
        observeInteractions()
    }

    deinit {
        terminationObservationTask.cancel()
        eventObservation.cancel()
        interactionObservation.cancel()
    }

    func start() async {
        await connect(restarting: false)
    }

    /// Establishes a fresh backend generation after an unavailable,
    /// authentication, or disconnect state. The runtime intentionally never
    /// replays a failed prompt: recovery only restores the backend and its
    /// authoritative task metadata.
    func restart() async {
        await connect(restarting: true)
    }

    private func connect(restarting: Bool) async {
        guard !isConnectionAttemptInFlight else { return }
        guard let launch else {
            store.send(.backend(.failed(message: "The selected backend could not be launched.")))
            return
        }
        isConnectionAttemptInFlight = true
        defer { isConnectionAttemptInFlight = false }

        store.send(.backend(.starting))
        do {
            let handshake = try await (restarting ? client.restart(launch) : client.start(launch))
            store.send(.backend(.ready(capabilities: handshake.capabilities)))
            async let controls: Void = controlsCoordinator.refresh()
            async let sessions: Void = sessionCoordinator.refresh()
            _ = await (controls, sessions)
        } catch let error as RailgunRPCError {
            if case let .authenticationRequired(source) = error {
                store.send(.backend(.authenticationRequired(source: source)))
            } else {
                store.send(.backend(.failed(message: "The backend could not be started.")))
            }
        } catch {
            store.send(.backend(.failed(message: "The backend could not be started.")))
        }
    }

    func shutdown() async {
        await client.shutdown()
    }

    func handle(_ event: RailgunAgentEvent) async {
        store.send(.agentEvent(event))
        guard event == .sessionSaved else { return }
        await sessionCoordinator.refresh()
    }

    private func observeEvents() {
        let task = Task { @MainActor [weak self, client] in
            for await event in client.events {
                guard !Task.isCancelled, let self else { return }
                await self.handle(event)
            }
        }
        eventObservation.install(task)
    }

    private func observeInteractions() {
        let task = Task { @MainActor [weak self, client] in
            for await interaction in client.interactions {
                guard !Task.isCancelled, let self else { return }
                guard self.store.state.transcript.isRunning else { continue }
                self.store.send(.interaction(.received(interaction)))
            }
        }
        interactionObservation.install(task)
    }
}

@MainActor
@Observable
final class DesktopClientStartup {
    enum Status: Equatable {
        case acquiring
        case ready
        case conflict(DesktopClientLockRecord)
        case unavailable
    }

    private let lock: DesktopClientLock?
    private var didAcquire = false
    private(set) var status: Status

    init(
        backendConfiguration: BackendLaunchConfiguration,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) {
        // Mock runs are deterministic test and preview infrastructure. They do
        // not touch the user's shared data or participate in its real lock.
        guard backendConfiguration.mode != .mock else {
            self.lock = nil
            self.status = .ready
            return
        }

        self.lock = DesktopClientLock(
            directory: homeDirectory.appendingPathComponent(".railgun", isDirectory: true)
        )
        self.status = .acquiring
    }

    func acquire() async {
        guard !didAcquire, let lock else { return }
        didAcquire = true
        do {
            _ = try await lock.acquire()
            status = .ready
        } catch let error as DesktopClientLockError {
            switch error {
            case let .conflict(record):
                status = .conflict(record)
            case .invalidExistingLock, .filesystem:
                status = .unavailable
            }
        } catch {
            status = .unavailable
        }
    }

    func release() async {
        await lock?.release()
    }
}

enum RailgunTaskDetailPresentation: Equatable {
    case loading
    case empty
    case selectionRequired
    case selected(RailgunSessionSummary)
    case staleSelection(String)

    init(session: RailgunSessionState) {
        if session.isLoading {
            self = .loading
        } else if let activeSessionID = session.activeSessionID {
            self = session.selectedSession.map(Self.selected) ?? .staleSelection(activeSessionID)
        } else if session.sessions.isEmpty {
            self = .empty
        } else {
            self = .selectionRequired
        }
    }

    var displaysTranscriptMessages: Bool {
        guard case .selected = self else { return false }
        return true
    }
}

struct RailgunSessionOperationErrorPresentation: Equatable {
    let message: String

    init?(session: RailgunSessionState) {
        guard let message = session.error else { return nil }
        self.message = message
    }
}

struct RailgunBackendAvailability: Equatable {
    let canRetry: Bool

    init(canRetry: Bool) {
        self.canRetry = canRetry
    }

    init(phase: RailgunBackendPhase) {
        switch phase {
        case .starting, .ready:
            canRetry = false
        case .authenticationRequired, .failed, .disconnected:
            canRetry = true
        }
    }
}

enum RailgunBackendPresentation: Equatable {
    case starting
    case ready
    case authenticationRequired(title: String, message: String)
    case unavailable(title: String, message: String, systemImage: String, retryTitle: String)

    init(phase: RailgunBackendPhase) {
        switch phase {
        case .starting:
            self = .starting
        case .ready:
            self = .ready
        case let .authenticationRequired(source):
            self = .authenticationRequired(
                title: "Authentication Required",
                message: Self.authenticationMessage(for: source)
            )
        case let .failed(message):
            self = .unavailable(
                title: "Backend Unavailable",
                message: message,
                systemImage: "exclamationmark.triangle.fill",
                retryTitle: "Retry"
            )
        case let .disconnected(message):
            self = .unavailable(
                title: "Backend Disconnected",
                message: message,
                systemImage: "bolt.horizontal.circle",
                retryTitle: "Restart"
            )
        }
    }

    private static func authenticationMessage(for source: RailgunRPCCredentialSource) -> String {
        switch source {
        case .file:
            "Sign in with your provider outside Railgun, then retry. Provider sign-in is coming in a later milestone."
        case .environment:
            "Update DEVIN_TOKEN in the environment that launches Railgun, then relaunch Railgun."
        }
    }
}

struct RailgunContextUsagePresentation: Equatable {
    let text: String
    let accessibilityLabel: String

    init(usage: RailgunContextUsage?, activeModel: RailgunModel?) {
        guard let usage, let activeModel, activeModel.contextWindow > 0 else {
            text = "Not measured yet"
            accessibilityLabel = "Context usage not measured yet"
            return
        }

        let used = usage.totalTokens
        let window = activeModel.contextWindow
        let percentage = used * 100 / window
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        let usedText = formatter.string(from: used as NSNumber) ?? "\(used)"
        let windowText = formatter.string(from: window as NSNumber) ?? "\(window)"
        text = "\(usedText) / \(windowText) tokens (\(percentage)%)"
        accessibilityLabel = "Latest provider-reported input plus output tokens: \(usedText) of \(windowText) tokens, \(percentage) percent"
    }
}

private enum RailgunTaskSymbol {
    static let activity = "rectangle.3.group"
}

enum RailgunActivityPanePresentation: Equatable {
    case docked
    case floating
}

enum RailgunActivityPaneLayout {
    static let dockedMinimumDetailWidth: CGFloat = 900

    static func presentation(for detailWidth: CGFloat) -> RailgunActivityPanePresentation {
        detailWidth >= dockedMinimumDetailWidth ? .docked : .floating
    }
}

private struct RailgunTranscriptSoftTopEdgeEffect: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
#if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content
        }
#else
        content
#endif
    }
}

private enum RailgunInteractionFocus: Hashable {
    case approvalDeny(String)
    case clarificationAnswer(String)
    case clarificationChoices(String)

    var requestID: String {
        switch self {
        case let .approvalDeny(id), let .clarificationAnswer(id), let .clarificationChoices(id):
            id
        }
    }
}

struct RailgunTaskShell: View {
    static let activityCardDefaultVisibility = false
    static let activityPanelMargin = RailgunSpacing.standard.points
    static let activityPanelPreferredWidth: CGFloat = 320
    static let activityPanelReservedWidth: CGFloat = 376
    static let activityPopoverHeight: CGFloat = 360
    static let sidebarMinimumWidth: CGFloat = 180
    /// Matches the Electron chat's 46-rem content column at the 16-point base size.
    static let composerMaximumWidth: CGFloat = 736

    static func isArchiveActionDisabled(for session: RailgunSessionState) -> Bool {
        session.selectedSession?.isPersisted != true
    }

    @Bindable private var appStore: RailgunAppStore
    private let sessionCoordinator: RailgunSessionCoordinator
    private let promptCoordinator: RailgunPromptCoordinator
    private let interactionCoordinator: RailgunInteractionCoordinator
    private let controlsCoordinator: RailgunControlsCoordinator
    private let compactionCoordinator: RailgunCompactionCoordinator
    @State private var detailViewportWidth: CGFloat = 0
    @State private var composerDraft = ""
    @State private var isComposerFocused = false
    @State private var composerHeight = RailgunComposer.minimumHeight()
    @State private var isComposerSubmissionInFlight = false
    @State private var pendingBranchMessage: RailgunTranscriptMessage?
    @State private var isBranchInFlight = false
    @FocusState private var interactionFocus: RailgunInteractionFocus?
    @SceneStorage("railgun.task.activityCard.isPresented")
    private var isActivityCardVisible = activityCardDefaultVisibility

    init(
        appStore: RailgunAppStore,
        sessionCoordinator: RailgunSessionCoordinator,
        promptCoordinator: RailgunPromptCoordinator,
        interactionCoordinator: RailgunInteractionCoordinator,
        controlsCoordinator: RailgunControlsCoordinator,
        compactionCoordinator: RailgunCompactionCoordinator
    ) {
        _appStore = Bindable(appStore)
        self.sessionCoordinator = sessionCoordinator
        self.promptCoordinator = promptCoordinator
        self.interactionCoordinator = interactionCoordinator
        self.controlsCoordinator = controlsCoordinator
        self.compactionCoordinator = compactionCoordinator
    }

    var body: some View {
        NavigationSplitView {
            RailgunTaskSidebar(
                session: appStore.state.session,
                selection: selectedSessionID,
                activity: presentedActivity,
                isActivityAvailable: isActivityAvailable,
                isActivityCardVisible: $isActivityCardVisible,
                isFloatingActivityPresented: isFloatingActivityPresented,
                isSessionSelectionDisabled: isTaskControlLocked
            )
            .navigationSplitViewColumnWidth(min: Self.sidebarMinimumWidth, ideal: 240)
        } detail: {
            VStack(spacing: 0) {
                transcriptScrollView
                composerArea
            }
                .background {
                    GeometryReader { geometry in
                        Color.clear
                            .onAppear {
                                detailViewportWidth = geometry.size.width
                            }
                            .onChange(of: geometry.size.width) { _, width in
                                detailViewportWidth = width
                            }
                    }
                }
                .toolbar {
#if compiler(>=6.2)
                    if #available(macOS 26.0, *) {
                        ToolbarSpacer(.flexible)
                    } else {
                        ToolbarItem {
                            Spacer()
                        }
                    }
#else
                    ToolbarItem {
                        Spacer()
                    }
#endif

                    ToolbarItemGroup(placement: .automatic) {
                        modelControlsMenu
                        agentControlsMenu
                        Button {
                            createTask()
                        } label: {
                            Label("New Task", systemImage: "square.and.pencil")
                        }
                        .disabled(!commandAvailability.canCreateTask)
                        Button(role: .destructive) {
                            guard let sessionID = appStore.state.session.activeSessionID else { return }
                            Task { await sessionCoordinator.archive(sessionID) }
                        } label: {
                            Label("Archive Task", systemImage: "archivebox")
                        }
                        .disabled(Self.isArchiveActionDisabled(for: appStore.state.session) || isTaskControlLocked)
                    }
                }
        }
        .toolbarRole(.editor)
        .focusedSceneValue(
            \.railgunTaskCommandActions,
            RailgunTaskCommandActions(
                availability: commandAvailability,
                createTask: createTask,
                stop: requestStop,
                retry: retryComposerSubmission
            )
        )
        .onChange(of: appStore.state.interactions.requests) { previous, current in
            handleInteractionFocusChange(from: previous, to: current)
        }
        .confirmationDialog(
            "Branch from this message?",
            isPresented: isBranchConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button("Branch Here", role: .destructive) {
                confirmBranch()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Later messages will move to the abandoned branch.")
        }
    }

    private var commandAvailability: RailgunTaskCommandAvailability {
        .init(
            canCreateTask: Self.canCreateTask(
                session: appStore.state.session,
                controls: appStore.state.controls
            ),
            canStop: appStore.state.transcript.isRunning && !appStore.state.transcript.isStopping,
            canRetry: canRetryComposerSubmission
        )
    }

    static func canCreateTask(session: RailgunSessionState, controls: RailgunControlsState) -> Bool {
        !session.isLoading && !controls.compactionStatus.isInProgress
    }

    static func controlsAreDisabled(_ controls: RailgunControlsState, isRunActive: Bool) -> Bool {
        !controls.isReadyForMutation || isRunActive
    }

    private var controlsAreDisabled: Bool {
        Self.controlsAreDisabled(
            appStore.state.controls,
            isRunActive: appStore.state.transcript.isRunning
        )
    }

    private var isTaskControlLocked: Bool {
        appStore.state.controls.compactionStatus.isInProgress
    }

    static func isCompactionDisabled(
        _ controls: RailgunControlsState,
        isRunActive: Bool,
        hasTranscript: Bool
    ) -> Bool {
        !controls.isReadyForMutation || isRunActive || !hasTranscript
    }

    private var isCompactionDisabled: Bool {
        Self.isCompactionDisabled(
            appStore.state.controls,
            isRunActive: appStore.state.transcript.isRunning,
            hasTranscript: !appStore.state.transcript.messages.isEmpty
        )
    }

    @ViewBuilder
    private var modelControlsMenu: some View {
        Menu {
            ForEach(appStore.state.controls.models) { model in
                Button {
                    Task { await controlsCoordinator.useModel(model.id) }
                } label: {
                    selectionLabel(model.name, isSelected: appStore.state.controls.activeModelID == model.id)
                }
            }
        } label: {
            Label("Model", systemImage: "cpu")
        }
        .disabled(controlsAreDisabled)
        .accessibilityIdentifier("task-model-menu")
    }

    @ViewBuilder
    private var agentControlsMenu: some View {
        Menu {
            Menu("Mixture of Agents") {
                Button {
                    Task { await controlsCoordinator.selectMoAPreset(nil) }
                } label: {
                    selectionLabel("Off", isSelected: appStore.state.controls.activeMoAPresetName == nil)
                }
                ForEach(appStore.state.controls.moaPresets) { preset in
                    Button {
                        Task { await controlsCoordinator.selectMoAPreset(preset.name) }
                    } label: {
                        selectionLabel(
                            preset.name,
                            isSelected: appStore.state.controls.activeMoAPresetName == preset.name
                        )
                    }
                }
            }

            Divider()

            Toggle("Enable Advisor", isOn: advisorEnabledBinding)

            Menu("Advisor Model") {
                ForEach(appStore.state.controls.models) { model in
                    Button {
                        Task {
                            await controlsCoordinator.configureAdvisor(.init(
                                isEnabled: appStore.state.controls.advisor.isEnabled,
                                modelID: model.id
                            ))
                        }
                    } label: {
                        selectionLabel(
                            model.name,
                            isSelected: appStore.state.controls.advisor.modelID == model.id
                        )
                    }
                }
            }

            Divider()

            Button {
                Task { await compactionCoordinator.compact() }
            } label: {
                Label(
                    appStore.state.controls.compactionStatus.isInProgress
                        ? "Compacting context…"
                        : "Compact Context",
                    systemImage: "arrow.triangle.2.circlepath"
                )
            }
            .disabled(isCompactionDisabled)
        } label: {
            Label("Agents", systemImage: "person.2")
        }
        .disabled(controlsAreDisabled)
        .accessibilityIdentifier("task-agent-menu")
    }

    private var advisorEnabledBinding: Binding<Bool> {
        Binding(
            get: { appStore.state.controls.advisor.isEnabled },
            set: { isEnabled in
                guard let modelID = appStore.state.controls.advisor.modelID
                    ?? appStore.state.controls.activeModelID
                else { return }
                Task {
                    await controlsCoordinator.configureAdvisor(.init(isEnabled: isEnabled, modelID: modelID))
                }
            }
        )
    }

    @ViewBuilder
    private func selectionLabel(_ title: String, isSelected: Bool) -> some View {
        if isSelected {
            Label(title, systemImage: "checkmark")
        } else {
            Text(title)
        }
    }

    private func createTask() {
        guard commandAvailability.canCreateTask else { return }
        Task { await sessionCoordinator.create(modelID: appStore.state.controls.activeModelID) }
    }

    private var selectedSessionID: Binding<String?> {
        Binding(
            get: { appStore.state.session.activeSessionID },
            set: { selection in
                guard let selection else {
                    appStore.send(.session(.selected(nil)))
                    return
                }
                Task { await sessionCoordinator.resume(selection) }
            }
        )
    }

    private var taskDetailPresentation: RailgunTaskDetailPresentation {
        RailgunTaskDetailPresentation(session: appStore.state.session)
    }

    private var presentedTranscriptMessages: [RailgunTranscriptMessage] {
        guard taskDetailPresentation.displaysTranscriptMessages else { return [] }
        return RailgunTranscriptOrdering.orderedMessages(in: appStore.state.transcript)
    }

    private var presentedActivity: RailgunActivityState {
        RailgunTranscriptActivityPresentation.activity(
            for: taskDetailPresentation,
            from: appStore.state.activity
        )
    }

    private var hasScrollableTranscript: Bool {
        !presentedTranscriptMessages.isEmpty || !presentedActivity.entries.isEmpty
    }

    private var isBranchConfirmationPresented: Binding<Bool> {
        Binding(
            get: { pendingBranchMessage != nil },
            set: { isPresented in
                if !isPresented {
                    pendingBranchMessage = nil
                }
            }
        )
    }

    private func isBranchAvailable(for message: RailgunTranscriptMessage) -> Bool {
        RailgunBranchAffordance.isAvailable(
            for: message,
            in: presentedTranscriptMessages,
            session: appStore.state.session,
            isRunActive: appStore.state.transcript.isRunning,
            isTaskLocked: isTaskControlLocked,
            isBranchInFlight: isBranchInFlight
        )
    }

    private func requestBranch(from message: RailgunTranscriptMessage) {
        guard isBranchAvailable(for: message) else { return }
        pendingBranchMessage = message
    }

    private func confirmBranch() {
        guard let pendingBranchMessage,
              presentedTranscriptMessages.contains(pendingBranchMessage),
              isBranchAvailable(for: pendingBranchMessage),
              let messageID = pendingBranchMessage.messageID,
              !isBranchInFlight
        else { return }
        pendingBranchMessage = nil
        isBranchInFlight = true
        Task {
            await sessionCoordinator.branch(messageID: messageID)
            isBranchInFlight = false
        }
    }

    private var isActivityAvailable: Bool {
        RailgunActivityDashboardPresentation(activity: presentedActivity).isVisible
    }

    private var activityPanePresentation: RailgunActivityPanePresentation {
        RailgunActivityPaneLayout.presentation(for: detailViewportWidth)
    }

    private var isActivityPanelDocked: Bool {
        isActivityAvailable && isActivityCardVisible && activityPanePresentation == .docked
    }

    private var activityReservedContentWidth: CGFloat {
        isActivityPanelDocked ? Self.activityPanelReservedWidth : 0
    }

    private var isFloatingActivityPresented: Binding<Bool> {
        Binding(
            get: {
                isActivityAvailable && isActivityCardVisible && activityPanePresentation == .floating
            },
            set: { isPresented in
                guard !isPresented, activityPanePresentation == .floating else { return }
                isActivityCardVisible = false
            }
        )
    }

    private var taskDetailStateOverlay: some View {
        ZStack(alignment: .top) {
            taskDetailStateContent

            if let error = RailgunSessionOperationErrorPresentation(
                session: appStore.state.session
            ) {
                sessionOperationErrorBanner(error)
            }
        }
    }

    @ViewBuilder
    private var taskDetailStateContent: some View {
        switch taskDetailPresentation {
        case .loading:
            ProgressView("Loading tasks…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No Tasks Yet",
                systemImage: "text.badge.plus",
                description: Text("Create and restore tasks in a later Task milestone.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .selectionRequired:
            ContentUnavailableView(
                "Select a Task",
                systemImage: "sidebar.leading",
                description: Text("Choose a task from the sidebar to continue.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .selected:
            if presentedTranscriptMessages.isEmpty && presentedActivity.entries.isEmpty {
                ContentUnavailableView(
                    "No Messages Yet",
                    systemImage: "text.bubble",
                    description: Text("Messages for this task will appear here.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                EmptyView()
            }
        case .staleSelection:
            ContentUnavailableView(
                "Task Unavailable",
                systemImage: "exclamationmark.triangle",
                description: Text("The selected task is no longer available.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func sessionOperationErrorBanner(
        _ presentation: RailgunSessionOperationErrorPresentation
    ) -> some View {
        Label(presentation.message, systemImage: "exclamationmark.triangle.fill")
            .font(RailgunFont.interface(.callout))
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(RailgunSpacing.relaxed.points)
            .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal, RailgunSpacing.layout.points)
            .padding(.top, RailgunSpacing.layout.points)
            .accessibilityIdentifier("session-operation-error")
    }

    private var composerArea: some View {
        VStack(spacing: 0) {
            Divider()
            composerContent
        }
        .background(.bar)
    }

    private var composerContent: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            interactionPrompts
            queuedMessageAcknowledgements
            taskControlsStatus
            composerSurface
            composerSubmissionError
            composerKeyboardHint
        }
        .padding(RailgunSpacing.standard.points)
        .frame(maxWidth: Self.composerMaximumWidth, alignment: .leading)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var taskControlsStatus: some View {
        switch appStore.state.controls.compactionStatus {
        case .inProgress:
            ProgressView("Compacting context…")
                .controlSize(.small)
                .font(RailgunFont.interface(.caption))
                .accessibilityIdentifier("context-compaction-progress")
        case .completed:
            Label(
                "Compacted conversation history to stay under the context limit.",
                systemImage: "checkmark.circle.fill"
            )
            .font(RailgunFont.interface(.caption))
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("context-compaction-completed")
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(RailgunFont.interface(.caption))
                .foregroundStyle(.orange)
                .accessibilityIdentifier("context-compaction-error")
        case .unavailable:
            if let error = appStore.state.controls.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("task-controls-error")
            } else if appStore.state.controls.isLoading {
                ProgressView("Loading task controls…")
                    .controlSize(.small)
                    .font(RailgunFont.interface(.caption))
                    .accessibilityIdentifier("task-controls-loading")
            }
        }
    }

    @ViewBuilder
    private var interactionPrompts: some View {
        ForEach(appStore.state.interactions.requests) { request in
            switch request.kind {
            case .approval:
                approvalPrompt(request)
            case .clarification:
                clarificationPrompt(request)
            }
        }
    }

    private func approvalPrompt(_ request: RailgunInteractionRequest) -> some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            Text("Approval Required")
                .font(RailgunFont.interface(.headline))
            Text("Allow this command to run?")
                .foregroundStyle(.secondary)
            Text(request.command ?? "")
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(RailgunSpacing.compact.points)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                .accessibilityLabel("Command preview")
                .accessibilityIdentifier("interaction-command-preview-\(request.id)")
            interactionStatus(request)
            HStack {
                Button("Deny", role: .destructive) {
                    respondToApproval(request.id, approved: false)
                }
                .focused($interactionFocus, equals: .approvalDeny(request.id))
                .onKeyPress(.escape) {
                    respondToApproval(request.id, approved: false)
                    return .handled
                }
                .disabled(request.isSubmitting)
                .accessibilityLabel("Deny command")
                .accessibilityIdentifier("interaction-deny-\(request.id)")

                Button("Allow") {
                    respondToApproval(request.id, approved: true)
                }
                .disabled(request.isSubmitting)
                .accessibilityLabel("Allow command")
                .accessibilityIdentifier("interaction-allow-\(request.id)")
            }
        }
        .padding(RailgunSpacing.standard.points)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Approval request")
        .accessibilityIdentifier("interaction-approval-\(request.id)")
    }

    private func clarificationPrompt(_ request: RailgunInteractionRequest) -> some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            Text("Clarification Required")
                .font(RailgunFont.interface(.headline))
            Text(request.question ?? "")
                .frame(maxWidth: .infinity, alignment: .leading)

            if let choices = request.choices, !choices.isEmpty {
                choiceClarificationControls(request, choices: choices)
            } else {
                freeTextClarificationControls(request)
            }
            interactionStatus(request)
        }
        .padding(RailgunSpacing.standard.points)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Clarification request")
        .accessibilityIdentifier("interaction-clarification-\(request.id)")
    }

    private func freeTextClarificationControls(_ request: RailgunInteractionRequest) -> some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            TextField("Answer", text: interactionAnswerBinding(for: request))
                .textFieldStyle(.roundedBorder)
                .focused($interactionFocus, equals: .clarificationAnswer(request.id))
                .disabled(request.isSubmitting)
                .onSubmit { submitClarification(request) }
                .onKeyPress(.escape) {
                    declineClarification(request.id)
                    return .handled
                }
                .accessibilityLabel("Clarification answer")
                .accessibilityIdentifier("interaction-answer-\(request.id)")
            clarificationActionRow(request)
        }
    }

    private func choiceClarificationControls(
        _ request: RailgunInteractionRequest,
        choices: [String]
    ) -> some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            Picker("Choices", selection: interactionAnswerBinding(for: request)) {
                ForEach(choices, id: \.self) { choice in
                    Text(choice).tag(choice)
                }
            }
            .pickerStyle(.radioGroup)
            .focused($interactionFocus, equals: .clarificationChoices(request.id))
            .disabled(request.isSubmitting)
            .onKeyPress(.upArrow) {
                moveChoice(for: request, choices: choices, by: -1)
                return .handled
            }
            .onKeyPress(.downArrow) {
                moveChoice(for: request, choices: choices, by: 1)
                return .handled
            }
            .onKeyPress(.return) {
                submitClarification(request)
                return .handled
            }
            .onKeyPress(.escape) {
                declineClarification(request.id)
                return .handled
            }
            .accessibilityLabel("Clarification choices")
            .accessibilityIdentifier("interaction-choices-\(request.id)")
            clarificationActionRow(request)
        }
    }

    private func clarificationActionRow(_ request: RailgunInteractionRequest) -> some View {
        HStack {
            Button("Decline", role: .destructive) {
                declineClarification(request.id)
            }
            .disabled(request.isSubmitting)
            .accessibilityLabel("Decline clarification")
            .accessibilityIdentifier("interaction-decline-\(request.id)")
            Button("Submit") {
                submitClarification(request)
            }
            .disabled(request.isSubmitting || !hasValidClarificationAnswer(request))
            .accessibilityLabel("Submit clarification")
            .accessibilityIdentifier("interaction-submit-\(request.id)")
        }
    }

    @ViewBuilder
    private func interactionStatus(_ request: RailgunInteractionRequest) -> some View {
        if request.isSubmitting {
            ProgressView("Submitting response")
                .controlSize(.small)
                .accessibilityIdentifier("interaction-progress-\(request.id)")
        }
        if let error = request.error {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .accessibilityLabel("Interaction error")
                .accessibilityIdentifier("interaction-error-\(request.id)")
        }
    }

    private func interactionAnswerBinding(for request: RailgunInteractionRequest) -> Binding<String> {
        Binding(
            get: {
                appStore.state.interactions.requests.first(where: { $0.id == request.id })?.answer ?? ""
            },
            set: { answer in
                appStore.send(.interaction(.answerChanged(id: request.id, answer: answer)))
            }
        )
    }

    private func hasValidClarificationAnswer(_ request: RailgunInteractionRequest) -> Bool {
        !request.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func respondToApproval(_ id: String, approved: Bool) {
        Task { await interactionCoordinator.respondToApproval(id: id, approved: approved) }
    }

    private func submitClarification(_ request: RailgunInteractionRequest) {
        guard hasValidClarificationAnswer(request) else { return }
        Task { await interactionCoordinator.respondToClarification(id: request.id, answer: request.answer) }
    }

    private func declineClarification(_ id: String) {
        Task {
            await interactionCoordinator.respondToClarification(
                id: id,
                answer: RailgunRPCClient.declinedClarificationAnswer
            )
        }
    }

    private func moveChoice(
        for request: RailgunInteractionRequest,
        choices: [String],
        by offset: Int
    ) {
        guard !request.isSubmitting,
              let currentIndex = choices.firstIndex(of: request.answer)
        else { return }
        let nextIndex = min(max(currentIndex + offset, 0), choices.count - 1)
        appStore.send(.interaction(.answerChanged(id: request.id, answer: choices[nextIndex])))
    }

    private func handleInteractionFocusChange(
        from previous: [RailgunInteractionRequest],
        to current: [RailgunInteractionRequest]
    ) {
        if current.isEmpty, !previous.isEmpty {
            interactionFocus = nil
            isComposerFocused = true
            return
        }
        if let interactionFocus,
           !current.contains(where: { $0.id == interactionFocus.requestID }),
           let request = current.last {
            focusInteraction(request)
            return
        }
        guard current.count > previous.count, let request = current.last else { return }
        focusInteraction(request)
    }

    private func focusInteraction(_ request: RailgunInteractionRequest) {
        isComposerFocused = false
        interactionFocus = switch request.kind {
        case .approval: .approvalDeny(request.id)
        case .clarification: request.choices?.isEmpty == false
            ? .clarificationChoices(request.id)
            : .clarificationAnswer(request.id)
        }
    }

    @ViewBuilder
    private var queuedMessageAcknowledgements: some View {
        if !appStore.state.transcript.queue.isEmpty {
            RailgunQueuedMessageAcknowledgements(queue: appStore.state.transcript.queue)
        }
    }

    @ViewBuilder
    private var composerSubmissionError: some View {
        if let error = appStore.state.transcript.submissionError {
            HStack(spacing: RailgunSpacing.standard.points) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(RailgunFont.interface(.callout))
                    .foregroundStyle(.red)
                Spacer(minLength: 0)
                Button("Retry", action: retryComposerSubmission)
                    .disabled(!canRetryComposerSubmission)
            }
            .accessibilityIdentifier("composer-submission-error")
        }
    }

    private var composerSurface: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.relaxed.points) {
            composerInput
            composerActionRow
        }
        .padding(RailgunSpacing.relaxed.points)
        .background(
            RailgunColorRole.surface.color,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    isComposerFocused ? Color.accentColor : Color.secondary.opacity(0.28),
                    lineWidth: isComposerFocused ? 1.5 : 1
                )
        }
        .shadow(color: .black.opacity(0.08), radius: 4, y: 1)
        .accessibilityIdentifier("task-composer-surface")
    }

    @ViewBuilder
    private var composerActionRow: some View {
        HStack(spacing: RailgunSpacing.standard.points) {
            if isComposerSubmissionInFlight {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Submitting message")
            }

            contextUsageFooter

            Spacer(minLength: 0)

            if appStore.state.transcript.isRunning {
                Button(role: .destructive, action: requestStop) {
                    Image(systemName: "stop.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!commandAvailability.canStop)
                .help("Stop task")
                .accessibilityLabel("Stop")
                .accessibilityIdentifier("task-composer-stop")
            } else {
                Button(action: submitDraftFromComposerAction) {
                    Label("Send", systemImage: "paperplane.fill")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!canSubmitComposerDraft)
                .help("Send task")
                .accessibilityIdentifier("task-composer-send")
            }
        }
    }

    private var contextUsageFooter: some View {
        let presentation = RailgunContextUsagePresentation(
            usage: appStore.state.controls.contextUsage,
            activeModel: appStore.state.controls.activeModel
        )
        return Text(presentation.text)
            .font(RailgunFont.interface(.caption))
            .foregroundStyle(.secondary)
            .help("Latest provider-reported input plus output tokens")
            .accessibilityLabel(presentation.accessibilityLabel)
            .accessibilityIdentifier("context-usage")
    }

    private var composerInput: some View {
        RailgunComposer(
            draft: $composerDraft,
            isFocused: $isComposerFocused,
            isEnabled: isComposerEnabled,
            placeholder: isComposerEnabled ? "Message Railgun…" : "Backend unavailable",
            reportedHeight: $composerHeight,
            onSubmit: submitComposerDraft,
            onEnqueue: followUpEnqueueHandler
        )
        .frame(height: composerHeight)
        .accessibilityIdentifier("task-composer")
    }

    private var followUpEnqueueHandler: ((String) -> Void)? {
        guard appStore.state.transcript.isRunning, !appStore.state.transcript.isStopping else { return nil }
        return enqueueFollowUp
    }

    private var composerKeyboardHint: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Text(
                appStore.state.transcript.isRunning
                    ? "Return steers · Tab queues follow-up · Shift-Return adds a line"
                    : "Return sends · Shift-Return adds a line"
            )
            .font(RailgunFont.interface(.caption))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, RailgunSpacing.relaxed.points)
            .padding(.vertical, RailgunSpacing.compact.points)
            .background(.thinMaterial, in: UnevenRoundedRectangle(
                topLeadingRadius: 0,
                bottomLeadingRadius: 8,
                bottomTrailingRadius: 8,
                topTrailingRadius: 0,
                style: .continuous
            ))
            .overlay {
                UnevenRoundedRectangle(
                    topLeadingRadius: 0,
                    bottomLeadingRadius: 8,
                    bottomTrailingRadius: 8,
                    topTrailingRadius: 0,
                    style: .continuous
                )
                .strokeBorder(Color.secondary.opacity(0.2))
            }
            Spacer(minLength: 0)
        }
        .padding(.top, -RailgunSpacing.compact.points)
        .accessibilityIdentifier("composer-keyboard-hint")
    }

    private var isComposerEnabled: Bool {
        !isComposerSubmissionInFlight
            && !appStore.state.transcript.isStopping
            && appStore.state.interactions.requests.isEmpty
            && !isTaskControlLocked
    }

    private var canSubmitComposerDraft: Bool {
        isComposerEnabled
            && !composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canRetryComposerSubmission: Bool {
        Self.canRetryComposerSubmission(
            transcript: appStore.state.transcript,
            isComposerEnabled: isComposerEnabled
        )
    }

    static func canRetryComposerSubmission(
        transcript: RailgunTranscriptState,
        isComposerEnabled: Bool
    ) -> Bool {
        guard isComposerEnabled else { return false }
        let hasRetryableStop = transcript.isRunning
            && !transcript.isStopping
            && transcript.failedStopMessage != nil
        return hasRetryableStop
            || transcript.failedRun != nil
            || transcript.failedQueue != nil
    }

    private func submitDraftFromComposerAction() {
        guard canSubmitComposerDraft else { return }
        submitComposerDraft(composerDraft)
    }

    private func requestStop() {
        guard commandAvailability.canStop else { return }
        Task { _ = await promptCoordinator.stop() }
    }

    private func submitComposerDraft(_ message: String) {
        guard isComposerEnabled else { return }
        isComposerSubmissionInFlight = true
        Task {
            let wasAccepted = await promptCoordinator.submit(message)
            finishComposerSubmission(wasAccepted, clearing: message)
        }
    }

    private func enqueueFollowUp(_ message: String) {
        guard isComposerEnabled else { return }
        isComposerSubmissionInFlight = true
        Task {
            let wasAccepted = await promptCoordinator.enqueue(message, kind: .followUp)
            finishComposerSubmission(wasAccepted, clearing: message)
        }
    }

    private func retryComposerSubmission() {
        if isStopFailure {
            requestStop()
            return
        }
        guard isComposerEnabled else { return }
        isComposerSubmissionInFlight = true
        let failedRun = appStore.state.transcript.failedRun
        let failedQueue = appStore.state.transcript.failedQueue
        Task {
            let wasAccepted: Bool
            if failedRun != nil {
                wasAccepted = await promptCoordinator.retry()
            } else if failedQueue != nil {
                wasAccepted = await promptCoordinator.retryQueue()
            } else {
                wasAccepted = false
            }
            finishComposerSubmission(wasAccepted, clearing: failedRun?.text ?? failedQueue?.text ?? "")
        }
    }

    private func finishComposerSubmission(_ wasAccepted: Bool, clearing submittedDraft: String) {
        if wasAccepted, composerDraft == submittedDraft {
            composerDraft = ""
        }
        isComposerSubmissionInFlight = false
    }

    private var isStopFailure: Bool {
        appStore.state.transcript.isRunning
            && !appStore.state.transcript.isStopping
            && appStore.state.transcript.failedStopMessage != nil
    }

    private var transcriptScrollView: some View {
        // Keep this ScrollView mounted and its native vertical scroller enabled
        // from the first layout. Indicator hiding or NSScrollView mutation breaks
        // the macOS 26 soft top-edge effect. See docs/native-ui-policy.md.
        RailgunTranscriptScrollView(
            sessionID: appStore.state.session.activeSessionID,
            contentRevision: RailgunTranscriptContentRevision(
                messages: presentedTranscriptMessages,
                activityEntries: presentedActivity.entries
            ),
            contentLeadingMargin: activityReservedContentWidth,
            hasScrollableContent: hasScrollableTranscript
        ) {
            LazyVStack(alignment: .center, spacing: RailgunSpacing.expanded.points) {
                RailgunTranscriptActivityViewport(
                    messages: presentedTranscriptMessages,
                    activity: presentedActivity,
                    isRunActive: appStore.state.transcript.isRunning,
                    isBranchAvailable: isBranchAvailable(for:),
                    branch: requestBranch(from:)
                )
            }
            .padding(.vertical, RailgunSpacing.layout.points)
            .padding(.leading, RailgunSpacing.expanded.points)
            .padding(.trailing, RailgunSpacing.layout.points)
        }
        .modifier(RailgunTranscriptSoftTopEdgeEffect())
        .overlay {
            taskDetailStateOverlay
                .padding(.leading, activityReservedContentWidth)
        }
        .overlay(alignment: .leading) {
            if isActivityPanelDocked {
                RailgunActivityPanel(activity: presentedActivity)
                .frame(minWidth: 280, idealWidth: Self.activityPanelPreferredWidth, maxWidth: 360)
                .padding(.vertical, Self.activityPanelMargin)
                .padding(.leading, Self.activityPanelMargin)
                .ignoresSafeArea(.container, edges: .top)
            }
        }
    }
}

private struct RailgunTaskSidebar: View {
    let session: RailgunSessionState
    let selection: Binding<String?>
    let activity: RailgunActivityState
    let isActivityAvailable: Bool
    let isActivityCardVisible: Binding<Bool>
    let isFloatingActivityPresented: Binding<Bool>
    let isSessionSelectionDisabled: Bool

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            if session.isLoading {
                ProgressView("Loading tasks…")
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if session.sessions.isEmpty {
                ContentUnavailableView(
                    "No Tasks",
                    systemImage: "tray",
                    description: Text("Tasks will appear here when they are available.")
                )
            } else {
                ForEach(session.sessions) { summary in
                    RailgunSidebarSessionRow(
                        summary: summary,
                        isSelected: selection.wrappedValue == summary.id,
                        select: { selection.wrappedValue = summary.id }
                    )
                    .disabled(isSessionSelectionDisabled)
                }
            }
            }
            .padding(RailgunSpacing.standard.points)
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                activityToggleButton
            }
        }
    }

    private var activityToggleButton: some View {
        Button {
            isActivityCardVisible.wrappedValue.toggle()
        } label: {
            Label("Activity", systemImage: RailgunTaskSymbol.activity)
                .labelStyle(.iconOnly)
        }
        .help(
            !isActivityAvailable
                ? "No activity yet"
                : isActivityCardVisible.wrappedValue
                ? "Hide Activity"
                : "Show Activity"
        )
        .disabled(!isActivityAvailable)
        .accessibilityIdentifier("toggle-activity")
        .popover(
            isPresented: isFloatingActivityPresented,
            arrowEdge: .leading
        ) {
            RailgunActivityPanel(
                activity: activity,
                displaysPanelBackground: false
            )
            .frame(width: RailgunTaskShell.activityPanelPreferredWidth, height: RailgunTaskShell.activityPopoverHeight)
            .padding(RailgunSpacing.standard.points)
        }
    }
}

private struct RailgunQueuedMessageAcknowledgements: View {
    let queue: [RailgunQueuedMessage]

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            ForEach(queue) { item in
                HStack(alignment: .firstTextBaseline, spacing: RailgunSpacing.compact.points) {
                    Text(item.kind == .steering ? "Steering" : "Follow-up")
                        .font(RailgunFont.interface(.caption, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(item.text)
                        .font(RailgunFont.interface(.callout))
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    ProgressView()
                        .controlSize(.mini)
                }
                .padding(.horizontal, RailgunSpacing.standard.points)
                .padding(.vertical, RailgunSpacing.compact.points)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("queued-message-\(item.id)")
            }
        }
        .accessibilityIdentifier("queued-message-acknowledgements")
    }
}

private struct RailgunSidebarSessionRow: View {
    let summary: RailgunSessionSummary
    let isSelected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
                Text(summary.displayTitle)
                    .lineLimit(1)
                Text("\(summary.model) • \(summary.startedAt)")
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(
                        isSelected ? Color.white.opacity(0.8) : RailgunColorRole.secondaryText.color
                    )
                    .lineLimit(1)
            }
            .foregroundStyle(
                isSelected ? Color.white : RailgunColorRole.primaryText.color
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, RailgunSpacing.standard.points)
            .padding(.vertical, RailgunSpacing.relaxed.points)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .background(
            isSelected ? RailgunColorRole.accent.color : .clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityValue(isSelected ? "Selected" : "")
    }
}

private struct RailgunActivityPanel: View {
    let activity: RailgunActivityState
    var displaysPanelBackground = true

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.section.points) {
            Text("Activity")
                .font(RailgunFont.interface(.title2, weight: .bold))

            RailgunActivityDashboard(activity: activity)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(RailgunSpacing.section.points)
        .frame(maxHeight: .infinity, alignment: .top)
        .modifier(RailgunActivityPanelBackground(isEnabled: displaysPanelBackground))
        .font(RailgunFont.interface())
    }
}

private struct RailgunActivityPanelBackground: ViewModifier {
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
#if compiler(>=6.2)
        if !isEnabled {
            content
        } else if #available(macOS 26.0, *) {
            content.glassEffect(
                .regular,
                in: RoundedRectangle(cornerRadius: 32, style: .continuous)
            )
        } else {
            fallbackBackground(content: content)
        }
#else
        if !isEnabled {
            content
        } else {
            fallbackBackground(content: content)
        }
#endif
    }

    private func fallbackBackground(content: Content) -> some View {
        content
            .background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: 32, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 32, style: .continuous)
                    .stroke(.separator.opacity(0.2), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.06), radius: 12, y: 6)
    }
}

private struct RailgunBackendStatusView: View {
    let title: String
    let message: String
    let systemImage: String
    let retryTitle: String
    let canRetry: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: RailgunSpacing.section.points) {
            ContentUnavailableView(
                title,
                systemImage: systemImage,
                description: Text(message)
            )
            Button(retryTitle, action: retry)
                .disabled(!canRetry)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .focusedSceneValue(
            \.railgunTaskCommandActions,
            RailgunTaskCommandActions(
                availability: .init(canCreateTask: false, canStop: false, canRetry: canRetry),
                createTask: {},
                stop: {},
                retry: retry
            )
        )
    }
}

private struct RailgunSettingsView: View {
    @Bindable private var appStore: RailgunAppStore
    private let sessionCoordinator: RailgunSessionCoordinator

    init(appStore: RailgunAppStore, sessionCoordinator: RailgunSessionCoordinator) {
        _appStore = Bindable(appStore)
        self.sessionCoordinator = sessionCoordinator
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.section.points) {
            Text("Archived Tasks")
                .font(RailgunFont.interface(.title2, weight: .semibold))

            RailgunArchivedTaskBrowser(
                session: appStore.state.session,
                backendPhase: appStore.state.backend.phase,
                restore: { sessionID in
                    Task { await sessionCoordinator.restore(sessionID) }
                }
            )
            .font(RailgunFont.interface())
        }
        .padding(RailgunSpacing.layout.points)
        .frame(minWidth: 520, minHeight: 360)
    }
}

@main
struct RailgunXApp: App {
    static let lifecycleConfiguration = AppLifecycleConfiguration.primary

    @State private var desktopClientStartup: DesktopClientStartup
    // SWFT-024 observes this app-scoped store so scene lifecycle changes do
    // not recreate feature state.
    @State private var appStore = RailgunAppStore()
    @State private var backendRuntime: RailgunBackendRuntime
    private let updater: RailgunUpdater?

    init() {
        RailgunFont.registerBundledFonts()
        let backendLaunchConfiguration = BackendLaunchConfiguration()
        let appStore = RailgunAppStore()
        _appStore = State(initialValue: appStore)
        _desktopClientStartup = State(
            initialValue: DesktopClientStartup(backendConfiguration: backendLaunchConfiguration)
        )
        _backendRuntime = State(
            initialValue: RailgunBackendRuntime(configuration: backendLaunchConfiguration, store: appStore)
        )
        updater = RailgunUpdater.makeIfConfigured()
    }

    var body: some Scene {
        WindowGroup(
            Self.lifecycleConfiguration.primaryWindowTitle,
            id: Self.lifecycleConfiguration.primaryWindowRestorationIdentifier
        ) {
            Group {
                switch desktopClientStartup.status {
                case .acquiring:
                    ProgressView("Checking for another Railgun desktop client…")
                case .ready:
                    backendContent
                case let .conflict(record):
                    ContentUnavailableView(
                        "Railgun is already in use",
                        systemImage: "lock.fill",
                        description: Text(
                            "\(record.clientName) (PID \(record.pid)) is using your Railgun data. Quit it before opening Railgun."
                        )
                    )
                case .unavailable:
                    ContentUnavailableView(
                        "Railgun can’t safely open your data",
                        systemImage: "exclamationmark.triangle",
                        description: Text("The shared desktop-client lock could not be verified. Close any other Railgun desktop client and try again.")
                    )
                }
            }
            .frame(
                minWidth: Self.lifecycleConfiguration.primaryWindowMinimumSize.width,
                minHeight: Self.lifecycleConfiguration.primaryWindowMinimumSize.height
            )
            .font(RailgunFont.interface())
            .tint(RailgunColorRole.accent.color)
            .task {
                await desktopClientStartup.acquire()
                if desktopClientStartup.status == .ready {
                    await backendRuntime.start()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                Task {
                    await backendRuntime.shutdown()
                    await desktopClientStartup.release()
                }
            }
        }
        .defaultSize(
            width: Self.lifecycleConfiguration.primaryWindowDefaultSize.width,
            height: Self.lifecycleConfiguration.primaryWindowDefaultSize.height
        )
        .windowToolbarStyle(.unified(showsTitle: false))
        .windowResizability(Self.lifecycleConfiguration.primaryWindowResizability.swiftUIValue)
        .commands {
            RailgunTaskCommands()
            SidebarCommands()
            if let updater {
                CommandGroup(after: .appInfo) {
                    Button("Check for Updates…") {
                        updater.checkForUpdates()
                    }
                }
            }
        }

        Settings {
            RailgunSettingsView(
                appStore: appStore,
                sessionCoordinator: backendRuntime.sessionCoordinator
            )
            .font(RailgunFont.interface())
            .tint(RailgunColorRole.accent.color)
        }
    }

    @ViewBuilder
    private var backendContent: some View {
        let phase = appStore.state.backend.phase
        let availability = RailgunBackendAvailability(phase: phase)
        switch RailgunBackendPresentation(phase: phase) {
        case .starting:
            ProgressView("Starting the Railgun backend…")
                .focusedSceneValue(
                    \.railgunTaskCommandActions,
                    RailgunTaskCommandActions(
                        availability: .init(canCreateTask: false, canStop: false, canRetry: availability.canRetry),
                        createTask: {},
                        stop: {},
                        retry: {}
                    )
                )
        case .ready:
            RailgunTaskShell(
                appStore: appStore,
                sessionCoordinator: backendRuntime.sessionCoordinator,
                promptCoordinator: backendRuntime.promptCoordinator,
                interactionCoordinator: backendRuntime.interactionCoordinator,
                controlsCoordinator: backendRuntime.controlsCoordinator,
                compactionCoordinator: backendRuntime.compactionCoordinator
            )
        case let .authenticationRequired(title, message):
            RailgunBackendStatusView(
                title: title,
                message: message,
                systemImage: "key.fill",
                retryTitle: "Retry",
                canRetry: availability.canRetry,
                retry: restartBackend
            )
        case let .unavailable(title, message, systemImage, retryTitle):
            RailgunBackendStatusView(
                title: title,
                message: message,
                systemImage: systemImage,
                retryTitle: retryTitle,
                canRetry: availability.canRetry,
                retry: restartBackend
            )
        }
    }

    private func restartBackend() {
        Task { await backendRuntime.restart() }
    }
}
