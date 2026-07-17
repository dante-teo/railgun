import Foundation
import XCTest
import RailgunTransport

@MainActor
final class BackendProcessTests: XCTestCase {
    func testLaunchesWithIndependentStandardPipesAndReportsNormalExit() async throws {
        let backend = BackendProcess()
        let pipes = try await backend.start(
            BackendProcessLaunch(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "cat; printf 'backend diagnostic\\n' >&2"]
            )
        )

        let runningState = await backend.state
        guard case let .running(processIdentifier) = runningState else {
            return XCTFail("Expected the backend process to be running.")
        }
        XCTAssertGreaterThan(processIdentifier, 0)

        pipes.standardInput.write(Data("hello backend\n".utf8))
        pipes.standardInput.closeFile()

        XCTAssertEqual(pipes.standardOutput.readDataToEndOfFile(), Data("hello backend\n".utf8))
        XCTAssertEqual(pipes.standardError.readDataToEndOfFile(), Data("backend diagnostic\n".utf8))

        let termination = await backend.waitForTermination()
        let completedTermination = try XCTUnwrap(termination)
        XCTAssertEqual(termination?.reason, .exit)
        XCTAssertEqual(termination?.status, 0)
        let completedState = await backend.state
        XCTAssertEqual(completedState, .exited(completedTermination))
    }

    func testGracefulTerminationSendsSIGTERMAndAllowsRestart() async throws {
        let backend = BackendProcess()
        let launch = perlLaunch(script: "$| = 1; $SIG{TERM} = sub { exit 0 }; print \"ready\\n\"; sleep 1 while 1;")

        let pipes = try await backend.start(launch)
        assertReady(pipes)
        await backend.terminate(gracePeriod: .seconds(1))

        let gracefulTermination = await backend.waitForTermination()
        XCTAssertEqual(gracefulTermination?.reason, .exit)
        XCTAssertEqual(gracefulTermination?.status, 0)

        _ = try await backend.start(
            BackendProcessLaunch(
                executableURL: URL(fileURLWithPath: "/usr/bin/true")
            )
        )
        let restartedTermination = await backend.waitForTermination()
        XCTAssertEqual(restartedTermination?.reason, .exit)
        XCTAssertEqual(restartedTermination?.status, 0)
    }

    func testForcedTerminationKillsAProcessThatIgnoresSIGTERM() async throws {
        let backend = BackendProcess()
        let pipes = try await backend.start(
            perlLaunch(script: "$| = 1; $SIG{TERM} = sub {}; print \"ready\\n\"; sleep 1 while 1;")
        )
        assertReady(pipes)

        await backend.terminate(gracePeriod: .milliseconds(10))

        let termination = await backend.waitForTermination()
        XCTAssertEqual(termination?.reason, .uncaughtSignal)
        XCTAssertEqual(termination?.status, 9)
    }

    func testRejectsStartingASecondBackendBeforeTheFirstExits() async throws {
        let backend = BackendProcess()
        _ = try await backend.start(
            perlLaunch(script: "$SIG{TERM} = sub { exit 0 }; sleep 1 while 1;")
        )

        do {
            _ = try await backend.start(BackendProcessLaunch(executableURL: URL(fileURLWithPath: "/usr/bin/true")))
            XCTFail("Expected a second active backend launch to fail.")
        } catch let error as BackendProcessError {
            XCTAssertEqual(error, .alreadyRunning)
        }

        await backend.terminate(gracePeriod: .seconds(1))
        _ = await backend.waitForTermination()
    }

    func testFailedLaunchLeavesTheActorIdleAndReadyToRetry() async throws {
        let backend = BackendProcess()
        let missingExecutable = URL(
            fileURLWithPath: "/private/tmp/railgunx-missing-backend-\(UUID().uuidString)"
        )

        do {
            _ = try await backend.start(BackendProcessLaunch(executableURL: missingExecutable))
            XCTFail("Expected an unavailable executable to fail to launch.")
        } catch let error as BackendProcessError {
            guard case .launchFailed = error else {
                return XCTFail("Expected a launch failure, received \(error).")
            }
        }

        let stateAfterFailure = await backend.state
        XCTAssertEqual(stateAfterFailure, .idle)

        _ = try await backend.start(BackendProcessLaunch(executableURL: URL(fileURLWithPath: "/usr/bin/true")))
        let termination = await backend.waitForTermination()
        XCTAssertEqual(termination?.reason, .exit)
        XCTAssertEqual(termination?.status, 0)
    }

    private func perlLaunch(script: String) -> BackendProcessLaunch {
        BackendProcessLaunch(
            executableURL: URL(fileURLWithPath: "/usr/bin/perl"),
            arguments: ["-e", script]
        )
    }

    private func assertReady(_ pipes: BackendProcessPipes) {
        XCTAssertEqual(pipes.standardOutput.availableData, Data("ready\n".utf8))
    }
}
