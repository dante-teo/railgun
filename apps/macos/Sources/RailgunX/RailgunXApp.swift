import RailgunCore
import RailgunServices
import RailgunTransport
import RailgunUI
import SwiftUI

enum BackendMode: Equatable {
    case real
    case mock

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        self = environment["RAILGUNX_BACKEND_MODE"] == "mock" ? .mock : .real
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
    static let windowTitle = "RailgunX"
    private let backendMode = BackendMode()

    var body: some Scene {
        WindowGroup(Self.windowTitle) {
            Text(backendMode.placeholderText)
                .frame(minWidth: 320, minHeight: 180)
        }
    }
}
