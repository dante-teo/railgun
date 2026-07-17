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
        XCTAssertEqual(RailgunXApp.windowTitle, "RailgunX")
    }

    func testMockBackendModeIsSelectedFromEnvironment() {
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "mock"]), .mock)
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "mock"]).placeholderText, "RailgunX Mock Backend")
    }

    func testUnknownBackendModeUsesTheRealBackend() {
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "unexpected"]), .real)
    }
}
