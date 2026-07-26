import Foundation
import XCTest
import RailgunServices
import RailgunTransport

@MainActor
final class RailgunSchedulerServiceTests: XCTestCase {
    func testStartsOnceAndStopsWithTheApp() async throws {
        let service = RailgunSchedulerService(
            launch: BackendProcessLaunch(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"]
            )
        )

        try await service.start()
        try await service.start()
        let runningBeforeShutdown = await service.isRunning()
        XCTAssertTrue(runningBeforeShutdown)

        await service.shutdown()
        let runningAfterShutdown = await service.isRunning()
        XCTAssertFalse(runningAfterShutdown)
    }
}
