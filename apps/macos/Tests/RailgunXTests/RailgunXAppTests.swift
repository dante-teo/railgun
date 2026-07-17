import XCTest
import RailgunCore
import RailgunServices
import RailgunTestSupport
import RailgunTransport
import RailgunUI
@testable import RailgunX

@MainActor
final class RailgunXAppTests: XCTestCase {
    func testModuleBoundariesCompile() {}

    func testPlaceholderWindowUsesProductName() {
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration.primaryWindowTitle, "RailgunX")
    }

    func testAppUsesThePrimaryLifecycleConfiguration() {
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration, .primary)
    }

    func testPrimaryWindowLifecycleConfiguration() {
        let configuration = AppLifecycleConfiguration.primary

        XCTAssertEqual(configuration.primaryWindowTitle, "RailgunX")
        XCTAssertEqual(configuration.primaryWindowRestorationIdentifier, "primary")
        XCTAssertEqual(configuration.primaryWindowDefaultSize, CGSize(width: 1_024, height: 700))
        XCTAssertEqual(configuration.primaryWindowMinimumSize, CGSize(width: 760, height: 520))
        XCTAssertEqual(configuration.primaryWindowResizability, .contentMinimumSize)
    }

    func testMockBackendModeIsSelectedFromEnvironment() {
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "mock"]), .mock)
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "mock"]).placeholderText, "RailgunX Mock Backend")
    }

    func testUnknownBackendModeUsesTheRealBackend() {
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "unexpected"]), .real)
    }

    func testMockBackendModeCanBeSelectedFromLaunchArguments() {
        XCTAssertEqual(
            BackendMode(environment: [:], arguments: ["RailgunX", "--railgunx-backend-mode=mock"]),
            .mock
        )
    }

    func testRunScriptLaunchesTheAppBundleThroughLaunchServices() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let runScript = try String(
            contentsOf: repositoryRoot.appendingPathComponent("scripts/run.sh"),
            encoding: .utf8
        )

        XCTAssertTrue(runScript.contains("open -n -W \"$app_bundle\""))
        XCTAssertTrue(runScript.contains("--railgunx-backend-mode=mock"))
        XCTAssertFalse(runScript.contains("launch_arguments"))
    }
}
