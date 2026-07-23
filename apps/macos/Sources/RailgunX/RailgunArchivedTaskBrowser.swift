import AppKit
import RailgunUI
import SwiftUI

/// Determines which archive state should be visible without changing the
/// backend-provided ordering of archived tasks.
enum RailgunArchivedTaskBrowserPresentation: Equatable {
    case loading
    case empty
    case noResults
    case tasks([RailgunArchivedSessionSummary])

    init(session: RailgunSessionState, query: String) {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let tasks = trimmedQuery.isEmpty
            ? session.archivedSessions
            : session.archivedSessions.filter { task in
                task.session.displayTitle.localizedCaseInsensitiveContains(trimmedQuery)
                    || task.session.model.localizedCaseInsensitiveContains(trimmedQuery)
                    || task.id.localizedCaseInsensitiveContains(trimmedQuery)
            }

        if session.isLoading, session.archivedSessions.isEmpty {
            self = .loading
        } else if session.archivedSessions.isEmpty {
            self = .empty
        } else if tasks.isEmpty {
            self = .noResults
        } else {
            self = .tasks(tasks)
        }
    }
}

struct RailgunArchivedTaskBrowserAvailability: Equatable {
    let canRestore: Bool

    init(session: RailgunSessionState, backendPhase: RailgunBackendPhase) {
        guard case .ready = backendPhase else {
            canRestore = false
            return
        }
        canRestore = session.restoreInFlightSessionID == nil
    }
}

/// A narrow AppKit boundary for macOS's system clipboard. SwiftUI owns the
/// browser state and dispatches this discrete imperative copy operation.
@MainActor
struct RailgunTaskIDPasteboard {
    private let pasteboard: NSPasteboard

    init(pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
    }

    @discardableResult
    func copy(_ taskID: String) -> Bool {
        pasteboard.clearContents()
        return pasteboard.setString(taskID, forType: .string)
    }
}

struct RailgunArchivedTaskBrowser: View {
    let session: RailgunSessionState
    let backendPhase: RailgunBackendPhase
    let restore: (String) -> Void
    let taskIDPasteboard: RailgunTaskIDPasteboard

    @State private var searchText = ""
    @State private var selectedTaskIDs = Set<RailgunArchivedSessionSummary.ID>()

    init(
        session: RailgunSessionState,
        backendPhase: RailgunBackendPhase,
        restore: @escaping (String) -> Void,
        taskIDPasteboard: RailgunTaskIDPasteboard = .init()
    ) {
        self.session = session
        self.backendPhase = backendPhase
        self.restore = restore
        self.taskIDPasteboard = taskIDPasteboard
    }

    var body: some View {
        let presentation = RailgunArchivedTaskBrowserPresentation(session: session, query: searchText)
        let availability = RailgunArchivedTaskBrowserAvailability(
            session: session,
            backendPhase: backendPhase
        )

        VStack(alignment: .leading, spacing: RailgunSpacing.standard.points) {
            if let error = session.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(RailgunFont.interface(.callout))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("archived-task-error")
            }

            browserContent(presentation, availability: availability)

            if session.isLoading, !session.archivedSessions.isEmpty {
                ProgressView("Refreshing archived tasks…")
                    .controlSize(.small)
            }
            if session.restoreInFlightSessionID != nil {
                ProgressView("Restoring task…")
                    .controlSize(.small)
                    .accessibilityIdentifier("restore-archived-task-progress")
            }
        }
        .searchable(text: $searchText, prompt: "Search archived tasks")
    }

    @ViewBuilder
    private func browserContent(
        _ presentation: RailgunArchivedTaskBrowserPresentation,
        availability: RailgunArchivedTaskBrowserAvailability
    ) -> some View {
        switch presentation {
        case .loading:
            ProgressView("Loading archived tasks…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No Archived Tasks",
                systemImage: "archivebox",
                description: Text("Tasks you archive will appear here.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .noResults:
            ContentUnavailableView(
                "No Matching Archived Tasks",
                systemImage: "magnifyingglass",
                description: Text("Try a task title, model, or task ID.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .tasks(tasks):
            Table(tasks, selection: $selectedTaskIDs) {
                TableColumn("Task") { task in
                    Text(task.session.displayTitle)
                        .lineLimit(1)
                }
                TableColumn("Model") { task in
                    Text(task.session.model)
                        .lineLimit(1)
                }
                TableColumn("Messages") { task in
                    Text(task.session.messageCount, format: .number)
                }
                TableColumn("Archived") { task in
                    Text(task.archivedAt, format: .dateTime.year().month().day().hour().minute())
                }
                TableColumn("Actions") { task in
                    Button("Restore") {
                        restore(task.id)
                    }
                    .disabled(!availability.canRestore)
                    .accessibilityIdentifier("restore-archived-task-\(task.id)")
                }
            }
            .contextMenu(forSelectionType: RailgunArchivedSessionSummary.ID.self) { taskIDs in
                if taskIDs.count == 1, let taskID = taskIDs.first {
                    Button("Restore") {
                        restore(taskID)
                    }
                    .disabled(!availability.canRestore)

                    Divider()

                    Button("Copy Task ID") {
                        taskIDPasteboard.copy(taskID)
                    }
                }
            } primaryAction: { _ in
            }
        }
    }
}
