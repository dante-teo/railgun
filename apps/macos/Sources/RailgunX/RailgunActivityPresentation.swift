import RailgunUI
import RailgunTransport
import SwiftUI

enum RailgunActivitySymbol: String, Equatable {
    case fileEdit = "doc.badge.gearshape"
    case fileRead = "doc.text"
    case folder = "folder"
    case terminal = "terminal"
    case search = "magnifyingglass"
    case globe = "globe"
    case tool = "wrench.and.screwdriver"
}

struct RailgunToolActivityPresentation: Equatable {
    let action: String
    let target: String?
    let symbol: RailgunActivitySymbol
}

private struct RailgunToolPresentationDefinition {
    let running: String
    let completed: String
    let verb: String
    let pluralTarget: String
    let targetKeys: [String]
    let symbol: RailgunActivitySymbol
}

enum RailgunActivityPresentation {
    private static let toolDefinitions: [String: RailgunToolPresentationDefinition] = [
        "write_file": .init(running: "Editing", completed: "Edited", verb: "edit", pluralTarget: "files", targetKeys: ["path"], symbol: .fileEdit),
        "read_file": .init(running: "Reading", completed: "Read", verb: "read", pluralTarget: "files", targetKeys: ["path"], symbol: .fileRead),
        "list_directory": .init(running: "Listing", completed: "Listed", verb: "list", pluralTarget: "directories", targetKeys: ["path"], symbol: .folder),
        "run_shell": .init(running: "Running", completed: "Ran", verb: "run", pluralTarget: "commands", targetKeys: ["command"], symbol: .terminal),
        "run_shell_command": .init(running: "Running", completed: "Ran", verb: "run", pluralTarget: "commands", targetKeys: ["command"], symbol: .terminal),
        "web_search": .init(running: "Searching", completed: "Searched", verb: "search", pluralTarget: "web", targetKeys: ["query"], symbol: .search),
        "search_files": .init(running: "Searching", completed: "Searched", verb: "search", pluralTarget: "files", targetKeys: ["query", "path"], symbol: .search),
        "web_fetch": .init(running: "Fetching", completed: "Fetched", verb: "fetch", pluralTarget: "resources", targetKeys: ["url"], symbol: .globe),
        "delegate_task": .init(running: "Delegating", completed: "Delegated", verb: "delegate", pluralTarget: "tasks", targetKeys: ["goal"], symbol: .tool),
        "skill_view": .init(running: "Loading", completed: "Loaded", verb: "load", pluralTarget: "skills", targetKeys: ["name"], symbol: .tool),
        "note_search": .init(running: "Searching", completed: "Searched", verb: "search", pluralTarget: "notes", targetKeys: ["query"], symbol: .search),
        "note_write": .init(running: "Writing", completed: "Wrote", verb: "write", pluralTarget: "notes", targetKeys: ["title"], symbol: .fileEdit),
    ]

    static func tool(name: String, input: String?, status: RailgunActivityStatus) -> RailgunToolActivityPresentation {
        guard let definition = toolDefinitions[name] else {
            return .init(action: unknownToolAction(name: name, status: status), target: safeRestoredTarget(input), symbol: .tool)
        }
        return .init(
            action: action(definition, status: status),
            target: target(definition, from: input),
            symbol: definition.symbol
        )
    }

    static func groupedTool(name: String, status: RailgunActivityStatus) -> RailgunToolActivityPresentation {
        guard let definition = toolDefinitions[name] else {
            return .init(action: unknownToolAction(name: name, status: status), target: nil, symbol: .tool)
        }
        return .init(
            action: "\(action(definition, status: status)) \(definition.pluralTarget)",
            target: nil,
            symbol: definition.symbol
        )
    }

    static func statusLabel(_ status: RailgunActivityStatus) -> String {
        switch status {
        case .running: "Running"
        case .success: "Completed"
        case .error: "Error"
        case .interrupted: "Interrupted"
        }
    }

    private static func action(_ definition: RailgunToolPresentationDefinition, status: RailgunActivityStatus) -> String {
        switch status {
        case .running: return definition.running
        case .success: return definition.completed
        case .error: return "Failed to \(definition.verb)"
        case .interrupted: return "Stopped \(definition.running.lowercased())"
        }
    }

