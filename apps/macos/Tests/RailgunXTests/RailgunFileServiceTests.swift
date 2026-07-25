import Darwin
import Foundation
import XCTest
import RailgunTestSupport
@testable import RailgunX

@MainActor
final class RailgunFileServiceTests: XCTestCase {
    func testListsHiddenFilesAndSortsDirectoriesBeforeFiles() async throws {
        let home = try temporaryRailgunHome()
        try makeDirectory("Zoo", in: home)
        try makeDirectory("alpha", in: home)
        try makeFile("beta.txt", in: home)
        try makeFile(".hidden", in: home)

        let entries = try await RailgunFileService(homeURL: home.url).list(pathSegments: [])

        XCTAssertEqual(entries.map(\.name), [".railgun", "alpha", "Zoo", ".hidden", "beta.txt"])
        XCTAssertEqual(entries.map(\.kind), [.directory, .directory, .directory, .file, .file])
    }

    func testListsValidatedNestedPathsAndAllowsOrdinaryBackslashAndDotPrefixedNames() async throws {
        let home = try temporaryRailgunHome()
        try makeDirectory("nested", in: home)
        try makeFile("..name", in: home.url.appendingPathComponent("nested"))
        try makeFile("back\\slash", in: home.url.appendingPathComponent("nested"))
        let service = RailgunFileService(homeURL: home.url)

        let entries = try await service.list(pathSegments: ["nested"])

        XCTAssertEqual(entries.map(\.name), ["..name", "back\\slash"])
        for invalid in ["", ".", "..", "/absolute", "nested/child", "null\0byte"] {
            await assertInvalidPath([invalid], service: service)
        }
        await assertInvalidPath(Array(repeating: "deep", count: RailgunFileService.maximumDepth + 1), service: service)
    }

    func testContainsOnlySafeSymlinksAndMarksEscapingBrokenAndSpecialItemsUnavailable() async throws {
        let home = try temporaryRailgunHome()
        try makeDirectory("inside", in: home)
        try makeFile("safe.txt", in: home.url.appendingPathComponent("inside"))
        let insideLink = home.url.appendingPathComponent("inside-link")
        let escapingLink = home.url.appendingPathComponent("escaping-link")
        let brokenLink = home.url.appendingPathComponent("broken-link")
        let cyclicLink = home.url.appendingPathComponent("loop")
        let ancestorLink = home.url.appendingPathComponent("inside/ancestor")
        try FileManager.default.createSymbolicLink(at: insideLink, withDestinationURL: home.url.appendingPathComponent("inside"))
        try FileManager.default.createSymbolicLink(at: escapingLink, withDestinationURL: URL(fileURLWithPath: "/private/tmp"))
        try FileManager.default.createSymbolicLink(at: brokenLink, withDestinationURL: home.url.appendingPathComponent("missing"))
        try FileManager.default.createSymbolicLink(at: cyclicLink, withDestinationURL: home.url)
        try FileManager.default.createSymbolicLink(at: ancestorLink, withDestinationURL: home.url)

        let fifo = home.url.appendingPathComponent("special")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)

