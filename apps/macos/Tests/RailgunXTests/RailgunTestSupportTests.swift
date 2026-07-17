import Foundation
import XCTest
import RailgunTestSupport

@MainActor
final class RailgunTestSupportTests: XCTestCase {
    nonisolated(unsafe) private var temporaryHomeURLForTeardown: URL?

    override func tearDown() {
        if let temporaryHomeURLForTeardown {
            XCTAssertFalse(FileManager.default.fileExists(atPath: temporaryHomeURLForTeardown.path))
        }
        temporaryHomeURLForTeardown = nil
        super.tearDown()
    }

    func testTemporaryHomesAreUniqueIsolatedAndExposeHomeOverride() throws {
        let first = try TemporaryRailgunHome()
        let second = try TemporaryRailgunHome()
        defer {
            try? first.remove()
            try? second.remove()
        }

        XCTAssertNotEqual(first.url, second.url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.railgunDirectory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.railgunDirectory.path))
        XCTAssertEqual(first.environment, ["HOME": first.url.path])
        XCTAssertTrue(
            try FileManager.default.contentsOfDirectory(atPath: first.railgunDirectory.path).isEmpty
        )
    }

    func testTemporaryHomeCanBeRemovedExplicitly() throws {
        let home = try TemporaryRailgunHome()

        try home.remove()

        XCTAssertFalse(FileManager.default.fileExists(atPath: home.url.path))
    }

    func testTemporaryHomeHelperRegistersTeardownCleanup() throws {
        let home = try temporaryRailgunHome()
        temporaryHomeURLForTeardown = home.url

        XCTAssertTrue(FileManager.default.fileExists(atPath: home.url.path))
    }

    func testFixtureManifestHasUniqueScenarioIdsAndRawJSONL() throws {
        let corpus = try rpcFixtureCorpus()

        assertRPCFixtureCorpus(corpus)
        XCTAssertEqual(corpus.version, 1)
        XCTAssertEqual(
            corpus.scenarios.map(\.id),
            [
                "initialize-success",
                "command-rejected",
                "malformed-stdout",
                "delayed-success",
                "eof-after-initialize",
            ]
        )
        XCTAssertTrue(corpus.scenarios.allSatisfy { scenario in
            scenario.steps.allSatisfy { step in
                step.expectedRequest.last == UInt8(ascii: "\n") && !step.expectedRequest.isEmpty
            }
        })
    }

    func testScriptedBackendReturnsTheInitializeFixtureWithoutWaiting() async throws {
        let scenario = try rpcFixtureCorpus().scenario(id: "initialize-success")
        let backend = ScriptedMockBackend(scenario: scenario)

        let reply = try await backend.receive(scenario.steps[0].expectedRequest)

        XCTAssertEqual(reply.outputs.map(\.delayMilliseconds), [0])
        XCTAssertEqual(reply.terminalState, .open)
        XCTAssertEqual(reply.outputs.map(\.rawBytes), scenario.steps[0].outputs.map(\.rawBytes))
        let receivedInput = await backend.receivedInput()
        let remainingStepCount = await backend.remainingStepCount()
        XCTAssertEqual(receivedInput, [scenario.steps[0].expectedRequest])
        XCTAssertEqual(remainingStepCount, 0)
    }

    func testScriptedBackendRejectsOutOfOrderRequestsAndRecordsThem() async throws {
        let scenario = try rpcFixtureCorpus().scenario(id: "command-rejected")
        let backend = ScriptedMockBackend(scenario: scenario)

        do {
            _ = try await backend.receive(scenario.steps[1].expectedRequest)
            XCTFail("Expected the out-of-order request to fail")
        } catch {
            XCTAssertEqual(error as? ScriptedMockBackendError, .unexpectedRequest(index: 0))
        }
        let receivedInput = await backend.receivedInput()
        XCTAssertEqual(receivedInput, [scenario.steps[1].expectedRequest])

        let initialization = try await backend.receive(scenario.steps[0].expectedRequest)
        let rejection = try await backend.receive(scenario.steps[1].expectedRequest)

        XCTAssertEqual(initialization.terminalState, .open)
        XCTAssertTrue(String(decoding: rejection.outputs[0].rawBytes, as: UTF8.self).contains("mock rejected get_state"))
        let remainingStepCount = await backend.remainingStepCount()
        XCTAssertEqual(remainingStepCount, 0)
    }

    func testScriptedBackendExposesMalformedFramesDelayMetadataAndEOF() async throws {
        let corpus = try rpcFixtureCorpus()
        let malformed = try corpus.scenario(id: "malformed-stdout")
        let delayed = try corpus.scenario(id: "delayed-success")
        let eof = try corpus.scenario(id: "eof-after-initialize")

        let malformedReply = try await ScriptedMockBackend(scenario: malformed).receive(malformed.steps[0].expectedRequest)
        XCTAssertEqual(String(decoding: malformedReply.outputs[0].rawBytes, as: UTF8.self), "{malformed-json\n")

        let delayedReply = try await ScriptedMockBackend(scenario: delayed).receive(delayed.steps[0].expectedRequest)
        XCTAssertEqual(delayedReply.outputs.map(\.delayMilliseconds), [600])

        let eofBackend = ScriptedMockBackend(scenario: eof)
        let initializationReply = try await eofBackend.receive(eof.steps[0].expectedRequest)
        XCTAssertEqual(initializationReply.terminalState, .open)

        let eofReply = try await eofBackend.receive(eof.steps[1].expectedRequest)
        XCTAssertEqual(eofReply.terminalState, .eof)
    }
}