    private static func unknownToolAction(name: String, status: RailgunActivityStatus) -> String {
        let readableName = humanizedToolName(name)
        switch status {
        case .running: return "Running \(readableName)"
        case .success: return "Ran \(readableName)"
        case .error: return "Failed to run \(readableName)"
        case .interrupted: return "Stopped \(readableName)"
        }
    }

    private static func target(_ definition: RailgunToolPresentationDefinition, from input: String?) -> String? {
        guard let input else { return nil }
        if let object = jsonObject(from: input),
           let value = definition.targetKeys.compactMap({ object[$0] as? String }).first(where: { !oneLine($0).isEmpty }) {
            return definition.targetKeys.first == "path" ? basename(value) : oneLine(value)
        }
        return safeRestoredTarget(input)
    }

    /// Restored entries contain an already-redacted target rather than a tool input object.
    /// Do not surface raw JSON when it cannot be decoded into a known safe target.
    private static func safeRestoredTarget(_ input: String?) -> String? {
        guard let input else { return nil }
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("{"), !trimmed.hasPrefix("[") else { return nil }
        return oneLine(trimmed)
    }

    private static func jsonObject(from input: String) -> [String: Any]? {
        guard let data = input.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data),
              let object = value as? [String: Any]
        else { return nil }
        return object
    }

    private static func basename(_ path: String) -> String {
        let components = path.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .filter { !$0.isEmpty }
        return components.last.map(String.init) ?? path
    }

    private static func oneLine(_ value: String) -> String {
        value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func humanizedToolName(_ name: String) -> String {
        name.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
    }
}

enum RailgunActivityRowItem: Equatable {
    case entry(RailgunActivityEntry)
    case toolGroup(name: String, status: RailgunActivityStatus, entries: [RailgunActivityEntry])
}

enum RailgunActivityGrouping {
    static func rows(for entries: [RailgunActivityEntry]) -> [RailgunActivityRowItem] {
        var result: [RailgunActivityRowItem] = []
        var consecutiveTools: [RailgunActivityEntry] = []

        func flush() {
            guard !consecutiveTools.isEmpty else { return }
            if consecutiveTools.count == 1 || consecutiveTools.contains(where: { $0.status == .running }) {
                result.append(contentsOf: consecutiveTools.map(RailgunActivityRowItem.entry))
            } else if let name = consecutiveTools.first?.toolName {
                result.append(.toolGroup(name: name, status: status(for: consecutiveTools), entries: consecutiveTools))
            }
            consecutiveTools = []
        }

        for entry in entries {
            if case let .tool(_, name, _, _, _, _) = entry,
               (consecutiveTools.isEmpty || consecutiveTools.first?.toolName == name) {
                consecutiveTools.append(entry)
            } else {
                flush()
                if case .tool = entry {
                    consecutiveTools.append(entry)
                } else {
                    result.append(.entry(entry))
                }
            }
        }
        flush()
        return result
    }

    static func status(for entries: [RailgunActivityEntry]) -> RailgunActivityStatus {
        if entries.contains(where: { $0.status == .running }) { return .running }
        if entries.contains(where: { $0.status == .error }) { return .error }
        if entries.contains(where: { $0.status == .interrupted }) { return .interrupted }
        return .success
    }
}

private extension RailgunActivityEntry {
    var toolName: String? {
        guard case let .tool(_, name, _, _, _, _) = self else { return nil }
        return name
    }
}

enum RailgunTranscriptTimelineItem: Equatable {
    case message(RailgunTranscriptMessage)
    case activity(RailgunActivityEntry)

    var order: Int {
        switch self {
        case let .message(message): message.order
        case let .activity(activity): activity.order
        }
    }
}

enum RailgunTranscriptPresentationItem: Equatable {
    case entry(RailgunTranscriptTimelineItem)
    case worked([RailgunActivityEntry])
}

enum RailgunTranscriptRenderItem: Equatable {
    case message(RailgunTranscriptMessage)
    case activityRows([RailgunActivityEntry])
    case worked([RailgunActivityEntry])
}

enum RailgunTranscriptActivityPresentation {
    static func activity(
        for detailPresentation: RailgunTaskDetailPresentation,
        from activity: RailgunActivityState
    ) -> RailgunActivityState {
        detailPresentation.displaysTranscriptMessages ? activity : .initial
    }

