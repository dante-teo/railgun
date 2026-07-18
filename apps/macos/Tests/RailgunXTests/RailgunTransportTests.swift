import Foundation
import XCTest
import RailgunTransport

@MainActor
final class RailgunTransportTests: XCTestCase {
    func testFramesFragmentedCoalescedBlankAndCRLFJSONL() async throws {
        let transport = try await startTransport(
            script: #"$| = 1; print STDOUT "{\"first\":"; select undef, undef, undef, 0.01; print STDOUT "1}\n{\"second\":2}\n\n{\"third\":3}\r\n";"#,
            configuration: RailgunTransportConfiguration(stdoutFrameBufferCapacity: 3)
        )

        let frames = try await Self.collectFrames(from: transport.transport)

        XCTAssertEqual(
            frames,
            [
                Data(#"{"first":1}"#.utf8),
                Data(#"{"second":2}"#.utf8),
                Data(#"{"third":3}"#.utf8),
            ]
        )
        _ = await transport.backend.waitForTermination()
    }

    func testMalformedAndNonObjectFramesFailStdout() async throws {
        try await assertStdoutFailure(
            script: #"print STDOUT "{malformed}\n";"#,
            expected: .malformedStdoutJSON
        )
        try await assertStdoutFailure(
            script: #"print STDOUT "[1,2]\n";"#,
            expected: .stdoutJSONWasNotAnObject
        )
        try await assertStdoutFailure(
            script: #"print STDOUT "true\n";"#,
            expected: .stdoutJSONWasNotAnObject
        )
    }

    func testFrameAndResidualBufferLimitsFailStdout() async throws {
        try await assertStdoutFailure(
            script: #"print STDOUT "{\"value\":1}\n";"#,
            configuration: RailgunTransportConfiguration(
                maximumStdoutFrameBytes: 8,
                maximumStdoutBufferBytes: 16
            ),
            expected: .stdoutFrameTooLarge(limit: 8)
        )
        try await assertStdoutFailure(
            script: #"print STDOUT "123456789";"#,
            configuration: RailgunTransportConfiguration(
                maximumStdoutFrameBytes: 16,
                maximumStdoutBufferBytes: 8
            ),
            expected: .stdoutBufferTooLarge(limit: 8)
        )
    }

    func testDrainsCoalescedFramesBeforeCheckingResidualBufferLimit() async throws {
        let transport = try await startTransport(
            script: #"print STDOUT "{}\n{}\n123456789";"#,
            configuration: RailgunTransportConfiguration(
                maximumStdoutFrameBytes: 16,
                maximumStdoutBufferBytes: 8
            )
        )

        var frames: [Data] = []
        do {
            for try await frame in transport.transport.stdoutFrames {
                frames.append(frame)
            }
            XCTFail("Expected the residual buffer to fail")
        } catch let error as RailgunTransportError {
            XCTAssertEqual(error, .stdoutBufferTooLarge(limit: 8))
        }
        XCTAssertEqual(frames, [Data("{}".utf8), Data("{}".utf8)])

        _ = await transport.backend.waitForTermination()
    }

    func testBoundedStdoutQueueFailsWhenAConsumerFallsBehind() async throws {
        let transport = try await startTransport(
            script: #"$| = 1; print STDOUT "{}\n{}\n"; select undef, undef, undef, 0.2;"#,
            configuration: RailgunTransportConfiguration(stdoutFrameBufferCapacity: 1)
        )
        try await Task.sleep(for: .milliseconds(50))

        var frames: [Data] = []
        do {
            for try await frame in transport.transport.stdoutFrames {
                frames.append(frame)
            }
            XCTFail("Expected the bounded stdout queue to fail")
        } catch let error as RailgunTransportError {
            XCTAssertEqual(error, .stdoutFrameBufferOverflow(limit: 1))
        }
        XCTAssertEqual(frames, [Data("{}".utf8)])

        _ = await transport.backend.waitForTermination()
    }

    func testCleanEOFAndPartialFinalFrameAreDistinct() async throws {
        let cleanTransport = try await startTransport(script: #"print STDOUT "{\"ok\":true}\n";"#)
        let cleanFrames = try await Self.collectFrames(from: cleanTransport.transport)
        XCTAssertEqual(cleanFrames, [Data(#"{"ok":true}"#.utf8)])
        _ = await cleanTransport.backend.waitForTermination()

        try await assertStdoutFailure(
            script: #"print STDOUT "{\"ok\":true}";"#,
            expected: .stdoutEndedWithPartialFrame
        )
    }

    func testReadsStdoutAndStderrConcurrentlyThroughBackendProcessPipes() async throws {
        let transport = try await startTransport(
            script: #"$| = 1; print STDOUT "{\"ready\":true}\n"; print STDERR "first "; select undef, undef, undef, 0.02; print STDERR "second";"#,
            configuration: RailgunTransportConfiguration(stderrReadChunkBytes: 4)
        )

        async let frames = Self.collectFrames(from: transport.transport)
        async let stderrChunks = Self.collectStderrChunks(from: transport.transport)
        let stdoutFrames = try await frames
        XCTAssertEqual(stdoutFrames, [Data(#"{"ready":true}"#.utf8)])
        let stderr = await stderrChunks
        XCTAssertTrue(stderr.allSatisfy { $0.count <= 4 })
        XCTAssertEqual(stderr.reduce(into: Data()) { $0.append($1) }, Data("first second".utf8))
        let termination = await transport.backend.waitForTermination()
        XCTAssertEqual(termination?.status, 0)
    }

    func testCloseFinishesStreamsAndContinuesDrainingWithoutTerminatingTheBackend() async throws {
        let transport = try await startTransport(
            script: #"$| = 1; print STDOUT "{\"ready\":true}\n"; print STDERR "diagnostic"; select undef, undef, undef, 0.05; print STDOUT "{\"afterClose\":true}\n"; print STDERR " after close"; sleep 1 while 1;"#
        )

        await transport.transport.close()

        _ = try await Self.collectFrames(from: transport.transport)
        _ = await Self.collectStderrChunks(from: transport.transport)
        try await Task.sleep(for: .milliseconds(100))
        let state = await transport.backend.state
        guard case .running = state else {
            return XCTFail("Closing the transport must not terminate the backend.")
        }

        await transport.backend.terminate(gracePeriod: .milliseconds(10))
        let termination = await transport.backend.waitForTermination()
        XCTAssertEqual(termination?.reason, .uncaughtSignal)
    }

    private func assertStdoutFailure(
        script: String,
        configuration: RailgunTransportConfiguration = .electronCompatible,
        expected: RailgunTransportError
    ) async throws {
        let transport = try await startTransport(script: script, configuration: configuration)

        do {
            _ = try await Self.collectFrames(from: transport.transport)
            XCTFail("Expected stdout to fail with \(expected)")
        } catch let error as RailgunTransportError {
            XCTAssertEqual(error, expected)
        }
        _ = await transport.backend.waitForTermination()
    }

    private func startTransport(
        script: String,
        configuration: RailgunTransportConfiguration = .electronCompatible
    ) async throws -> (backend: BackendProcess, transport: RailgunTransport) {
        let backend = BackendProcess()
        let pipes = try await backend.start(
            BackendProcessLaunch(
                executableURL: URL(fileURLWithPath: "/usr/bin/perl"),
                arguments: ["-e", script]
            )
        )
        return (backend, RailgunTransport(pipes: pipes, configuration: configuration))
    }

    private static func collectFrames(from transport: RailgunTransport) async throws -> [Data] {
        var frames: [Data] = []
        for try await frame in transport.stdoutFrames {
            frames.append(frame)
        }
        return frames
    }

    private static func collectStderrChunks(from transport: RailgunTransport) async -> [Data] {
        var chunks: [Data] = []
        for await chunk in transport.stderrChunks {
            chunks.append(chunk)
        }
        return chunks
    }
}
