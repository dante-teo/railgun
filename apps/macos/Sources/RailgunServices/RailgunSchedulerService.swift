import CryptoKit
import Foundation
import RailgunTransport

public enum RailgunBackgroundSchedulerStatus: Equatable, Sendable {
    case notInstalled
    case installed(running: Bool)
    case repairNeeded
}

public struct RailgunLaunchctlResult: Equatable, Sendable {
    public let status: Int32
    public let output: String

    public init(status: Int32, output: String) {
        self.status = status
        self.output = output
    }
}

public enum RailgunBackgroundSchedulerError: Error, Equatable, Sendable {
    case launchctlFailed
    case invalidLaunch
}

public struct RailgunBackgroundSchedulerConfiguration: Sendable {
    public static let schedulerLabel = "sh.railgun.cron"
    public static let legacyDreamLabel = "sh.railgun.dream"
    public static let definitionVersion = "2"

    public let launch: BackendProcessLaunch
    public let homeDirectory: URL
    public let userID: UInt32

    public init(
        launch: BackendProcessLaunch,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        userID: UInt32
    ) {
        self.launch = launch
        self.homeDirectory = homeDirectory.standardizedFileURL
        self.userID = userID
    }

    public var launchAgentURL: URL {
        launchAgentsDirectory.appendingPathComponent("\(Self.schedulerLabel).plist")
    }

    public var legacyDreamLaunchAgentURL: URL {
        launchAgentsDirectory.appendingPathComponent("\(Self.legacyDreamLabel).plist")
    }

    public var schedulerTarget: String {
        "\(domain)/\(Self.schedulerLabel)"
    }

    public var legacyDreamTarget: String {
        "\(domain)/\(Self.legacyDreamLabel)"
    }

    public func propertyListData() throws -> Data {
        guard launch.arguments == ["scheduler"] else {
            throw RailgunBackgroundSchedulerError.invalidLaunch
        }

        let logURL = homeDirectory
            .appendingPathComponent(".railgun/logs", isDirectory: true)
            .appendingPathComponent("scheduler.log")
        let propertyList: [String: Any] = [
            "Label": Self.schedulerLabel,
            "ProgramArguments": [launch.executableURL.standardizedFileURL.path] + launch.arguments,
            "WorkingDirectory": (launch.currentDirectoryURL ?? homeDirectory).standardizedFileURL.path,
            "RunAtLoad": true,
            "KeepAlive": true,
            "ProcessType": "Background",
            "StandardOutPath": logURL.path,
            "StandardErrorPath": logURL.path,
            "EnvironmentVariables": [
                "HOME": homeDirectory.path,
                "RAILGUN_SCHEDULER_DEFINITION_VERSION": Self.definitionVersion,
                "RAILGUN_SCHEDULER_EXECUTABLE_SHA256": executableDigest,
            ],
        ]
        return try PropertyListSerialization.data(
            fromPropertyList: propertyList,
            format: .xml,
            options: 0
        )
    }

    fileprivate var domain: String {
        "gui/\(userID)"
    }

