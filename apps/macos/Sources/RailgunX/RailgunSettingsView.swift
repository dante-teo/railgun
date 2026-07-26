import Observation
import RailgunUI
import SwiftUI

enum RailgunSettingsDestination: Hashable {
    case general
    case archivedTasks

    static let defaultSelection = Self.general
}

struct RailgunSettingsView: View {
    static let windowID = "settings"
    static let defaultWindowWidth: CGFloat = 1_040
    static let defaultWindowHeight: CGFloat = 640
    private static let sidebarMinimumWidth: CGFloat = 180
    private static let sidebarPreferredWidth: CGFloat = 220
    private static let sidebarMaximumWidth: CGFloat = 280
    private static let minimumWindowWidth: CGFloat = 980
    private static let minimumWindowHeight: CGFloat = 600

    @Bindable private var appStore: RailgunAppStore
    private let sessionCoordinator: RailgunSessionCoordinator
    private let controlsCoordinator: RailgunControlsCoordinator
    @State private var selection: RailgunSettingsDestination? = RailgunSettingsDestination.defaultSelection

    init(
        appStore: RailgunAppStore,
        sessionCoordinator: RailgunSessionCoordinator,
        controlsCoordinator: RailgunControlsCoordinator
    ) {
        _appStore = Bindable(appStore)
        self.sessionCoordinator = sessionCoordinator
        self.controlsCoordinator = controlsCoordinator
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    Label("General", systemImage: "gearshape")
                        .tag(RailgunSettingsDestination.general)
                }

                Section("Archived") {
                    Label("Archived Tasks", systemImage: "archivebox")
                        .tag(RailgunSettingsDestination.archivedTasks)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(
                min: Self.sidebarMinimumWidth,
                ideal: Self.sidebarPreferredWidth,
                max: Self.sidebarMaximumWidth
            )
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.prominentDetail)
        .frame(minWidth: Self.minimumWindowWidth, minHeight: Self.minimumWindowHeight)
        .font(RailgunFont.interface())
        .tint(RailgunColorRole.accent.color)
    }

    @ViewBuilder
    private var detail: some View {
        switch displayedDestination {
        case .general:
            generalDetail
        case .archivedTasks:
            archivedTasksDetail
        }
    }

    private var displayedDestination: RailgunSettingsDestination {
        selection ?? .defaultSelection
    }

    private var archivedTasksDetail: some View {
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
        }
        .padding(RailgunSpacing.layout.points)
    }

    private var generalDetail: some View {
        Form {
            Section {
                Picker("Approval mode", selection: approvalMode) {
                    Label("Ask for approval", systemImage: "hand.raised")
                        .tag(RailgunApprovalMode.manual)
                    Label("Approve for me", systemImage: "terminal")
                        .tag(RailgunApprovalMode.smart)
                    Label("Full access", systemImage: "exclamationmark.shield")
                        .tag(RailgunApprovalMode.off)
                }
                .disabled(!canEditApproval)
                .accessibilityIdentifier("settings-approval-mode")

                Picker("Auto-approval model", selection: reviewerModelID) {
                    Text("Choose a model").tag(nil as String?)
                    ForEach(appStore.state.controls.models) { model in
                        Text(model.name).tag(Optional(model.id))
                    }
                }
                .disabled(!canEditApproval)
                .accessibilityIdentifier("settings-approval-model")

                if !hasSelectedReviewerModel {
                    Text("Select a model to enable auto approval.")
                        .font(RailgunFont.interface(.caption))
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Permissions")
            } footer: {
                Text("These permissions apply to the next run. Full access runs flagged commands without asking for confirmation.")
            }

            if let error = appStore.state.controls.error {
                Text(error)
                    .foregroundStyle(.red)
            }
        }
        .navigationTitle("General")
        .formStyle(.grouped)
    }

    private var approvalMode: Binding<RailgunApprovalMode> {
        Binding(
            get: { appStore.state.controls.approval.mode },
            set: { mode in
                Task {
                    await controlsCoordinator.configureApproval(.init(
                        mode: mode,
                        reviewerModelID: appStore.state.controls.approval.reviewerModelID
                    ))
                }
            }
        )
    }

    private var reviewerModelID: Binding<String?> {
        Binding(
            get: { appStore.state.controls.approval.reviewerModelID },
            set: { reviewerModelID in
                Task {
                    await controlsCoordinator.configureApproval(.init(
                        mode: appStore.state.controls.approval.mode,
                        reviewerModelID: reviewerModelID
                    ))
                }
            }
        )
    }

    private var hasSelectedReviewerModel: Bool {
        appStore.state.controls.approval.reviewerModelID != nil
    }

    private var canEditApproval: Bool {
        appStore.state.controls.isReadyForMutation && !appStore.state.transcript.isRunning
    }
}

struct RailgunSettingsCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") {
                openWindow(id: RailgunSettingsView.windowID)
            }
            .keyboardShortcut(",", modifiers: .command)
        }
    }
}
