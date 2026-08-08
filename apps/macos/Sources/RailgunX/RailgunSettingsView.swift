import Observation
import RailgunServices
import RailgunUI
import SwiftUI

enum RailgunSettingsDestination: Hashable {
    case general
    case appearance
    case personalization
    case skills
    case archivedTasks

    static let defaultSelection = Self.general
}

enum RailgunAppearance: String, CaseIterable, Identifiable {
    static let storageKey = "railgun.appearance"

    case automatic
    case light
    case dark

    var id: Self { self }

    var title: String {
        switch self {
        case .automatic: "Auto"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .automatic: nil
        case .light: .light
        case .dark: .dark
        }
    }
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
    @Bindable private var personalizationStore: RailgunPersonalizationStore
    private let backendRuntime: RailgunBackendRuntime
    private let sessionCoordinator: RailgunSessionCoordinator
    private let controlsCoordinator: RailgunControlsCoordinator
    private let backgroundSchedulerService: RailgunBackgroundSchedulerService?
    @Bindable private var skillsStore: RailgunSkillsStore
    @State private var selection: RailgunSettingsDestination? = RailgunSettingsDestination.defaultSelection
    @AppStorage(RailgunAppearance.storageKey) private var appearance: RailgunAppearance = .automatic

    init(
        appStore: RailgunAppStore,
        backendRuntime: RailgunBackendRuntime,
        sessionCoordinator: RailgunSessionCoordinator,
        controlsCoordinator: RailgunControlsCoordinator,
        personalizationStore: RailgunPersonalizationStore,
        skillsStore: RailgunSkillsStore,
        backgroundSchedulerService: RailgunBackgroundSchedulerService?
    ) {
        _appStore = Bindable(appStore)
        _personalizationStore = Bindable(personalizationStore)
        self.backendRuntime = backendRuntime
        self.sessionCoordinator = sessionCoordinator
        self.controlsCoordinator = controlsCoordinator
        self.backgroundSchedulerService = backgroundSchedulerService
        _skillsStore = Bindable(skillsStore)
    }