    static func timeline(messages: [RailgunTranscriptMessage], activity: [RailgunActivityEntry]) -> [RailgunTranscriptTimelineItem] {
        let items = messages.map(RailgunTranscriptTimelineItem.message)
            + activity.map(RailgunTranscriptTimelineItem.activity)
        return items.enumerated()
            .sorted { left, right in
                left.element.order == right.element.order ? left.offset < right.offset : left.element.order < right.element.order
            }
            .map(\.element)
    }

    static func collapseSettledTurnActivity(
        _ timeline: [RailgunTranscriptTimelineItem],
        isActive: Bool
    ) -> [RailgunTranscriptPresentationItem] {
        guard !isActive else { return timeline.map(RailgunTranscriptPresentationItem.entry) }

        var result: [RailgunTranscriptPresentationItem] = []
        var userMessage: RailgunTranscriptMessage?
        var activities: [RailgunActivityEntry] = []

        func flushActivities() {
            result.append(contentsOf: activities.map { .entry(.activity($0)) })
            activities = []
        }

        for item in timeline {
            switch item {
            case let .activity(activity):
                if userMessage != nil {
                    activities.append(activity)
                } else {
                    result.append(.entry(item))
                }
            case let .message(message):
                if message.role == .user {
                    flushActivities()
                    userMessage = message
                    result.append(.entry(item))
                    continue
                }

                let completesTurn = message.status == .complete && (message.branchable || message.messageID == nil)
                if completesTurn, userMessage != nil, !activities.isEmpty {
                    result.append(.worked(activities))
                    activities = []
                } else if completesTurn {
                    flushActivities()
                }
                if completesTurn { userMessage = nil }
                result.append(.entry(item))
            }
        }
        flushActivities()
        return result
    }

    static func renderItems(from presentation: [RailgunTranscriptPresentationItem]) -> [RailgunTranscriptRenderItem] {
        var result: [RailgunTranscriptRenderItem] = []
        var activities: [RailgunActivityEntry] = []

        func flushActivities() {
            guard !activities.isEmpty else { return }
            result.append(.activityRows(activities))
            activities = []
        }

        for item in presentation {
            switch item {
            case let .worked(entries):
                flushActivities()
                result.append(.worked(entries))
            case let .entry(.activity(activity)):
                activities.append(activity)
            case let .entry(.message(message)):
                flushActivities()
                result.append(.message(message))
            }
        }
        flushActivities()
        return result
    }
}

struct RailgunActivityDashboardPresentation: Equatable {
    enum Section: Equatable { case advisor, todos, subagents }

    let sections: [Section]
    let completedTodos: Int
    let totalTodos: Int
    let isLoadingTodos: Bool

    init(activity: RailgunActivityState) {
        var sections: [Section] = []
        if !activity.advisorNotes.isEmpty { sections.append(.advisor) }
        if activity.isLoadingTodos || !activity.todos.isEmpty { sections.append(.todos) }
        if !activity.subagents.isEmpty { sections.append(.subagents) }
        self.sections = sections
        completedTodos = activity.todos.filter { $0.status == .completed }.count
        totalTodos = activity.todos.count
        isLoadingTodos = activity.isLoadingTodos
    }

    var isVisible: Bool { !sections.isEmpty }

    var todoProgress: String {
        isLoadingTodos ? "Updating todos…" : "\(completedTodos) of \(totalTodos) complete"
    }
}

struct RailgunActivityRows: View {
    let entries: [RailgunActivityEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(RailgunActivityGrouping.rows(for: entries).enumerated()), id: \.offset) { _, item in
                switch item {
                case let .entry(entry):
                    RailgunActivityEntryRow(entry: entry)
                case let .toolGroup(name, status, entries):
                    RailgunToolActivityGroupRow(name: name, status: status, entries: entries)
                }
            }
        }
    }
}

private struct RailgunToolActivityGroupRow: View {
    let name: String
    let status: RailgunActivityStatus
    let entries: [RailgunActivityEntry]

    var body: some View {
        let presentation = RailgunActivityPresentation.groupedTool(name: name, status: status)
        RailgunActivityExpander(
            accessibilityLabel: "\(presentation.action) — \(entries.count) tool \(entries.count == 1 ? "use" : "uses")"
        ) {
            Label(presentation.action, systemImage: presentation.symbol.rawValue)
                .foregroundStyle(foregroundStyle)
        } content: {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                    RailgunActivityEntryRow(entry: entry)
                }
            }
            .padding(.leading, 20)
            .padding(.top, 8)
        }
    }

    private var foregroundStyle: Color {
        switch status {
        case .error: .red
        case .interrupted: .orange
        case .running, .success: .primary
        }
    }
}

