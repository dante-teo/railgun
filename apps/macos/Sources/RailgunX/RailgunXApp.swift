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

enum BackendMode: Equatable {
    case real
    case mock

    private static let mockLaunchArgument = "--railgunx-backend-mode=mock"

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = CommandLine.arguments
    ) {
        self = environment["RAILGUNX_BACKEND_MODE"] == "mock"
            || arguments.contains(Self.mockLaunchArgument)
            ? .mock
            : .real
    }

    var placeholderText: String {
        switch self {
        case .real:
            "RailgunX"
        case .mock:
            "RailgunX Mock Backend"
        }
    }
}

@main
struct RailgunXApp: App {
    static let lifecycleConfiguration = AppLifecycleConfiguration.primary

    private let backendMode = BackendMode()

    var body: some Scene {
        WindowGroup(
            Self.lifecycleConfiguration.primaryWindowTitle,
            id: Self.lifecycleConfiguration.primaryWindowRestorationIdentifier
        ) {
            Text(backendMode.placeholderText)
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
