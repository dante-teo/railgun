import Foundation
import RailgunCore
import RailgunServices
import RailgunTransport
import RailgunUI
import SwiftUI

enum PrimaryWindowResizability: Equatable {
    case contentMinimumSize

    var swiftUIValue: WindowResizability {
        .contentMinSize
    }
}

struct AppLifecycleConfiguration: Equatable {
    let primaryWindowTitle: String
    let primaryWindowRestorationIdentifier: String
    let primaryWindowDefaultSize: CGSize
    let primaryWindowMinimumSize: CGSize
    let primaryWindowResizability: PrimaryWindowResizability

    static let primary = Self(
        primaryWindowTitle: "RailgunX",
        primaryWindowRestorationIdentifier: "primary",
        primaryWindowDefaultSize: CGSize(width: 1_024, height: 700),
        primaryWindowMinimumSize: CGSize(width: 760, height: 520),
        primaryWindowResizability: .contentMinimumSize
    )
}

struct BackendLaunchConfiguration: Equatable {
    enum Mode: String, Equatable {
        case bundled
        case source
        case mock
    }

    static let defaultMockScenario = "ready-idle"

    let mode: Mode
    let sourceRoot: URL?
    let mockScenario: String?

    private init(mode: Mode, sourceRoot: URL?, mockScenario: String?) {
        self.mode = mode
        self.sourceRoot = sourceRoot
        self.mockScenario = mockScenario
    }

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = CommandLine.arguments
    ) {
        let requestedMode = Self.configurationValue(
            named: "backend-mode",
            environmentKey: "RAILGUNX_BACKEND_MODE",
            environment: environment,
            arguments: arguments
        )

        switch requestedMode {
        case Mode.source.rawValue:
            self.init(
                mode: .source,
                sourceRoot: Self.sourceRoot(environment: environment, arguments: arguments),
                mockScenario: nil
            )
        case Mode.mock.rawValue:
            let requestedScenario = Self.configurationValue(
                named: "mock-scenario",
                environmentKey: "RAILGUNX_MOCK_SCENARIO",
                environment: environment,
                arguments: arguments
            )
            self.init(
                mode: .mock,
                sourceRoot: Self.sourceRoot(environment: environment, arguments: arguments),
                mockScenario: Self.mockScenario(from: requestedScenario)
            )
        default:
            self.init(mode: .bundled, sourceRoot: nil, mockScenario: nil)
        }
    }

    var placeholderText: String {
        switch mode {
        case .bundled:
            "RailgunX Bundled Backend"
        case .source:
            "RailgunX Source Backend"
        case .mock:
            "RailgunX Mock Backend"
        }
    }

    private static func configurationValue(
        named name: String,
        environmentKey: String,
        environment: [String: String],
        arguments: [String]
    ) -> String? {
        let prefix = "--railgunx-\(name)="
        return arguments.first(where: { $0.hasPrefix(prefix) }).map {
            String($0.dropFirst(prefix.count))
        } ?? environment[environmentKey]
    }

    private static func sourceRoot(environment: [String: String], arguments: [String]) -> URL? {
        resolveSourceRoot(
            at: configurationValue(
                named: "source-root",
                environmentKey: "RAILGUNX_SOURCE_ROOT",
                environment: environment,
                arguments: arguments
            )
        )
    }

    private static func mockScenario(from value: String?) -> String {
        guard let scenario = value?.trimmingCharacters(in: .whitespacesAndNewlines), !scenario.isEmpty else {
            return defaultMockScenario
        }

        return scenario
    }

    private static func resolveSourceRoot(at location: String?) -> URL? {
        guard let location, !location.isEmpty else {
            return nil
        }

        let locationURL = URL(fileURLWithPath: location).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: locationURL.path, isDirectory: &isDirectory) else {
            return nil
        }

        if isDirectory.boolValue {
            return locationURL
        }

        guard let markerContents = try? String(contentsOf: locationURL, encoding: .utf8) else {
            return nil
        }

        let sourceRootPath = markerContents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sourceRootPath.isEmpty else {
            return nil
        }

        let sourceRootURL = URL(fileURLWithPath: sourceRootPath).standardizedFileURL
        return FileManager.default.fileExists(atPath: sourceRootURL.path, isDirectory: &isDirectory)
            && isDirectory.boolValue
            ? sourceRootURL
            : nil
    }
}

@main
struct RailgunXApp: App {
    static let lifecycleConfiguration = AppLifecycleConfiguration.primary

    private let backendLaunchConfiguration = BackendLaunchConfiguration()

    var body: some Scene {
        WindowGroup(
            Self.lifecycleConfiguration.primaryWindowTitle,
            id: Self.lifecycleConfiguration.primaryWindowRestorationIdentifier
        ) {
            Text(backendLaunchConfiguration.placeholderText)
                .frame(
                    minWidth: Self.lifecycleConfiguration.primaryWindowMinimumSize.width,
                    minHeight: Self.lifecycleConfiguration.primaryWindowMinimumSize.height
                )
        }
        .defaultSize(
            width: Self.lifecycleConfiguration.primaryWindowDefaultSize.width,
            height: Self.lifecycleConfiguration.primaryWindowDefaultSize.height
        )
        .windowResizability(Self.lifecycleConfiguration.primaryWindowResizability.swiftUIValue)

        Settings {
            ContentUnavailableView(
                "Settings",
                systemImage: "gear",
                description: Text("Settings will arrive with the Task alpha.")
            )
        }
    }
}