private struct RailgunActivityEntryRow: View {
    let entry: RailgunActivityEntry

    var body: some View {
        switch entry {
        case let .tool(_, name, status, _, input, output):
            toolRow(name: name, status: status, input: input, output: output)
        case let .moaReference(_, index, count, model, status, _, preview):
            activityCard(
                title: "Reference \(index + 1) of \(count)",
                subtitle: model,
                status: status,
                detail: preview
            )
        case let .moaAggregation(_, model, referenceCount, status, _):
            activityCard(
                title: "Aggregating \(referenceCount) \(referenceCount == 1 ? "reference" : "references")",
                subtitle: model,
                status: status,
                detail: nil
            )
        }
    }

    private func toolRow(name: String, status: RailgunActivityStatus, input: String?, output: String?) -> some View {
        let presentation = RailgunActivityPresentation.tool(name: name, input: input, status: status)
        return RailgunActivityExpander(
            accessibilityLabel: "\(name) — \(RailgunActivityPresentation.statusLabel(status))"
        ) {
            HStack(spacing: 6) {
                Image(systemName: presentation.symbol.rawValue)
                Text(presentation.action).fontWeight(.medium)
                if let target = presentation.target {
                    Text(target)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .foregroundStyle(toolForegroundStyle(status))
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                if let input { RailgunActivityDetail(title: "Input", value: input) }
                if let output { RailgunActivityDetail(title: "Output", value: output) }
            }
            .padding(.leading, 20)
            .padding(.top, 8)
        }
    }

    private func activityCard(title: String, subtitle: String, status: RailgunActivityStatus, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).fontWeight(.semibold)
                Spacer()
                Text(RailgunActivityPresentation.statusLabel(status))
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(toolForegroundStyle(status))
            }
            Text(subtitle).foregroundStyle(.secondary)
            if let detail {
                Text(detail)
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(10)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title) — \(RailgunActivityPresentation.statusLabel(status))")
    }
}

private struct RailgunActivityDetail: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(RailgunFont.interface(.caption, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(RailgunFont.interface(.caption))
                .textSelection(.enabled)
                .lineLimit(12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private func toolForegroundStyle(_ status: RailgunActivityStatus) -> Color {
    switch status {
    case .error: .red
    case .interrupted: .orange
    case .running, .success: .primary
    }
}

struct RailgunWorkedActivityDisclosure: View {
    let entries: [RailgunActivityEntry]

    var body: some View {
        RailgunActivityExpander(accessibilityLabel: "Worked", showsBottomDivider: true) {
            Text("Worked")
        } content: {
            VStack(alignment: .leading, spacing: 8) {
                RailgunActivityRows(entries: entries)
            }
            .padding(.top, 12)
        }
        .foregroundStyle(.secondary)
    }
}

/// A native button-backed disclosure whose full summary row is an activation target.
private struct RailgunActivityExpander<Label: View, Content: View>: View {
    let accessibilityLabel: String
    let showsBottomDivider: Bool
    let label: () -> Label
    let content: () -> Content
    @State private var isExpanded = false
    @State private var isHovered = false

    init(
        accessibilityLabel: String,
        showsBottomDivider: Bool = false,
        @ViewBuilder label: @escaping () -> Label,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.showsBottomDivider = showsBottomDivider
        self.label = label
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    label()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .imageScale(.small)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")

            if showsBottomDivider {
                Divider().padding(.top, 8)
            }

            if isExpanded {
                content()
            }
        }
        .opacity(isExpanded || isHovered ? 1 : 0.55)
        .animation(.easeInOut(duration: 0.15), value: isExpanded)
        .animation(.easeInOut(duration: 0.15), value: isHovered)
        .onHover { isHovered = $0 }
    }
}

struct RailgunActivityDashboard: View {
    let activity: RailgunActivityState

    var body: some View {
        let presentation = RailgunActivityDashboardPresentation(activity: activity)
        List {
            if presentation.sections.contains(.advisor) {
                Section("Advisor") { RailgunAdvisorDashboardRow(notes: activity.advisorNotes) }
            }
            if presentation.sections.contains(.todos) {
                Section("Todos") {
                    Text(presentation.todoProgress)
                        .font(RailgunFont.interface(.caption))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(presentation.todoProgress)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(activity.todos, id: \.id) { todo in
                                RailgunTodoRow(todo: todo)
                            }
                        }
                    }
                    .frame(maxHeight: 144)
                }
            }
            if presentation.sections.contains(.subagents) {
                Section("Subagents") {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(activity.subagents, id: \.index) { subagent in
                                RailgunSubagentDashboardRow(subagent: subagent)
                            }
                        }
                    }
                    .frame(maxHeight: 144)
                }
            }
        }
        .listStyle(.inset)
        .accessibilityIdentifier("activity-dashboard")
        .accessibilityLabel("Activity Dashboard")
    }
}

