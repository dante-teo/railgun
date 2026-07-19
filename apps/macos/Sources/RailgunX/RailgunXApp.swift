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
        primaryWindowTitle: "RailgunX",
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

/// Cancels the event-consumption task even when the runtime is released off
/// the main actor during teardown.
private final class RailgunEventObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    func replace(with nextTask: Task<Void, Never>) {
        lock.lock()
        let previousTask = task
        task = nextTask
        lock.unlock()
        previousTask?.cancel()
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

    private let client: RailgunRPCClient
    private let launch: BackendProcessLaunch?
    private let store: RailgunAppStore
    private var isStarting = false
    private nonisolated let terminationObservationTask: Task<Void, Never>
    private nonisolated let eventObservation = RailgunEventObservation()

    init(
        configuration: BackendLaunchConfiguration,
        store: RailgunAppStore,
        resourcesDirectory: URL = Bundle.main.resourceURL ?? URL(fileURLWithPath: "/")
    ) {
        let client = RailgunRPCClient()
        self.client = client
        self.store = store
        self.launch = configuration.desktopRPCLaunch(resourcesDirectory: resourcesDirectory)
        self.sessionCoordinator = RailgunSessionCoordinator(
            store: store,
            service: RailgunSessionService(rpcClient: client)
        )
        terminationObservationTask = Task { @MainActor [weak store, client] in
            for await _ in client.unexpectedTerminations {
                guard let store else { return }
                guard case .ready = store.state.backend.phase else { continue }
                store.send(.backend(.disconnected(message: "The connection to the backend was lost.")))
            }
        }
    }

    deinit {
        terminationObservationTask.cancel()
        eventObservation.cancel()
    }

    func start() async {
        guard !isStarting else { return }
        guard let launch else {
            store.send(.backend(.failed(message: "The selected backend could not be launched.")))
            return
        }
        isStarting = true
        defer { isStarting = false }

        store.send(.backend(.starting))
        do {
            let handshake = try await client.start(launch)
            store.send(.backend(.ready(capabilities: handshake.capabilities)))
            observeEvents()
            await sessionCoordinator.refresh()
        } catch let error as RailgunRPCError {
            if case .authenticationRequired = error {
                store.send(.backend(.authenticationRequired))
            } else {
                store.send(.backend(.failed(message: "The backend could not be started.")))
            }
        } catch {
            store.send(.backend(.failed(message: "The backend could not be started.")))
        }
    }

    func shutdown() async {
        eventObservation.cancel()
        await client.shutdown()
    }

    private func observeEvents() {
        let task = Task { @MainActor [weak store, client] in
            for await event in client.events {
                guard !Task.isCancelled, let store else { return }
                store.send(.agentEvent(event))
            }
        }
        eventObservation.replace(with: task)
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

enum RailgunBackendPresentation: Equatable {
    case starting
    case ready
    case authenticationRequired
    case unavailable(title: String, message: String)

    init(phase: RailgunBackendPhase) {
        switch phase {
        case .starting:
            self = .starting
        case .ready:
            self = .ready
        case .authenticationRequired:
            self = .authenticationRequired
        case let .failed(message):
            self = .unavailable(title: "Backend Unavailable", message: message)
        case let .disconnected(message):
            self = .unavailable(title: "Backend Disconnected", message: message)
        }
    }
}

enum RailgunArchivedTasksSettingsPresentation: Equatable {
    case empty
    case tasks([RailgunSessionSummary])

    init(session: RailgunSessionState) {
        self = session.archivedSessions.isEmpty
            ? .empty
            : .tasks(session.archivedSessions)
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
        if #available(macOS 26.0, *) {
            content.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content
        }
    }
}

struct RailgunTaskShell: View {
    static let activityCardDefaultVisibility = false
    static let activityCardPaneMargin: CGFloat = 8
    static let activityCardReservedWidth: CGFloat = 360
    static let sidebarMinimumWidth: CGFloat = 180

    static func isArchiveActionDisabled(for session: RailgunSessionState) -> Bool {
        session.selectedSession?.isPersisted != true
    }

