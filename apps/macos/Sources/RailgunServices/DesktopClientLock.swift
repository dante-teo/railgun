import Darwin
import Foundation

/// Identifies a desktop client participating in the shared Railgun data lock.
public struct DesktopClientLockIdentity: Sendable, Equatable {
    public let bundleID: String
    public let clientName: String

    public init(bundleID: String, clientName: String) {
        precondition(!bundleID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        precondition(!clientName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        self.bundleID = bundleID
        self.clientName = clientName
    }

    public static let railgunX = Self(bundleID: "io.anvia.railgun", clientName: "Railgun")
    public static let railgunClassic = Self(bundleID: "sh.railgun.desktop", clientName: "Railgun Classic")
}

/// The cross-client lock record stored as JSON at `~/.railgun/desktop-client.lock`.
///
/// Field names intentionally match Railgun Classic's Node implementation.
public struct DesktopClientLockRecord: Sendable, Equatable, Codable {
    public let pid: Int32
    public let bundleID: String
    public let clientName: String
    public let startTime: String

    public init(pid: Int32, bundleID: String, clientName: String, startTime: String) {
        precondition(pid > 0, "The client PID must be positive.")
        precondition(!bundleID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        precondition(!clientName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        precondition(!startTime.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        self.pid = pid
        self.bundleID = bundleID
        self.clientName = clientName
        self.startTime = startTime
    }

    enum CodingKeys: String, CodingKey {
        case pid
        case bundleID = "bundleId"
        case clientName
        case startTime
    }

    public init(data: Data) throws {
        let record = try JSONDecoder().decode(Self.self, from: data)
        guard record.pid > 0,
              !record.bundleID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !record.clientName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !record.startTime.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: [], debugDescription: "The desktop-client lock record is invalid.")
            )
        }
        self = record
    }

    public func encodedData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
}

public enum DesktopClientLockError: Error, Sendable, Equatable {
    /// A valid record exists and its owner process is still alive.
    case conflict(DesktopClientLockRecord)
    /// The existing file cannot be proved stale, so it is deliberately retained.
    case invalidExistingLock
    case filesystem(String)
}

/// Owns native Railgun's participation in the shared desktop-client exclusion lock.
///
/// The actor uses `O_EXCL` creation rather than a check-then-write sequence, so
/// Native Railgun and Classic cannot both claim the same lock. Only a syntactically
/// valid record whose PID is demonstrably gone is removed as stale.
public actor DesktopClientLock {
    public static let filename = "desktop-client.lock"
    private static let recoveryFilename = "desktop-client.lock.recovery"

    public nonisolated let fileURL: URL
    private let recoveryFileURL: URL

    private let identity: DesktopClientLockIdentity
    private let processID: Int32
    private let startTime: String
    private let isProcessLive: @Sendable (Int32) -> Bool
    private var ownedRecord: DesktopClientLockRecord?

    public init(
        directory: URL,
        identity: DesktopClientLockIdentity = .railgunX,
        processID: Int32 = getpid(),
        startTime: String = ISO8601DateFormatter().string(from: Date()),
        isProcessLive: (@Sendable (Int32) -> Bool)? = nil
    ) {
        precondition(processID > 0, "The client PID must be positive.")
        self.fileURL = directory.appendingPathComponent(Self.filename, isDirectory: false)
        self.recoveryFileURL = directory.appendingPathComponent(Self.recoveryFilename, isDirectory: false)
        self.identity = identity
        self.processID = processID
        self.startTime = startTime
        self.isProcessLive = isProcessLive ?? Self.defaultIsProcessLive
    }

    /// Claims the shared data lock, recovering one valid stale record if needed.
    @discardableResult
    public func acquire() throws -> DesktopClientLockRecord {
        if let ownedRecord {
            return ownedRecord
        }

        let record = DesktopClientLockRecord(
            pid: processID,
            bundleID: identity.bundleID,
            clientName: identity.clientName,
            startTime: startTime
        )
        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        // A competing client can claim the file while stale recovery is in
        // progress. The recovery guard serializes removals, and every retry
        // validates a replacement before touching it.
        for _ in 0 ..< 3 {
            do {
                try createLockFile(containing: record)
                ownedRecord = record
                return record
            } catch let error as POSIXError where error.code == .EEXIST {
                try claimRecoveryGuard(containing: record)
                defer { releaseRecoveryGuard(containing: record) }

                let existingRecord: DesktopClientLockRecord
                do {
                    existingRecord = try DesktopClientLockRecord(data: Data(contentsOf: fileURL))
                } catch {
                    throw DesktopClientLockError.invalidExistingLock
                }

                if isProcessLive(existingRecord.pid) {
                    throw DesktopClientLockError.conflict(existingRecord)
                }

                do {
                    try fileManager.removeItem(at: fileURL)
                } catch {
                    throw DesktopClientLockError.filesystem(error.localizedDescription)
                }

                do {
                    try createLockFile(containing: record)
                    ownedRecord = record
                    return record
                } catch let error as POSIXError where error.code == .EEXIST {
                    continue
                } catch {
                    throw DesktopClientLockError.filesystem(error.localizedDescription)
                }
            } catch {
                throw DesktopClientLockError.filesystem(error.localizedDescription)
            }
        }

        throw DesktopClientLockError.filesystem("Could not claim the shared desktop-client lock.")
    }

    /// Releases this client's exact lock record. A replacement is never removed.
    public func release() {
        guard let ownedRecord else { return }
        defer { self.ownedRecord = nil }

        guard let existing = try? DesktopClientLockRecord(data: Data(contentsOf: fileURL)), existing == ownedRecord else {
            return
        }
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func createLockFile(containing record: DesktopClientLockRecord) throws {
        try createFile(at: fileURL, containing: record)
    }

    private func claimRecoveryGuard(containing record: DesktopClientLockRecord) throws {
        for _ in 0 ..< 3 {
            do {
                try createFile(at: recoveryFileURL, containing: record)
                return
            } catch let error as POSIXError where error.code == .EEXIST {
                let existingRecord: DesktopClientLockRecord
                do {
                    existingRecord = try DesktopClientLockRecord(data: Data(contentsOf: recoveryFileURL))
                } catch {
                    throw DesktopClientLockError.invalidExistingLock
                }
                if isProcessLive(existingRecord.pid) {
                    throw DesktopClientLockError.conflict(existingRecord)
                }
                try? FileManager.default.removeItem(at: recoveryFileURL)
            }
        }
        throw DesktopClientLockError.filesystem("Could not claim stale-lock recovery.")
    }

    private func releaseRecoveryGuard(containing record: DesktopClientLockRecord) {
        guard let existing = try? DesktopClientLockRecord(data: Data(contentsOf: recoveryFileURL)), existing == record else {
            return
        }
        try? FileManager.default.removeItem(at: recoveryFileURL)
    }

    private func createFile(at url: URL, containing record: DesktopClientLockRecord) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            if errno == EEXIST { throw POSIXError(.EEXIST) }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }

        var needsClose = true
        do {
            let data = try record.encodedData()
            try data.withUnsafeBytes { buffer in
                guard let baseAddress = buffer.baseAddress else { return }
                var written = 0
                while written < buffer.count {
                    let result = write(descriptor, baseAddress.advanced(by: written), buffer.count - written)
                    guard result > 0 else {
                        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                    }
                    written += result
                }
            }
            guard fsync(descriptor) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            let closeResult = close(descriptor)
            needsClose = false
            guard closeResult == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        } catch {
            if needsClose { _ = close(descriptor) }
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    private static func defaultIsProcessLive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }
}
