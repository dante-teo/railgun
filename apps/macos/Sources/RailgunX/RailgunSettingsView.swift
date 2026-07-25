import Observation
import RailgunUI
import SwiftUI

enum RailgunSettingsDestination: Hashable {
    case archivedTasks

    static let defaultSelection = Self.archivedTasks
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
    @State private var selection: RailgunSettingsDestination? = RailgunSettingsDestination.defaultSelection

    init(appStore: RailgunAppStore, sessionCoordinator: RailgunSessionCoordinator) {
        _appStore = Bindable(appStore)
        self.sessionCoordinator = sessionCoordinator
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Label("Archived Tasks", systemImage: "archivebox")
                    .tag(RailgunSettingsDestination.archivedTasks)
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