    fileprivate var launchAgentsDirectory: URL {
        homeDirectory.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    fileprivate var logDirectory: URL {
        homeDirectory.appendingPathComponent(".railgun/logs", isDirectory: true)
    }

    fileprivate func matchesInstalledPropertyList(_ data: Data) -> Bool {
        guard let propertyList = try? PropertyListSerialization.propertyList(
            from: data,
            format: nil
        ) as? [String: Any] else {
            return false
        }
        return propertyList["Label"] as? String == Self.schedulerLabel
            && propertyList["ProgramArguments"] as? [String]
                == [launch.executableURL.standardizedFileURL.path, "scheduler"]
            && propertyList["WorkingDirectory"] as? String
                == (launch.currentDirectoryURL ?? homeDirectory).standardizedFileURL.path
            && (propertyList["EnvironmentVariables"] as? [String: String])?[
                "RAILGUN_SCHEDULER_DEFINITION_VERSION"
            ] == Self.definitionVersion
            && (propertyList["EnvironmentVariables"] as? [String: String])?[
                "RAILGUN_SCHEDULER_EXECUTABLE_SHA256"
            ] == executableDigest
    }

    private var executableDigest: String {
        guard let data = try? Data(contentsOf: launch.executableURL, options: .mappedIfSafe) else {
            return "unavailable"
        }
        return SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

public actor RailgunBackgroundSchedulerService {
    public typealias LaunchctlRunner = @Sendable ([String]) async -> RailgunLaunchctlResult

    private let configuration: RailgunBackgroundSchedulerConfiguration
    private let fileManager: FileManager
    private let runLaunchctl: LaunchctlRunner

    public init(
        configuration: RailgunBackgroundSchedulerConfiguration,
        fileManager: FileManager = .default
    ) {
        self.configuration = configuration
        self.fileManager = fileManager
        self.runLaunchctl = Self.launchctl
    }

    public init(
        configuration: RailgunBackgroundSchedulerConfiguration,
        fileManager: FileManager = .default,
        runLaunchctl: @escaping LaunchctlRunner
    ) {
        self.configuration = configuration
        self.fileManager = fileManager
        self.runLaunchctl = runLaunchctl
    }

    public func status() async throws -> RailgunBackgroundSchedulerStatus {
        let schedulerExists = fileManager.fileExists(atPath: configuration.launchAgentURL.path)
        let legacyDreamExists = fileManager.fileExists(
            atPath: configuration.legacyDreamLaunchAgentURL.path
        )
        guard schedulerExists else {
            return legacyDreamExists ? .repairNeeded : .notInstalled
        }
        guard !legacyDreamExists,
              let data = fileManager.contents(atPath: configuration.launchAgentURL.path),
              configuration.matchesInstalledPropertyList(data)
        else {
            return .repairNeeded
        }

        let result = await runLaunchctl(["print", configuration.schedulerTarget])
        return .installed(
            running: result.status == 0 && result.output.contains("state = running")
        )
    }

    public func install() async throws -> RailgunBackgroundSchedulerStatus {
        try fileManager.createDirectory(
            at: configuration.launchAgentsDirectory,
            withIntermediateDirectories: true
        )
        try fileManager.createDirectory(
            at: configuration.logDirectory,
            withIntermediateDirectories: true
        )
        try configuration.propertyListData().write(
            to: configuration.launchAgentURL,
            options: .atomic
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: configuration.launchAgentURL.path
        )

        _ = await runLaunchctl(["bootout", configuration.schedulerTarget])
        _ = await runLaunchctl(["bootout", configuration.legacyDreamTarget])
        try? fileManager.removeItem(at: configuration.legacyDreamLaunchAgentURL)

        let bootstrap = await runLaunchctl([
            "bootstrap",
            configuration.domain,
            configuration.launchAgentURL.path,
        ])
        guard bootstrap.status == 0 else {
            throw RailgunBackgroundSchedulerError.launchctlFailed
        }
        let kickstart = await runLaunchctl(["kickstart", "-k", configuration.schedulerTarget])
        guard kickstart.status == 0 else {
            throw RailgunBackgroundSchedulerError.launchctlFailed
        }
        return try await status()
    }

    public func uninstall() async throws -> RailgunBackgroundSchedulerStatus {
        try await unload(configuration.schedulerTarget)
        try await unload(configuration.legacyDreamTarget)
        try removeIfPresent(configuration.launchAgentURL)
        try removeIfPresent(configuration.legacyDreamLaunchAgentURL)
        return .notInstalled
    }

    public func repairLegacyInstallationIfNeeded() async {
        guard (try? await status()) == .repairNeeded else { return }
        _ = try? await install()
    }

    private func removeIfPresent(_ url: URL) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }

    private func unload(_ target: String) async throws {
        _ = await runLaunchctl(["bootout", target])
        let inspection = await runLaunchctl(["print", target])
        guard Self.serviceIsMissing(inspection) else {
            throw RailgunBackgroundSchedulerError.launchctlFailed
        }
    }

    private nonisolated static func serviceIsMissing(_ result: RailgunLaunchctlResult) -> Bool {
        guard result.status != 0 else { return false }
        let output = result.output.lowercased()
        return output.contains("could not find service")
            || output.contains("service not found")
            || output.contains("no such process")
    }

    private static func launchctl(_ arguments: [String]) async -> RailgunLaunchctlResult {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
            process.waitUntilExit()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            return .init(
                status: process.terminationStatus,
                output: String(decoding: data, as: UTF8.self)
            )
        } catch {
            return .init(status: 1, output: "")
        }
    }
}