        let service = RailgunFileService(homeURL: home.url)
        let entries = try await service.list(pathSegments: [])
        let byName = Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0) })
        let insideEntries = try await service.list(pathSegments: ["inside"])
        let insideByName = Dictionary(uniqueKeysWithValues: insideEntries.map { ($0.name, $0) })

        XCTAssertEqual(byName["inside-link"]?.kind, .directory)
        XCTAssertTrue(byName["inside-link"]?.isSymbolicLink == true)
        XCTAssertEqual(byName["escaping-link"]?.kind, .unavailable)
        XCTAssertEqual(byName["broken-link"]?.kind, .unavailable)
        XCTAssertEqual(byName["loop"]?.kind, .unavailable)
        XCTAssertEqual(insideByName["ancestor"]?.kind, .unavailable)
        XCTAssertEqual(byName["special"]?.kind, .unavailable)
    }

    func testRejectsFoldersAboveTheEntryLimit() async throws {
        let home = try temporaryRailgunHome()
        let service = RailgunFileService(homeURL: home.url)
        for index in 0...RailgunFileService.maximumEntryCount {
            try makeFile("item-\(index)", in: home)
        }

        do {
            _ = try await service.list(pathSegments: [])
            XCTFail("Expected an entry-limit error")
        } catch let error as RailgunFileServiceError {
            XCTAssertEqual(error, .tooManyEntries)
        }
    }

    func testBrowserStoreLoadsLazilyCachesBranchesAndRefreshesSelectedDirectoriesAndParents() async {
        let child = entry(name: "child", kind: .directory)
        let file = entry(name: "file.txt", kind: .file)
        let listing = RailgunFileListingStub(responses: [
            .home: [child, file],
            child.path: [],
        ])
        let store = RailgunFilesBrowserStore(listing: listing)

        store.open()
        await waitUntil { store.state(for: .home).phase == .loaded }
        let rootLoadCount = await listing.callCount(for: .home)
        XCTAssertEqual(rootLoadCount, 1)

        store.setExpanded(true, path: child.path)
        await waitUntil { store.state(for: child.path).phase == .loaded }
        store.setExpanded(false, path: child.path)
        store.setExpanded(true, path: child.path)
        let childLoadCount = await listing.callCount(for: child.path)
        XCTAssertEqual(childLoadCount, 1)

        store.selection = child.path
        store.refresh()
        await waitUntil {
            let parentRefreshes = await listing.callCount(for: .home)
            let selectedDirectoryRefreshes = await listing.callCount(for: child.path)
            return parentRefreshes == 2 && selectedDirectoryRefreshes == 2
        }

        store.selection = file.path
        store.refresh()
        await waitUntil { await listing.callCount(for: .home) == 3 }
    }

    func testBrowserStoreSuppressesStaleDirectoryResponsesAndSupportsRetry() async {
        let listing = DeferredRailgunFileListing()
        let store = RailgunFilesBrowserStore(listing: listing)

        store.open()
        await waitUntil { await listing.callCount == 1 }
        store.retry(path: .home)
        await waitUntil { await listing.callCount == 2 }
        await listing.resolveNext(with: [entry(name: "stale", kind: .file)])
        await Task.yield()
        XCTAssertEqual(store.state(for: .home).phase, .loading)

        await listing.resolveNext(with: [entry(name: "fresh", kind: .file)])
        await waitUntil { store.state(for: .home).phase == .loaded }
        XCTAssertEqual(store.state(for: .home).entries.map(\.name), ["fresh"])

        store.retry(path: .home)
        await waitUntil { await listing.callCount == 3 }
        await listing.failNext()
        await waitUntil {
            if case .failed = store.state(for: .home).phase { return true }
            return false
        }
    }

    func testFilesInspectorUsesNativeInspectorAndStandardCommand() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let appSource = try String(
            contentsOf: root.appendingPathComponent("apps/macos/Sources/RailgunX/RailgunXApp.swift"),
            encoding: .utf8
        )
        let inspectorSource = try String(
            contentsOf: root.appendingPathComponent("apps/macos/Sources/RailgunX/RailgunFilesInspector.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(appSource.contains("Button(\"Refresh Files\", systemImage: \"arrow.clockwise\")"))
        XCTAssertTrue(appSource.contains("Button(\"Sidebar\", systemImage: \"sidebar.right\")"))
        XCTAssertTrue(appSource.contains("isFilesInspectorPresented.toggle()"))
        XCTAssertTrue(appSource.contains(".inspector(isPresented: Binding("))
        XCTAssertTrue(appSource.contains("isPresented: $isFilesInspectorPresented"))
        XCTAssertTrue(appSource.contains("appStore.state.destination == .task && isFilesInspectorPresented"))
        XCTAssertTrue(appSource.contains(".inspectorColumnWidth("))
        XCTAssertTrue(appSource.contains("InspectorCommands()"))
        XCTAssertTrue(appSource.contains("fileService: fileService"))
        XCTAssertTrue(inspectorSource.contains("ToolbarItem(placement: .automatic)"))
        XCTAssertTrue(inspectorSource.contains("if isPresented"))
        XCTAssertTrue(inspectorSource.contains("Button(\"Refresh Files\", systemImage: \"arrow.clockwise\")"))
        XCTAssertTrue(inspectorSource.contains("store.refresh()"))
    }

    private func makeDirectory(_ name: String, in home: TemporaryRailgunHome) throws {
        try makeDirectory(name, in: home.url)
    }

    private func makeDirectory(_ name: String, in directory: URL) throws {
        try FileManager.default.createDirectory(at: directory.appendingPathComponent(name), withIntermediateDirectories: false)
    }

    private func makeFile(_ name: String, in home: TemporaryRailgunHome) throws {
        try makeFile(name, in: home.url)
    }

    private func makeFile(_ name: String, in directory: URL) throws {
        guard FileManager.default.createFile(atPath: directory.appendingPathComponent(name).path, contents: Data()) else {
            throw RailgunFileTestError.fileCreationFailed(name)
        }
    }

    private func assertInvalidPath(_ path: [String], service: RailgunFileService) async {
        do {
            _ = try await service.list(pathSegments: path)
            XCTFail("Expected invalid path rejection")
        } catch let error as RailgunFileServiceError {
            XCTAssertEqual(error, .invalidLocation)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    private func entry(name: String, kind: RailgunFileEntryKind) -> RailgunFileEntry {
        RailgunFileEntry(name: name, path: .init(segments: [name]), kind: kind, isSymbolicLink: false)
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () async -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<100 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for condition", file: file, line: line)
    }
}

private actor RailgunFileListingStub: RailgunFileListing {
    private let responses: [RailgunFilePath: [RailgunFileEntry]]
    private var calls: [RailgunFilePath: Int] = [:]

    init(responses: [RailgunFilePath: [RailgunFileEntry]]) {
        self.responses = responses
    }

    func list(pathSegments: [String]) throws -> [RailgunFileEntry] {
        let path = RailgunFilePath(segments: pathSegments)
        calls[path, default: 0] += 1
        return responses[path] ?? []
    }

    func callCount(for path: RailgunFilePath) -> Int {
        calls[path, default: 0]
    }
}

private actor DeferredRailgunFileListing: RailgunFileListing {
    private var continuations: [CheckedContinuation<[RailgunFileEntry], Error>] = []
    private(set) var callCount = 0

    func list(pathSegments: [String]) async throws -> [RailgunFileEntry] {
        callCount += 1
        return try await withCheckedThrowingContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func resolveNext(with entries: [RailgunFileEntry]) {
        continuations.removeFirst().resume(returning: entries)
    }

    func failNext() {
        continuations.removeFirst().resume(throwing: RailgunFileListingFailure())
    }
}

private struct RailgunFileListingFailure: LocalizedError {
    var errorDescription: String? { "The folder could not be read." }
}

private enum RailgunFileTestError: Error {
    case fileCreationFailed(String)
}