    @Bindable private var appStore: RailgunAppStore
    private let sessionCoordinator: RailgunSessionCoordinator
    @State private var transcriptFollowState = RailgunTranscriptFollowState.initial
    @State private var previousTranscriptGeometry: RailgunScrollGeometry?
    @State private var transcriptScrollPosition = ScrollPosition(edge: .bottom)
    @State private var transcriptViewportWidth: CGFloat = 0
    @SceneStorage("railgun.task.activityCard.isPresented")
    private var isActivityCardVisible = activityCardDefaultVisibility

    init(appStore: RailgunAppStore, sessionCoordinator: RailgunSessionCoordinator) {
        _appStore = Bindable(appStore)
        self.sessionCoordinator = sessionCoordinator
    }

    var body: some View {
        NavigationSplitView {
            RailgunTaskSidebar(
                session: appStore.state.session,
                selection: selectedSessionID,
                isActivityCardVisible: $isActivityCardVisible,
                isFloatingActivityPresented: isFloatingActivityPresented
            )
            .navigationSplitViewColumnWidth(min: Self.sidebarMinimumWidth, ideal: 240)
        } detail: {
            transcriptScrollView
                .toolbar {
                    if #available(macOS 26.0, *) {
                        ToolbarSpacer(.flexible)
                    } else {
                        ToolbarItem {
                            Spacer()
                        }
                    }

                    ToolbarItemGroup(placement: .automatic) {
                        Button {
                            Task { await sessionCoordinator.create(modelID: appStore.state.controls.activeModelID) }
                        } label: {
                            Label("New Task", systemImage: "square.and.pencil")
                        }
                        Button(role: .destructive) {
                            guard let sessionID = appStore.state.session.activeSessionID else { return }
                            Task { await sessionCoordinator.archive(sessionID) }
                        } label: {
                            Label("Archive Task", systemImage: "archivebox")
                        }
                        .disabled(Self.isArchiveActionDisabled(for: appStore.state.session))
                    }
                }
        }
        .toolbarRole(.editor)
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

    private var hasScrollableTranscript: Bool {
        !presentedTranscriptMessages.isEmpty
    }

    private var activityPanePresentation: RailgunActivityPanePresentation {
        RailgunActivityPaneLayout.presentation(for: transcriptViewportWidth)
    }

    private var isActivityPaneDocked: Bool {
        isActivityCardVisible && activityPanePresentation == .docked
    }

    private var activityReservedContentWidth: CGFloat {
        isActivityPaneDocked ? Self.activityCardReservedWidth : 0
    }

