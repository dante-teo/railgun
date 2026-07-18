import Foundation
import XCTest
import RailgunTransport

@MainActor
final class RailgunRPCClientTests: XCTestCase {
    func testValidatedCommandDTOEncodesProtocolShapeAndRejectsInvalidLimits() throws {
        let command = try RailgunRPCCommand(
            type: .sessionTranscript,
            fields: [
                "sessionId": .string("saved-session"),
                "cursor": .number(10),
                "limit": .number(50),
            ]
        )
        let encoded = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: command.encodedData()) as? [String: Any]
        )
        XCTAssertEqual(encoded["type"] as? String, "session_transcript")
        XCTAssertEqual(encoded["sessionId"] as? String, "saved-session")
        XCTAssertEqual(encoded["cursor"] as? Int, 10)
        XCTAssertEqual(encoded["limit"] as? Int, 50)

        XCTAssertThrowsError(
            try RailgunRPCCommand(type: .memoryList, fields: ["limit": .number(101)])
        )
        XCTAssertThrowsError(
            try RailgunRPCCommand(type: .getState, fields: ["id": .string("caller-owned")])
        )
        XCTAssertThrowsError(
            try RailgunRPCCommand(
                type: .mcpUpsert,
                fields: [
                    "name": .string("demo"),
                    "command": .string("node"),
                    "args": .array([.number(1)]),
                ]
            )
        )
    }

    func testDTOsValidateResponsesInteractionsAndRedactDiagnostics() throws {
        let response = try RailgunRPCResponse(data: Data(#"""
        {"id":"request-1-1","type":"response","command":"get_state","success":true,"data":{"running":false,"model":"mock-model","messageCount":0,"todos":[],"sessionId":"mock-session","persistence":"unsaved"}}
        """#.utf8))
        XCTAssertEqual(try RailgunRPCSessionState(data: response.data).sessionID, "mock-session")

        let interaction = try RailgunRPCInteractionRequest(data: Data(#"""
        {"type":"clarification_request","requestId":"request-1","question":"Choose one","choices":["Safe","Fast"]}
        """#.utf8))
        XCTAssertEqual(interaction, .clarification(requestID: "request-1", question: "Choose one", choices: ["Safe", "Fast"]))
        XCTAssertThrowsError(try RailgunRPCInteractionRequest.validateClarificationAnswer("   "))

        let sensitive = try JSONDecoder().decode(RailgunJSONValue.self, from: Data(#"""
        {"type":"response","id":"Bearer backend-secret","command":"get_state","success":false,"data":{"token":"plain-secret","path":"/Users/ava/private.txt"}}
        """#.utf8))
        let detail = RailgunRPCRedactor.detail(sensitive)
        XCTAssertFalse(detail.contains("plain-secret"))
        XCTAssertFalse(detail.contains("/Users/ava/private.txt"))
        let summary = RailgunRPCRedactor.diagnosticSummary(for: sensitive)
        XCTAssertEqual(summary, "type=response command=get_state id=present success=false")
        XCTAssertFalse(summary.contains("backend-secret"))
    }

    func testDTOsRejectOutOfRangeIntegersWithoutTrapping() {
        let malformedInitialize = RailgunJSONValue.object([
            "version": .number(Double(Int.max)),
            "capabilities": .array([]),
        ])

        XCTAssertThrowsError(try RailgunRPCInitializeResult(data: malformedInitialize))
        XCTAssertThrowsError(
            try RailgunRPCCommand(
                type: .initialize,
                fields: ["version": .number(Double(Int.max))]
            )
        )
    }

    func testTypedRequestReturnsValidatedResponseEnvelope() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: responsiveBackendScript))

        let response = try await client.request(
            RailgunRPCCommand(type: .getState),
            timeout: .seconds(1)
        )
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.command, "get_state")
        await client.shutdown()
    }

    func testStartsNegotiatesCapabilitiesAndCorrelatesDeterministicRequestIDs() async throws {
        let client = RailgunRPCClient()
        let handshake = try await client.start(perlLaunch(script: responsiveBackendScript))
        XCTAssertEqual(handshake.protocolVersion, 1)
        XCTAssertTrue(handshake.capabilities.isSuperset(of: requiredCapabilities))
        let negotiatedHandshake = await client.negotiatedHandshake
        XCTAssertEqual(negotiatedHandshake, handshake)

        let response = try await client.request(
            Data(#"{"type":"list_sessions"}"#.utf8),
            timeout: .seconds(1)
        )
        let object = try responseObject(response)
        XCTAssertEqual(object["id"] as? String, "request-1-1")
        XCTAssertEqual(object["command"] as? String, "list_sessions")
        XCTAssertEqual(object["success"] as? Bool, true)

        await client.shutdown()
        let handshakeAfterShutdown = await client.negotiatedHandshake
        XCTAssertNil(handshakeAfterShutdown)
    }

    func testBackendCommandRejectionIsReturnedAsItsMatchedRawResponse() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: responsiveBackendScript))

        let response = try await client.request(
            Data(#"{"type":"reject"}"#.utf8),
            timeout: .seconds(1)
        )
        let object = try responseObject(response)
        XCTAssertEqual(object["success"] as? Bool, false)
        XCTAssertEqual(object["error"] as? String, "mock rejected reject")

        await client.shutdown()
    }

    func testEventBurstBeforeResponseDoesNotOverflowTheRPCReader() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: responsiveBackendScript))

        let response = try await client.request(
            Data(#"{"type":"burst"}"#.utf8),
            timeout: .seconds(1)
        )

        XCTAssertEqual(try responseObject(response)["command"] as? String, "burst")
        await client.shutdown()
    }

    func testTimedOutAndCancelledRequestsDoNotPreventLaterCalls() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: responsiveBackendScript))

        do {
            _ = try await client.request(Data(#"{"type":"slow"}"#.utf8), timeout: .milliseconds(20))
            XCTFail("Expected the delayed request to time out")
        } catch let error as RailgunRPCError {
            XCTAssertEqual(error, .timeout)
        }

        let cancelledCall = Task { () -> RailgunRPCError? in
            do {
                _ = try await client.request(Data(#"{"type":"slow"}"#.utf8), timeout: .seconds(2))
                return nil
            } catch {
                return error as? RailgunRPCError
            }
        }
        try await Task.sleep(for: .milliseconds(20))
        cancelledCall.cancel()
        let cancellationResult = await cancelledCall.value
        XCTAssertEqual(cancellationResult, .cancelled)

        // The backend emits both delayed replies after the caller has stopped
        // waiting. They are ignored, then a new request still settles normally.
        try await Task.sleep(for: .milliseconds(450))
        let response = try await client.request(
            Data(#"{"type":"after_delays"}"#.utf8),
            timeout: .seconds(1)
        )
        XCTAssertEqual(try responseObject(response)["command"] as? String, "after_delays")

        await client.shutdown()
    }

    func testPreCancelledRequestUsesRailgunCancellationError() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: responsiveBackendScript))

        let requestTask = Task { () -> RailgunRPCError? in
            await Task.yield()
            do {
                _ = try await client.request(Data(#"{"type":"list_sessions"}"#.utf8), timeout: .seconds(1))
                return nil
            } catch {
                return error as? RailgunRPCError
            }
        }
        requestTask.cancel()

        let cancellationError = await requestTask.value
        XCTAssertEqual(cancellationError, .cancelled)
        await client.shutdown()
    }

    func testHandshakeRejectsMissingCapabilitiesAndEOFBeforeReadiness() async throws {
        let missingCapabilityClient = RailgunRPCClient()
        do {
            _ = try await missingCapabilityClient.start(perlLaunch(script: missingCapabilitiesScript))
            XCTFail("Expected initialize to reject missing required capabilities")
        } catch let error as RailgunRPCError {
            XCTAssertEqual(error, .missingRequiredCapabilities(requiredCapabilities))
        }

        let eofClient = RailgunRPCClient()
        do {
            _ = try await eofClient.start(perlLaunch(script: eofAfterInitializeScript))
            XCTFail("Expected EOF before readiness to fail startup")
        } catch let error as RailgunRPCError {
            XCTAssertEqual(error, .backendTerminated)
        }
    }

    private func perlLaunch(script: String) -> BackendProcessLaunch {
        BackendProcessLaunch(
            executableURL: URL(fileURLWithPath: "/usr/bin/perl"),
            arguments: ["-e", script]
        )
    }

    private func responseObject(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private let requiredCapabilities: Set<String> = [
        "sessions",
        "interaction.approval",
        "interaction.clarification",
    ]

    private let responsiveBackendScript = #"""
    $| = 1;
    while (<STDIN>) {
      my ($id) = /"id"\s*:\s*"([^"]+)"/;
      my ($type) = /"type"\s*:\s*"([^"]+)"/;
      if ($type eq "initialize") {
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"initialize\",\"success\":true,\"data\":{\"version\":1,\"capabilities\":[\"sessions\",\"interaction.approval\",\"interaction.clarification\",\"future\"]}}\n";
      } elsif ($type eq "slow") {
        select undef, undef, undef, 0.15;
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"slow\",\"success\":true}\n";
      } elsif ($type eq "reject") {
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"reject\",\"success\":false,\"error\":\"mock rejected reject\"}\n";
      } elsif ($type eq "burst") {
        print STDOUT "{\"type\":\"event\",\"event\":\"first\"}\n{\"type\":\"event\",\"event\":\"second\"}\n{\"type\":\"event\",\"event\":\"third\"}\n{\"id\":\"$id\",\"type\":\"response\",\"command\":\"burst\",\"success\":true}\n";
      } else {
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"$type\",\"success\":true}\n";
      }
    }
    """#

    private let missingCapabilitiesScript = #"""
    $| = 1;
    <STDIN>;
    print STDOUT "{\"id\":\"initialize-1\",\"type\":\"response\",\"command\":\"initialize\",\"success\":true,\"data\":{\"version\":1,\"capabilities\":[\"sessions\"]}}\n";
    sleep 1;
    """#

    private let eofAfterInitializeScript = #"""
    $| = 1;
    <STDIN>;
    print STDOUT "{\"id\":\"initialize-1\",\"type\":\"response\",\"command\":\"initialize\",\"success\":true,\"data\":{\"version\":1,\"capabilities\":[\"sessions\",\"interaction.approval\",\"interaction.clarification\"]}}\n";
    """#
}