private struct RailgunAdvisorDashboardRow: View {
    let notes: [RailgunAdvisorNote]
    @State private var isPresented = false

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            RailgunDashboardAgentLabel(
                title: "Advisor",
                status: "\(notes.count) \(notes.count == 1 ? "note" : "notes")",
                symbol: "lightbulb",
                tint: .orange
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Advisor — \(notes.count) \(notes.count == 1 ? "note" : "notes")")
        .popover(isPresented: $isPresented) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Advisor notes").font(RailgunFont.interface(.headline))
                ForEach(notes, id: \.order) { note in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(note.severity.rawValue)
                            .font(RailgunFont.interface(.caption, weight: .bold))
                            .foregroundStyle(advisorColor(note.severity))
                        Text(note.text).textSelection(.enabled)
                    }
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(advisorColor(note.severity)).frame(width: 3)
                    }
                }
            }
            .padding()
            .frame(width: 320)
        }
    }
}

private struct RailgunTodoRow: View {
    let todo: RailgunTodo

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: todoSymbol(todo.status))
                .foregroundStyle(todoColor(todo.status))
                .accessibilityHidden(true)
            Text(todo.content).frame(maxWidth: .infinity, alignment: .leading)
            Text(todoLabel(todo.status))
                .font(RailgunFont.interface(.caption))
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(todo.content) — \(todoLabel(todo.status))")
    }
}

private struct RailgunSubagentDashboardRow: View {
    let subagent: RailgunSubagentActivity
    @State private var isPresented = false

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            RailgunDashboardAgentLabel(
                title: subagent.goal,
                status: subagentLabel(subagent.status),
                symbol: "person.2",
                tint: subagentColor(subagent.status)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(subagent.goal) — \(subagentLabel(subagent.status))")
        .popover(isPresented: $isPresented) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Subagent · \(subagentLabel(subagent.status))")
                    .font(RailgunFont.interface(.caption, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(subagent.goal).font(RailgunFont.interface(.headline))
                if let result = subagent.result {
                    Text("Final result")
                        .font(RailgunFont.interface(.caption, weight: .semibold))
                        .foregroundStyle(.secondary)
                    RailgunMarkdownMessage(markdown: result)
                }
            }
            .padding()
            .frame(width: 340, height: subagent.result == nil ? nil : 360)
        }
    }
}

private struct RailgunDashboardAgentLabel: View {
    let title: String
    let status: String
    let symbol: String
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).lineLimit(1)
                Text(status)
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}

private func todoLabel(_ status: RailgunTodoStatus) -> String {
    switch status {
    case .pending: "Pending"
    case .inProgress: "In progress"
    case .completed: "Completed"
    case .cancelled: "Cancelled"
    }
}

private func todoSymbol(_ status: RailgunTodoStatus) -> String {
    switch status {
    case .pending: "circle"
    case .inProgress: "arrow.right.circle.fill"
    case .completed: "checkmark.circle.fill"
    case .cancelled: "xmark.circle"
    }
}

private func todoColor(_ status: RailgunTodoStatus) -> Color {
    switch status {
    case .completed: .green
    case .inProgress: .accentColor
    case .cancelled: .secondary
    case .pending: .primary
    }
}

private func advisorColor(_ severity: RailgunAdvisorSeverity) -> Color {
    switch severity {
    case .nit: .accentColor
    case .concern: .orange
    case .blocker: .red
    }
}

private func subagentLabel(_ status: RailgunSubagentActivity.Status) -> String {
    switch status {
    case .running: "Running"
    case .completed: "Completed"
    case .interrupted: "Interrupted"
    }
}

private func subagentColor(_ status: RailgunSubagentActivity.Status) -> Color {
    switch status {
    case .running: .accentColor
    case .completed: .green
    case .interrupted: .orange
    }
}