    private var isFloatingActivityPresented: Binding<Bool> {
        Binding(
            get: {
                isActivityCardVisible && activityPanePresentation == .floating
            },
            set: { isPresented in
                guard !isPresented, activityPanePresentation == .floating else {
                    return
                }
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
            if presentedTranscriptMessages.isEmpty {
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
            .padding(12)
            .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .accessibilityIdentifier("session-operation-error")
    }

    private var transcriptScrollView: some View {
        // Keep this ScrollView mounted and its native vertical scroller enabled
        // from the first layout. Indicator hiding or NSScrollView mutation breaks
        // the macOS 26 soft top-edge effect. See docs/native-ui-policy.md.
        ScrollView {
            LazyVStack(alignment: .center, spacing: 16) {
                ForEach(presentedTranscriptMessages) { message in
                    RailgunTranscriptMessageRow(message: message)
                        .frame(maxWidth: 720)
                }
            }
            .padding(.vertical, 20)
            .padding(.leading, 44)
            .padding(.trailing, 20)
            .scrollTargetLayout()
        }
        .modifier(RailgunTranscriptSoftTopEdgeEffect())
        .defaultScrollAnchor(.bottom, for: .alignment)
        .contentMargins(
            .leading,
            activityReservedContentWidth,
            for: .scrollContent
        )
        .scrollPosition($transcriptScrollPosition)
        .onScrollGeometryChange(for: RailgunScrollGeometry.self) { geometry in
            RailgunScrollGeometry(geometry)
        } action: { _, geometry in
            handleTranscriptGeometryChange(geometry)
        }
        .accessibilityIdentifier("transcript-scroll-view")
        .overlay {
            taskDetailStateOverlay
                .padding(
                    .leading,
                    activityReservedContentWidth
                )
        }
        .overlay(alignment: .bottomTrailing) {
            if hasScrollableTranscript && transcriptFollowState.showsJumpToLatest {
                Button("Jump to Latest", systemImage: "arrow.down") {
                    transcriptFollowState = .jumpToLatest()
                    scrollTranscriptToBottom()
                }
                .buttonStyle(.borderedProminent)
                .padding(20)
                .accessibilityIdentifier("jump-to-latest")
            }
        }
        .onChange(of: appStore.state.session.activeSessionID, initial: true) { _, _ in
            transcriptFollowState = .sessionDidChange()
            previousTranscriptGeometry = nil
            scrollTranscriptToBottom()
        }
        .onChange(of: appStore.state.transcript.messages) { _, _ in
            if transcriptFollowState.isFollowingLatest {
                scrollTranscriptToBottom()
            } else {
                transcriptFollowState = .contentDidChange(transcriptFollowState)
            }
        }
        .overlay(alignment: .leading) {
            if isActivityPaneDocked {
                RailgunActivityCard(
                    dismiss: { isActivityCardVisible = false }
                )
                    .frame(minWidth: 260, idealWidth: 300, maxWidth: 320)
                    .padding(.vertical, Self.activityCardPaneMargin)
                    .padding(.leading, Self.activityCardPaneMargin)
                    .ignoresSafeArea(.container, edges: .top)
            }
        }
    }

    private func handleTranscriptGeometryChange(_ geometry: RailgunScrollGeometry) {
        defer { previousTranscriptGeometry = geometry }
        transcriptViewportWidth = geometry.viewportWidth

        if geometry.isAtBottom {
            transcriptFollowState = .initial
            return
        }

        if RailgunTranscriptFollowState.shouldMaintainFollow(
            transcriptFollowState,
            previousContentHeight: previousTranscriptGeometry?.contentHeight,
            previousViewportHeight: previousTranscriptGeometry?.viewportHeight,
            contentHeight: geometry.contentHeight,
            viewportHeight: geometry.viewportHeight
        ) {
            scrollTranscriptToBottom()
        } else {
            transcriptFollowState = .scrollPositionDidChange(
                transcriptFollowState,
                isAtBottom: false
            )
        }
    }

    private func scrollTranscriptToBottom() {
        transcriptScrollPosition.scrollTo(edge: .bottom)
    }
}

private struct RailgunTaskSidebar: View {
    let session: RailgunSessionState
    let selection: Binding<String?>
    let isActivityCardVisible: Binding<Bool>
    let isFloatingActivityPresented: Binding<Bool>

    var body: some View {
        List(selection: selection) {
            if session.isLoading {
                ProgressView("Loading tasks…")
            } else if session.sessions.isEmpty {
                ContentUnavailableView(
                    "No Tasks",
                    systemImage: "tray",
                    description: Text("Tasks will appear here when they are available.")
                )
            } else {
                ForEach(session.sessions) { summary in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(summary.displayTitle)
                            .lineLimit(1)
                        Text("\(summary.model) • \(summary.startedAt)")
                            .font(RailgunFont.interface(.caption))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .tag(summary.id)
                }
            }
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
            isActivityCardVisible.wrappedValue
                ? "Hide Activity"
                : "Show Activity"
        )
        .accessibilityIdentifier("toggle-activity")
        .popover(
            isPresented: isFloatingActivityPresented,
            arrowEdge: .leading
        ) {
            RailgunActivityCard(
                dismiss: {
                    isActivityCardVisible.wrappedValue = false
                },
                displaysPanelBackground: false
            )
            .frame(width: 320, height: 420)
            .padding(8)
        }
    }
}

private struct RailgunActivityCard: View {
    var dismiss: (() -> Void)? = nil
    var displaysPanelBackground = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center) {
                Text("Activity")
                    .font(RailgunFont.interface(.title, weight: .bold))

                Spacer()

                if let dismiss {
                    Button(action: dismiss) {
                        Image(systemName: "xmark")
                            .font(RailgunFont.interface(.title2, weight: .medium))
                            .frame(width: 34, height: 34)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .background(.quaternary, in: Circle())
                    .help("Close Activity")
                    .accessibilityIdentifier("close-activity")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)

            ContentUnavailableView(
                "No Activity Yet",
                systemImage: RailgunTaskSymbol.activity,
                description: Text("Activity details will appear here in a later Task milestone.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(20)
        }
        .frame(maxHeight: .infinity)
        .modifier(
            RailgunActivityPanelBackground(isEnabled: displaysPanelBackground)
        )
    }
}

private struct RailgunActivityPanelBackground: ViewModifier {
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if !isEnabled {
            content
        } else if #available(macOS 26.0, *) {
            content.glassEffect(
                .regular,
                in: RoundedRectangle(cornerRadius: 28, style: .continuous)
            )
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: 28, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .stroke(.separator.opacity(0.35), lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.08), radius: 16, y: 8)
        }
    }
}

private struct RailgunBackendStatusView: View {
    let title: String
    let message: String
    let systemImage: String
    let retryTitle: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: systemImage)
                .font(.system(size: 42))
                .foregroundStyle(.secondary)
            Text(title)
                .font(RailgunFont.interface(.title2))
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 460)
            Button(retryTitle, action: retry)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        VStack(alignment: .leading, spacing: 16) {
            Text("Archived Tasks")
                .font(RailgunFont.interface(.title2, weight: .semibold))

            if let error = appStore.state.session.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(RailgunFont.interface(.callout))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("archived-task-error")
            }

