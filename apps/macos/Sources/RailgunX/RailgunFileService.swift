import Foundation

enum RailgunFileEntryKind: Equatable, Sendable {
    case directory
    case file
    case unavailable
}

struct RailgunFilePath: Hashable, Sendable {
    let segments: [String]

    static let home = Self(segments: [])

    var parent: Self {
        Self(segments: Array(segments.dropLast()))
    }
}

struct RailgunFileEntry: Identifiable, Equatable, Sendable {
    let name: String
    let path: RailgunFilePath
    let kind: RailgunFileEntryKind
    let isSymbolicLink: Bool

    var id: RailgunFilePath { path }
}

enum RailgunFileServiceError: LocalizedError, Equatable, Sendable {
    case invalidLocation
    case unavailable
    case notDirectory
    case tooManyEntries

    var errorDescription: String? {
        switch self {
        case .invalidLocation:
            "That folder location is unavailable."
        case .unavailable:
            "The folder could not be read."
        case .notDirectory:
            "That item is not a folder."
        case .tooManyEntries:
            "This folder contains too many items to display."
        }
    }
}

protocol RailgunFileListing: Sendable {
    func list(pathSegments: [String]) async throws -> [RailgunFileEntry]
}

/// Lists only regular files and directories located beneath the configured
/// home directory. Every target is canonicalized before it is inspected so a
/// symlink cannot expand the Files inspector's authority beyond that root.
actor RailgunFileService: RailgunFileListing {
    static let maximumDepth = 128
    static let maximumSegmentLength = 255
    static let maximumEntryCount = 5_000

    private let homeRoot: URL
    private let fileManager: FileManager

    init(homeURL: URL = FileManager.default.homeDirectoryForCurrentUser, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        homeRoot = Self.canonicalURL(homeURL)
    }

    func list(pathSegments: [String]) throws -> [RailgunFileEntry] {
        try Self.validate(pathSegments: pathSegments)
        let directoryURL = try resolvedURL(for: pathSegments)

        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: directoryURL.path, isDirectory: &isDirectory) else {
            throw RailgunFileServiceError.unavailable
        }
        guard isDirectory.boolValue else {
            throw RailgunFileServiceError.notDirectory
        }
        guard fileManager.isReadableFile(atPath: directoryURL.path) else {
            throw RailgunFileServiceError.unavailable
        }

        let urls: [URL]
        do {
            urls = try fileManager.contentsOfDirectory(
                at: directoryURL,
                includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isReadableKey],
                options: []
            )
        } catch {
            throw RailgunFileServiceError.unavailable
        }
        guard urls.count <= Self.maximumEntryCount else {
            throw RailgunFileServiceError.tooManyEntries
        }

        return urls.map { entryURL in
            entry(for: entryURL, parentSegments: pathSegments)
        }
        .sorted(by: Self.sortEntries)
    }

    private func resolvedURL(for pathSegments: [String]) throws -> URL {
        let candidate = pathSegments.reduce(homeRoot) { partialResult, segment in
            partialResult.appendingPathComponent(segment, isDirectory: false)
        }
        let resolved = Self.canonicalURL(candidate)
        guard Self.isContained(resolved, by: homeRoot) else {
            throw RailgunFileServiceError.invalidLocation
        }
        return resolved
    }

    private func entry(for entryURL: URL, parentSegments: [String]) -> RailgunFileEntry {
        let name = entryURL.lastPathComponent
        let path = RailgunFilePath(segments: parentSegments + [name])
        let isSymbolicLink = (try? entryURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true
        let unavailable = RailgunFileEntry(
            name: name,
            path: path,
            kind: .unavailable,
            isSymbolicLink: isSymbolicLink
        )
        let resolved = Self.canonicalURL(entryURL)

        guard Self.isContained(resolved, by: homeRoot), fileManager.fileExists(atPath: resolved.path) else {
            return unavailable
        }

        let values: URLResourceValues
        do {
            values = try resolved.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isReadableKey])
        } catch {
            return unavailable
        }
        guard values.isReadable != false, fileManager.isReadableFile(atPath: resolved.path) else {
            return unavailable
        }
        guard !(isSymbolicLink && values.isDirectory == true && resolvesToDirectoryAncestor(
            resolved,
            from: parentSegments
        )) else {
            return unavailable
        }

        let kind: RailgunFileEntryKind
        if values.isDirectory == true {
            kind = .directory
        } else if values.isRegularFile == true {
            kind = .file
        } else {
            kind = .unavailable
        }
        return RailgunFileEntry(name: name, path: path, kind: kind, isSymbolicLink: isSymbolicLink)
    }

    private func resolvesToDirectoryAncestor(_ resolved: URL, from parentSegments: [String]) -> Bool {
        (0...parentSegments.count).contains { depth in
            let ancestor = parentSegments.prefix(depth).reduce(homeRoot) { directory, segment in
                directory.appendingPathComponent(segment, isDirectory: true)
            }
            return Self.canonicalURL(ancestor) == resolved
        }
    }

    private static func validate(pathSegments: [String]) throws {
        guard pathSegments.count <= maximumDepth else {
            throw RailgunFileServiceError.invalidLocation
        }
        for segment in pathSegments {
            guard !segment.isEmpty,
                  segment.utf8.count <= maximumSegmentLength,
                  !segment.contains("/"),
                  !segment.contains("\0"),
                  segment != ".",
                  segment != ".."
            else {
                throw RailgunFileServiceError.invalidLocation
            }
        }
    }

    private static func canonicalURL(_ url: URL) -> URL {
        url.resolvingSymlinksInPath().standardizedFileURL
    }

    private static func isContained(_ url: URL, by root: URL) -> Bool {
        url == root || url.path.hasPrefix(root.path + "/")
    }

    private static func sortEntries(_ lhs: RailgunFileEntry, _ rhs: RailgunFileEntry) -> Bool {
        if (lhs.kind == .directory) != (rhs.kind == .directory) {
            return lhs.kind == .directory
        }
        let insensitive = lhs.name.caseInsensitiveCompare(rhs.name)
        if insensitive != .orderedSame {
            return insensitive == .orderedAscending
        }
        return lhs.name.compare(rhs.name, options: .literal) == .orderedAscending
    }
}