    var body: some View {
        NavigationSplitView {
            List {
                Section {
                    RailgunSidebarSelectionRow(
                        "General",
                        systemImage: "gearshape",
                        isSelected: displayedDestination == .general,
                        action: { selection = .general }
                    )
                    RailgunSidebarSelectionRow(
                        "Appearance",
                        systemImage: "sun.max",
                        isSelected: displayedDestination == .appearance,
                        action: { selection = .appearance }
                    )
                    RailgunSidebarSelectionRow(
                        "Personalization",
                        systemImage: "gauge.with.dots.needle.33percent",
                        isSelected: displayedDestination == .personalization,
                        action: { selection = .personalization }
                    )
                    RailgunSidebarSelectionRow(
                        "Skills",
                        systemImage: "wand.and.stars",
                        isSelected: displayedDestination == .skills,
                        action: { selection = .skills }
                    )
                }

                Section {
                    RailgunSidebarSelectionRow(
                        "Archived Tasks",
                        systemImage: "archivebox",
                        isSelected: displayedDestination == .archivedTasks,
                        action: { selection = .archivedTasks }
                    )
                } header: {
                    Text("Archived")
                        .font(RailgunFont.interface(.caption, weight: .semibold))
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
        case .appearance:
            appearanceDetail
        case .personalization:
            RailgunPersonalizationView(store: personalizationStore)
        case .skills:
            RailgunSkillsView(store: skillsStore)
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

    private var appearanceDetail: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.section.points) {
            Text("Theme")
                .font(RailgunFont.interface(.title2, weight: .semibold))

            Text("Choose how Railgun looks across all of its windows.")
                .font(RailgunFont.interface(.callout))
                .foregroundStyle(RailgunColorRole.secondaryText.color)

            HStack(alignment: .top, spacing: RailgunSpacing.section.points) {
                ForEach(RailgunAppearance.allCases) { option in
                    ThemePickerCard(theme: option, isSelected: appearance == option) {
                        appearance = option
                    }
                }
            }
        }
        .padding(RailgunSpacing.layout.points)
        .navigationTitle("Appearance")
        .font(RailgunFont.interface())
    }

    private var generalDetail: some View {
        Form {
            RailgunAuthenticationSettings(
                state: appStore.state.authentication,
                backendPhase: appStore.state.backend.phase,
                login: {
                    Task { await backendRuntime.login() }
                },
                logout: {
                    Task { await backendRuntime.logout() }
                }
            )

            Section {
                Picker("Default model", selection: defaultModelID) {
                    Text("Choose a model").tag(nil as String?)
                    ForEach(appStore.state.controls.models) { model in
                        Text(model.name).tag(Optional(model.id))
                    }
                }
                .disabled(!canEditControls)
                .accessibilityIdentifier("settings-default-model")

                Button("Refresh Models", systemImage: "arrow.clockwise") {
                    Task { await controlsCoordinator.refreshModels() }
                }
                .disabled(!canEditControls)
                .accessibilityIdentifier("refresh-model-catalog")
            } header: {
                Text("Model")
            } footer: {
                Text("New tasks start with this model. It does not change the model of the current task.")
            }

            Section {
                Toggle("Enable advisor", isOn: advisorEnabled)
                    .disabled(!canEditControls || !hasSelectedAdvisorModel)
                    .accessibilityIdentifier("settings-advisor-enabled")

                Picker("Advisor model", selection: advisorModelID) {
                    Text("Choose a model").tag(nil as String?)
                    ForEach(appStore.state.controls.models) { model in
                        Text(model.name).tag(Optional(model.id))
                    }
                }
                .disabled(!canEditControls)
                .accessibilityIdentifier("settings-advisor-model")

                if !hasSelectedAdvisorModel {
                    Text("Select an advisor model to enable the advisor.")
                        .font(RailgunFont.interface(.caption))
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Advisor")
            } footer: {
                Text("The advisor reviews tasks using the selected model.")
            }

            Section {
                Picker("Approval mode", selection: approvalMode) {
                    Label("Ask for approval", systemImage: "hand.raised")
                        .tag(RailgunApprovalMode.manual)
                    Label("Approve for me", systemImage: "terminal")
                        .tag(RailgunApprovalMode.smart)
                    Label("Full access", systemImage: "exclamationmark.shield")
                        .tag(RailgunApprovalMode.off)
                }
                .disabled(!canEditControls)
                .accessibilityIdentifier("settings-approval-mode")

                Picker("Auto-approval model", selection: reviewerModelID) {
                    Text("Choose a model").tag(nil as String?)
                    ForEach(appStore.state.controls.models) { model in
                        Text(model.name).tag(Optional(model.id))
                    }
                }
                .disabled(!canEditControls)
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

            RailgunBackgroundSchedulerSettings(service: backgroundSchedulerService)

            if let error = appStore.state.controls.error {
                Text(error)
                    .foregroundStyle(.red)
            }
        }
        .navigationTitle("General")
        .formStyle(.grouped)
        .font(RailgunFont.interface())
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

    private var defaultModelID: Binding<String?> {
        Binding(
            get: { appStore.state.controls.defaultModelID },
            set: { modelID in
                Task { await controlsCoordinator.configureDefaultModel(modelID) }
            }
        )
    }

    private var advisorEnabled: Binding<Bool> {
        Binding(
            get: { appStore.state.controls.advisor.isEnabled },
            set: { isEnabled in
                Task {
                    await controlsCoordinator.configureAdvisor(.init(
                        isEnabled: isEnabled,
                        modelID: appStore.state.controls.advisor.modelID
                    ))
                }
            }
        )
    }

    private var advisorModelID: Binding<String?> {
        Binding(
            get: { appStore.state.controls.advisor.modelID },
            set: { modelID in
                Task {
                    let advisor = appStore.state.controls.advisor
                    await controlsCoordinator.configureAdvisor(.init(
                        isEnabled: modelID == nil ? false : advisor.isEnabled,
                        modelID: modelID
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

    private var hasSelectedAdvisorModel: Bool {
        appStore.state.controls.advisor.modelID != nil
    }

    private var canEditControls: Bool {
        appStore.state.controls.isReadyForMutation && !appStore.state.transcript.isRunning
    }
}

private struct ThemePickerCard: View {
    let theme: RailgunAppearance
    let isSelected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            VStack(spacing: RailgunSpacing.compact.points) {
                ThemePreview(theme: theme, isSelected: isSelected)
                    .frame(height: 174)

                Text(theme.title)
                    .font(RailgunFont.interface(.body, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(theme.title) theme")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct ThemePreview: View {
    let theme: RailgunAppearance
    let isSelected: Bool

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                previewBackground

                VStack(spacing: 9) {
                    Capsule()
                        .fill(chromeColor)
                        .frame(width: proxy.size.width * 0.45, height: 12)
                    Capsule()
                        .fill(chromeColor.opacity(0.7))
                        .frame(width: proxy.size.width * 0.68, height: 8)

                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(surfaceColor)
                        .overlay(alignment: .topLeading) {
                            VStack(alignment: .leading, spacing: 13) {
                                Capsule()
                                    .fill(contentColor)
                                    .frame(width: proxy.size.width * 0.25, height: 12)
                                Capsule()
                                    .fill(contentColor.opacity(0.45))
                                    .frame(width: proxy.size.width * 0.42, height: 6)
                                Divider()
                                Capsule()
                                    .fill(contentColor)
                                    .frame(width: proxy.size.width * 0.25, height: 12)
                                Capsule()
                                    .fill(contentColor.opacity(0.45))
                                    .frame(width: proxy.size.width * 0.42, height: 6)
                            }
                            .padding(20)
                        }
                        .frame(width: proxy.size.width * 0.8, height: proxy.size.height * 0.62)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: isSelected ? 3 : 1.5)
            }
        }
    }

    @ViewBuilder
    private var previewBackground: some View {
        switch theme {
        case .automatic:
            HStack(spacing: 0) {
                Color.white
                Color.black.opacity(0.65)
            }
        case .light:
            Color.white
        case .dark:
            Color.black.opacity(0.65)
        }
    }

    private var surfaceColor: Color {
        theme == .dark ? Color.white : Color.white.opacity(0.95)
    }

    private var chromeColor: Color {
        theme == .dark ? Color.white.opacity(0.5) : Color.black.opacity(0.16)
    }

    private var contentColor: Color {
        Color.black.opacity(0.14)
    }

    private var borderColor: Color {
        if isSelected {
            return RailgunColorRole.accent.color
        }

        return theme == .dark ? Color.white.opacity(0.2) : Color.black.opacity(0.12)
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