            switch RailgunArchivedTasksSettingsPresentation(session: appStore.state.session) {
            case .empty:
                ContentUnavailableView(
                    "No Archived Tasks",
                    systemImage: "archivebox",
                    description: Text("Tasks you archive will appear here.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .tasks(tasks):
                List(tasks) { task in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(task.displayTitle)
                                .lineLimit(1)
                            Text("\(task.model) • \(task.startedAt)")
                                .font(RailgunFont.interface(.caption))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }

                        Spacer()

                        Button("Restore") {
                            Task { await sessionCoordinator.restore(task.id) }
                        }
                        .accessibilityIdentifier("restore-archived-task-\(task.id)")
                    }
                    .padding(.vertical, 4)
                }
                .listStyle(.inset)
            }
        }
        .padding(20)
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
                            "\(record.clientName) (PID \(record.pid)) is using your Railgun data. Quit it before opening RailgunX."
                        )
                    )
                case .unavailable:
                    ContentUnavailableView(
                        "RailgunX can’t safely open your data",
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

        Settings {
            RailgunSettingsView(
                appStore: appStore,
                sessionCoordinator: backendRuntime.sessionCoordinator
            )
            .font(RailgunFont.interface())
        }
    }

    @ViewBuilder
    private var backendContent: some View {
        switch RailgunBackendPresentation(phase: appStore.state.backend.phase) {
        case .starting:
            ProgressView("Starting the Railgun backend…")
        case .ready:
            RailgunTaskShell(appStore: appStore, sessionCoordinator: backendRuntime.sessionCoordinator)
        case .authenticationRequired:
            RailgunBackendStatusView(
                title: "Authentication Required",
                message: "RailgunX could not authenticate with the configured backend. Update your credentials, then try again.",
                systemImage: "key.fill",
                retryTitle: "Try Again",
                retry: restartBackend
            )
        case let .unavailable(title, message):
            RailgunBackendStatusView(
                title: title,
                message: message,
                systemImage: "exclamationmark.triangle.fill",
                retryTitle: "Retry",
                retry: restartBackend
            )
        }
    }

    private func restartBackend() {
        Task { await backendRuntime.start() }
    }
}
