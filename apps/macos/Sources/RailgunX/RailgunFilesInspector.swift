import Observation
import SwiftUI

enum RailgunFilesDirectoryPhase: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

struct RailgunFilesDirectoryState: Equatable {
    var entries: [RailgunFileEntry] = []
    var phase: RailgunFilesDirectoryPhase = .idle
    var generation = 0
}

@MainActor
@Observable
final class RailgunFilesBrowserStore {
    private let listing: any RailgunFileListing
    private var directories: [RailgunFilePath: RailgunFilesDirectoryState] = [.home: .init()]

    private(set) var expandedPaths: Set<RailgunFilePath> = []
    var selection: RailgunFilePath?

    init(listing: any RailgunFileListing) {
        self.listing = listing
    }

    func open() {
        load(.home)
    }

    func state(for path: RailgunFilePath) -> RailgunFilesDirectoryState {
        directories[path] ?? .init()
    }

    func setExpanded(_ isExpanded: Bool, path: RailgunFilePath) {
        if isExpanded {
            expandedPaths.insert(path)
            load(path)
        } else {
            expandedPaths.remove(path)
        }
    }

    func retry(path: RailgunFilePath) {
        load(path, force: true)
    }

    func refresh() {
        guard let selection else {
            retry(path: .home)
            return
        }

        let parent = selection.parent
        guard entry(at: selection)?.kind == .directory else {
            retry(path: parent)
            return
        }

        // A directory can be deleted or replaced after it was cached. Refresh
        // its parent as well, so the tree reflects that external change even
        // when listing the selected path now fails.
        retry(path: selection)
        retry(path: parent)
    }

    private func entry(at path: RailgunFilePath) -> RailgunFileEntry? {
        directories[path.parent]?.entries.first(where: { $0.path == path })
    }

    private func load(_ path: RailgunFilePath, force: Bool = false) {
        let current = state(for: path)
        guard force || current.phase != .loading else { return }
        guard force || current.phase != .loaded else { return }

        var next = current
        next.generation += 1
        let generation = next.generation
        next.phase = .loading
        directories[path] = next

        let listing = listing
        Task { [weak self] in
            let result: Result<[RailgunFileEntry], Error>
            do {
                result = .success(try await listing.list(pathSegments: path.segments))
            } catch {
                result = .failure(error)
            }
            guard let self, self.state(for: path).generation == generation else { return }

            var resolved = self.state(for: path)
            switch result {
            case let .success(entries):
                resolved.entries = entries
                resolved.phase = .loaded
            case let .failure(error):
                resolved.phase = .failed(Self.presentationMessage(for: error))
            }
            self.directories[path] = resolved
        }
    }

    private static func presentationMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "The folder could not be read."
    }
}

struct RailgunFilesInspector: View {
    @Bindable var store: RailgunFilesBrowserStore
    @Binding var isPresented: Bool

    var body: some View {
        List(selection: $store.selection) {
            RailgunFilesRootContents(store: store)
        }
        .navigationTitle("Files")
        .toolbar {
            if isPresented {
                ToolbarItem(placement: .automatic) {
                    Button("Refresh Files", systemImage: "arrow.clockwise") {
                        store.refresh()
                    }
                    .help("Refresh Files")
                }
            }
        }
        .task {
            store.open()
        }
    }
}

private struct RailgunFilesRootContents: View {
    @Bindable var store: RailgunFilesBrowserStore

    var body: some View {
        let directory = store.state(for: .home)
        switch directory.phase {
        case .idle, .loading:
            ProgressView("Loading Files…")
        case let .failed(message):
            ContentUnavailableView("Files Unavailable", systemImage: "exclamationmark.triangle", description: Text(message))
            Button("Retry") { store.retry(path: .home) }
        case .loaded where directory.entries.isEmpty:
            ContentUnavailableView("No Files", systemImage: "folder", description: Text("This folder is empty."))
        case .loaded:
            RailgunFilesDirectoryRows(store: store, path: .home)
        }
    }
}

private struct RailgunFilesDirectoryRows: View {
    @Bindable var store: RailgunFilesBrowserStore
    let path: RailgunFilePath

    var body: some View {
        let directory = store.state(for: path)
        ForEach(directory.entries) { entry in
            RailgunFilesTreeRow(store: store, entry: entry)
        }
        if case let .failed(message) = directory.phase {
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
            Button("Retry") { store.retry(path: path) }
        } else if case .loading = directory.phase {
            ProgressView()
        }
    }
}

private struct RailgunFilesTreeRow: View {
    @Bindable var store: RailgunFilesBrowserStore
    let entry: RailgunFileEntry

    var body: some View {
        switch entry.kind {
        case .directory:
            DisclosureGroup(
                isExpanded: Binding(
                    get: { store.expandedPaths.contains(entry.path) },
                    set: { store.setExpanded($0, path: entry.path) }
                )
            ) {
                RailgunFilesDirectoryRows(store: store, path: entry.path)
            } label: {
                Label(entry.name, systemImage: entry.isSymbolicLink ? "folder.badge.link" : "folder")
            }
            .tag(entry.path)
        case .file:
            Label(entry.name, systemImage: entry.isSymbolicLink ? "doc.badge.link" : "doc")
                .tag(entry.path)
        case .unavailable:
            Label(entry.name, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
                .tag(entry.path)
                .help("This item is unavailable.")
        }
    }
}
