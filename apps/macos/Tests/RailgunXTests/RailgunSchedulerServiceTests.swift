import Foundation
import XCTest
import RailgunServices
import RailgunTransport

@MainActor
final class RailgunSchedulerServiceTests: XCTestCase {
    func testLaunchAgentRunsTheBackendDirectlyInsteadOfTheGUI() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgun-scheduler-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let backend = home.appendingPathComponent("railgun-backend")
        try Data("backend".utf8).write(to: backend)
        let configuration = RailgunBackgroundSchedulerConfiguration(
            launch: BackendProcessLaunch(
                executableURL: backend,
                arguments: ["scheduler"],
                currentDirectoryURL: home,
                environment: [
                    "DEVIN_TOKEN": "must-not-be-persisted",
                    "HOME": home.path,
                    "RAILGUN_DESKTOP_RPC": "1",
                ]
            ),
            homeDirectory: home,
            userID: 501
        )

        let propertyList = try XCTUnwrap(
            try PropertyListSerialization.propertyList(
                from: configuration.propertyListData(),
                format: nil
            ) as? [String: Any]
        )

        XCTAssertEqual(
            propertyList["ProgramArguments"] as? [String],
            [backend.path, "scheduler"]
        )
        XCTAssertEqual(propertyList["WorkingDirectory"] as? String, home.path)
        let environment = try XCTUnwrap(
            propertyList["EnvironmentVariables"] as? [String: String]
        )
        XCTAssertEqual(environment["HOME"], home.path)
        XCTAssertEqual(environment["RAILGUN_SCHEDULER_DEFINITION_VERSION"], "2")
        XCTAssertEqual(environment["RAILGUN_SCHEDULER_EXECUTABLE_SHA256"]?.count, 64)
        XCTAssertNil(environment["DEVIN_TOKEN"])
        XCTAssertEqual(propertyList["RunAtLoad"] as? Bool, true)
        XCTAssertEqual(propertyList["KeepAlive"] as? Bool, true)
        XCTAssertFalse(
            try configuration.propertyListData().contains(
                Data("Railgun.app/Contents/MacOS/Railgun".utf8)
            )
        )
    }

    func testInstallReplacesLegacyAgentsAndStartsOnlyTheScheduler() async throws {
        let temporaryHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgun-scheduler-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryHome) }
        let recorder = LaunchctlRecorder()
        let configuration = schedulerConfiguration(home: temporaryHome)
        let service = RailgunBackgroundSchedulerService(
            configuration: configuration,
            runLaunchctl: { arguments in await recorder.run(arguments) }
        )

        let status = try await service.install()

        XCTAssertEqual(status, .installed(running: true))
        XCTAssertTrue(FileManager.default.fileExists(atPath: configuration.launchAgentURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: configuration.legacyDreamLaunchAgentURL.path))
        let commands = await recorder.commands
        XCTAssertEqual(Array(commands.prefix(5)), [
            ["bootout", "gui/501/sh.railgun.cron"],
            ["bootout", "gui/501/sh.railgun.dream"],
            ["bootstrap", "gui/501", configuration.launchAgentURL.path],
            ["kickstart", "-k", "gui/501/sh.railgun.cron"],
            ["print", "gui/501/sh.railgun.cron"],
        ])
    }

    func testStatusRequiresRepairForAnOldGUIBackedAgentOrDreamAgent() async throws {
        let temporaryHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgun-scheduler-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryHome) }
        let configuration = schedulerConfiguration(home: temporaryHome)
        try FileManager.default.createDirectory(
            at: configuration.launchAgentURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("old GUI launch agent".utf8).write(to: configuration.launchAgentURL)
        try Data("old Dream launch agent".utf8).write(to: configuration.legacyDreamLaunchAgentURL)
        let service = RailgunBackgroundSchedulerService(
            configuration: configuration,
            runLaunchctl: { _ in .init(status: 1, output: "") }
        )

        let status = try await service.status()
        XCTAssertEqual(status, .repairNeeded)
    }

    func testStatusRequiresRepairWhenTheBundledBackendChanges() async throws {
        let temporaryHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgun-scheduler-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryHome) }
        try FileManager.default.createDirectory(at: temporaryHome, withIntermediateDirectories: true)
        let backend = temporaryHome.appendingPathComponent("railgun-backend")
        try Data("backend-v1".utf8).write(to: backend)
        let configuration = schedulerConfiguration(home: temporaryHome, backend: backend)
        try FileManager.default.createDirectory(
            at: configuration.launchAgentURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try configuration.propertyListData().write(to: configuration.launchAgentURL)
        try Data("backend-v2".utf8).write(to: backend)
        let service = RailgunBackgroundSchedulerService(
            configuration: configuration,
            runLaunchctl: { _ in .init(status: 0, output: "state = running") }
        )

        let status = try await service.status()

        XCTAssertEqual(status, .repairNeeded)
    }

    func testUninstallBootsOutAndRemovesBothCurrentAndLegacyAgents() async throws {
        let temporaryHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgun-scheduler-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryHome) }
        let recorder = LaunchctlRecorder()
        let configuration = schedulerConfiguration(home: temporaryHome)
        try FileManager.default.createDirectory(
            at: configuration.launchAgentURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try configuration.propertyListData().write(to: configuration.launchAgentURL)
        try Data("legacy".utf8).write(to: configuration.legacyDreamLaunchAgentURL)
        let service = RailgunBackgroundSchedulerService(
            configuration: configuration,
            runLaunchctl: { arguments in await recorder.run(arguments) }
        )

        let status = try await service.uninstall()

        XCTAssertEqual(status, .notInstalled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: configuration.launchAgentURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: configuration.legacyDreamLaunchAgentURL.path))
        let commands = await recorder.commands
        XCTAssertEqual(commands, [
            ["bootout", "gui/501/sh.railgun.cron"],
            ["print", "gui/501/sh.railgun.cron"],
            ["bootout", "gui/501/sh.railgun.dream"],
            ["print", "gui/501/sh.railgun.dream"],
        ])
    }

    func testUninstallPreservesDefinitionsWhenLaunchdStillHasTheSchedulerLoaded() async throws {
        let temporaryHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("railgun-scheduler-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryHome) }
        let configuration = schedulerConfiguration(home: temporaryHome)
        try FileManager.default.createDirectory(
            at: configuration.launchAgentURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try configuration.propertyListData().write(to: configuration.launchAgentURL)
        let service = RailgunBackgroundSchedulerService(
            configuration: configuration,
            runLaunchctl: { arguments in
                arguments.first == "print"
                    ? .init(status: 0, output: "state = running")
                    : .init(status: 1, output: "bootout failed")
            }
        )

        do {
            _ = try await service.uninstall()
            XCTFail("Expected uninstall to fail while launchd still owns the scheduler")
        } catch {
            XCTAssertEqual(error as? RailgunBackgroundSchedulerError, .launchctlFailed)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: configuration.launchAgentURL.path))
    }

    private func schedulerConfiguration(
        home: URL,
        backend: URL = URL(
            fileURLWithPath: "/Applications/Railgun.app/Contents/Resources/backend/railgun-backend"
        )
    ) -> RailgunBackgroundSchedulerConfiguration {
        RailgunBackgroundSchedulerConfiguration(
            launch: BackendProcessLaunch(
                executableURL: backend,
                arguments: ["scheduler"],
                currentDirectoryURL: home,
                environment: ["HOME": home.path]
            ),
            homeDirectory: home,
            userID: 501
        )
    }
}

private actor LaunchctlRecorder {
    private(set) var commands: [[String]] = []
    private var runningTargets = Set([
        "gui/501/sh.railgun.cron",
        "gui/501/sh.railgun.dream",
    ])

    func run(_ arguments: [String]) -> RailgunLaunchctlResult {
        commands.append(arguments)
        switch arguments.first {
        case "bootout":
            if let target = arguments.last {
                runningTargets.remove(target)
            }
            return .init(status: 0, output: "")
        case "bootstrap", "kickstart":
            runningTargets.insert("gui/501/sh.railgun.cron")
            return .init(status: 0, output: "")
        case "print":
            guard let target = arguments.last, runningTargets.contains(target) else {
                return .init(status: 113, output: "Could not find service")
            }
            return .init(status: 0, output: "state = running")
        default:
            return .init(status: 0, output: "")
        }
    }
}
