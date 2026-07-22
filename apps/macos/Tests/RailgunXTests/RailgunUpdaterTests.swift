import XCTest
@testable import RailgunX

@MainActor
final class RailgunUpdaterTests: XCTestCase {
    func testUpdaterRequiresHTTPSFeedAndPublicEdDSAKey() {
        XCTAssertTrue(
            RailgunUpdater.isConfigured(infoDictionary: [
                "SUFeedURL": "https://github.com/dante-teo/railgun/releases/latest/download/RailgunX-appcast-arm64.xml",
                "SUPublicEDKey": "public-key"
            ])
        )
        XCTAssertFalse(
            RailgunUpdater.isConfigured(infoDictionary: [
                "SUFeedURL": "http://example.invalid/appcast.xml",
                "SUPublicEDKey": "public-key"
            ])
        )
        XCTAssertFalse(
            RailgunUpdater.isConfigured(infoDictionary: [
                "SUFeedURL": "https://example.invalid/appcast.xml",
                "SUPublicEDKey": " "
            ])
        )
    }
}
