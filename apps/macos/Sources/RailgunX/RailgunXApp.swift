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

struct RailgunTaskShell: View {
    static let activityCardDefaultVisibility = false
    static let sidebarMinimumWidth: CGFloat = 180

    static func isArchiveActionDisabled(for session: RailgunSessionState) -> Bool {
        session.selectedSession?.isPersisted != true
    }

    @Bindable private var appStore: RailgunAppStore
    private let sessionCoordinator: RailgunSessionCoordinator
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
                selection: selectedSessionID
            )
            .navigationSplitViewColumnWidth(min: Self.sidebarMinimumWidth, ideal: 240)
        } detail: {
            RailgunTaskDetailArea(
                session: appStore.state.session,
                transcript: appStore.state.transcript,
                isActivityCardVisible: isActivityCardVisible
            )
        }
        .navigationTitle("Task")
        .toolbarRole(.editor)
        .toolbar {
            ToolbarItem{
                ControlGroup {
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

            ToolbarItem {
                Toggle(isOn: $isActivityCardVisible) {
                    Label("Activity", systemImage: RailgunTaskSymbol.activity)
                }
                .toggleStyle(.button)
                .help(isActivityCardVisible ? "Hide Activity" : "Show Activity")
            }
        }
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

}

private struct RailgunTaskDetailArea: View {
    let session: RailgunSessionState
    let transcript: RailgunTranscriptState
    let isActivityCardVisible: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let error = session.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("session-operation-error")
            }

            HStack(alignment: .top, spacing: 20) {
                RailgunTaskDetail(session: session, transcript: transcript)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                if isActivityCardVisible {
                    RailgunActivityCard()
                        .frame(minWidth: 260, idealWidth: 300, maxWidth: 320)
                }
            }
        }
        .padding(20)
    }
}

private struct RailgunTaskSidebar: View {
    let session: RailgunSessionState
    let selection: Binding<String?>

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
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .tag(summary.id)
                }
            }
        }
    }
}

private struct RailgunTaskDetail: View {
    let session: RailgunSessionState
    let transcript: RailgunTranscriptState

    var body: some View {
        switch RailgunTaskDetailPresentation(session: session) {
        case .loading:
            ProgressView("Loading tasks…")
        case .empty:
            ContentUnavailableView(
                "No Tasks Yet",
                systemImage: "text.badge.plus",
                description: Text("Create and restore tasks in a later Task milestone.")
            )
        case .selectionRequired:
            ContentUnavailableView(
                "Select a Task",
                systemImage: "sidebar.leading",
                description: Text("Choose a task from the sidebar to continue.")
            )
        case let .selected(summary):
            RailgunTranscriptViewport(sessionID: summary.id, transcript: transcript)
        case .staleSelection:
            ContentUnavailableView(
                "Task Unavailable",
                systemImage: "exclamationmark.triangle",
                description: Text("The selected task is no longer available.")
            )
        }
    }
}

private struct RailgunActivityCard: View {
    var body: some View {
        GroupBox {
            ContentUnavailableView(
                "No Activity Yet",
                systemImage: RailgunTaskSymbol.activity,
                description: Text("Activity details will appear here in a later Task milestone.")
            )
            .frame(maxWidth: .infinity, minHeight: 220)
        } label: {
            Label("Activity", systemImage: RailgunTaskSymbol.activity)
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
                .font(.title2)
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
                .font(.title2)
                .fontWeight(.semibold)

            if let error = appStore.state.session.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
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
                                .font(.caption)
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
        .windowResizability(Self.lifecycleConfiguration.primaryWindowResizability.swiftUIValue)

        Settings {
            RailgunSettingsView(
                appStore: appStore,
                sessionCoordinator: backendRuntime.sessionCoordinator
            )
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
