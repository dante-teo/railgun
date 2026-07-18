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
        XCTAssertThrowsError(try RailgunRPCInteractionRequest(data: Data(#"""
        {"type":"approval_request","requestId":"   ","command":"run safely"}
        """#.utf8)))

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
        let events = client.events
        let firstEvent = Task { () -> RailgunAgentEvent? in
            var iterator = events.makeAsyncIterator()
            return await iterator.next()
        }

        let response = try await client.request(
            Data(#"{"type":"burst"}"#.utf8),
            timeout: .seconds(1)
        )

        XCTAssertEqual(try responseObject(response)["command"] as? String, "burst")
        let receivedEvent = await firstEvent.value
        XCTAssertEqual(receivedEvent, .runStarted)
        await client.shutdown()
    }

    func testInteractionsAreRedactedCorrelatedAndEmittedInArrivalOrder() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: interactionBackendScript))
        let interactions = client.interactions
        let received = Task { () -> [RailgunRPCInteraction] in
            var iterator = interactions.makeAsyncIterator()
            return await [iterator.next(), iterator.next()].compactMap { $0 }
        }

        _ = try await client.request(Data(#"{"type":"interactions"}"#.utf8), timeout: .seconds(1))
        let prompts = await received.value

        XCTAssertEqual(prompts.count, 2)
        guard case let .approval(id: approvalID, command: command) = prompts[0] else {
            return XCTFail("Expected the approval to arrive first")
        }
        XCTAssertEqual(command, "Bearer [REDACTED] run")
        XCTAssertNotEqual(approvalID, "backend-approval")
        XCTAssertFalse(String(describing: prompts).contains("backend-approval"))
        XCTAssertEqual(
            prompts[1],
            .clarification(id: prompts[1].id, question: "Which path?", choices: ["Fast", "Safe"])
        )

        try await client.respondToApproval(id: approvalID, approved: true)
        try await client.respondToClarification(id: prompts[1].id, answer: "Fast")
        let pendingInteractionCount = await client.pendingInteractionCount
        XCTAssertEqual(pendingInteractionCount, 0)
        await client.shutdown()
    }

    func testInteractionsRejectInvalidOrMismatchedResponsesAndSettleOnRunEnd() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: interactionBackendScript))
        let interactions = client.interactions
        let firstInteraction = Task { () -> RailgunRPCInteraction? in
            var iterator = interactions.makeAsyncIterator()
            return await iterator.next()
        }

        _ = try await client.request(Data(#"{"type":"retry_interaction"}"#.utf8), timeout: .seconds(1))
        let firstPrompt = await firstInteraction.value
        let prompt = try XCTUnwrap(firstPrompt)
        guard case let .approval(id, _) = prompt else { return XCTFail("Expected an approval") }

        do {
            try await client.respondToApproval(id: id, approved: true)
            XCTFail("Expected an invalid interaction response")
        } catch let error as RailgunRPCError {
            XCTAssertEqual(error, .invalidInteractionResponse)
        }
        let pendingAfterInvalidResponse = await client.pendingInteractionCount
        XCTAssertEqual(pendingAfterInvalidResponse, 1)

        do {
            try await client.respondToClarification(id: id, answer: "Fast")
            XCTFail("Expected an interaction-kind mismatch")
        } catch let error as RailgunRPCError {
            XCTAssertEqual(error, .mismatchedInteractionKind(expected: .approval, received: .clarification))
        }

        try await client.respondToApproval(id: id, approved: true)
        let pendingAfterSettlement = await client.pendingInteractionCount
        XCTAssertEqual(pendingAfterSettlement, 0)

        let staleInteraction = Task { () -> RailgunRPCInteraction? in
            var iterator = interactions.makeAsyncIterator()
            return await iterator.next()
        }
        _ = try await client.request(Data(#"{"type":"settle_interaction"}"#.utf8), timeout: .seconds(1))
        let stalePromptValue = await staleInteraction.value
        let stalePrompt = try XCTUnwrap(stalePromptValue)
        let pendingAfterRunEnd = await client.pendingInteractionCount
        XCTAssertEqual(pendingAfterRunEnd, 0)
        do {
            try await client.respondToApproval(id: stalePrompt.id, approved: false)
            XCTFail("Expected a settled interaction to be rejected")
        } catch let error as RailgunRPCError {
            XCTAssertEqual(error, .unknownInteraction)
        }
        await client.shutdown()
    }

    func testMalformedInteractionsAreSafelySettledBeforeLaterRequests() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: interactionBackendScript))

        _ = try await client.request(Data(#"{"type":"invalid_interactions"}"#.utf8), timeout: .seconds(1))
        let response = try await client.request(Data(#"{"type":"verify_invalid_settlement"}"#.utf8), timeout: .seconds(1))

        XCTAssertTrue(try RailgunRPCResponse(data: response).success)
        let pendingInteractionCount = await client.pendingInteractionCount
        XCTAssertEqual(pendingInteractionCount, 0)
        await client.shutdown()
    }

    func testInteractionQueueOverflowSafelyDeniesTheDroppedPrompt() async throws {
        let client = RailgunRPCClient()
        _ = try await client.start(perlLaunch(script: interactionBackendScript))
        let interactions = client.interactions

        _ = try await client.request(Data(#"{"type":"overflow_interactions"}"#.utf8), timeout: .seconds(1))
        let pendingInteractionCount = await client.pendingInteractionCount
        XCTAssertEqual(pendingInteractionCount, 128)

        var iterator = interactions.makeAsyncIterator()
        let firstPromptValue = await iterator.next()
        let firstPrompt = try XCTUnwrap(firstPromptValue)
        XCTAssertEqual(firstPrompt, .approval(id: firstPrompt.id, command: "overflow 1"))
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
        print STDOUT "{\"type\":\"agent_start\"}\n{\"type\":\"event\",\"event\":\"second\"}\n{\"type\":\"event\",\"event\":\"third\"}\n{\"id\":\"$id\",\"type\":\"response\",\"command\":\"burst\",\"success\":true}\n";
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

    private let interactionBackendScript = #"""
    $| = 1;
    my $invalid_settlements = 0;
    my $invalid_interactions_request_id;
    my $overflow_interactions_request_id;
    my $retry_attempts = 0;
    while (<STDIN>) {
      my ($id) = /"id"\s*:\s*"([^"]+)"/;
      my ($type) = /"type"\s*:\s*"([^"]+)"/;
      my ($request_id) = /"requestId"\s*:\s*"([^"]+)"/;
      if ($type eq "initialize") {
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"initialize\",\"success\":true,\"data\":{\"version\":1,\"capabilities\":[\"sessions\",\"interaction.approval\",\"interaction.clarification\"]}}\n";
      } elsif ($type eq "interactions") {
        print STDOUT "{\"type\":\"approval_request\",\"requestId\":\"backend-approval\",\"command\":\"Bearer sk-secret-token run\"}\n";
        print STDOUT "{\"type\":\"clarification_request\",\"requestId\":\"backend-clarification\",\"question\":\"Which path?\",\"choices\":[\"Fast\",\"Safe\"]}\n";
        print STDOUT "{\"type\":\"approval_request\",\"requestId\":\"backend-approval\",\"command\":\"duplicate request\"}\n";
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"interactions\",\"success\":true}\n";
      } elsif ($type eq "retry_interaction") {
        print STDOUT "{\"type\":\"approval_request\",\"requestId\":\"retry-approval\",\"command\":\"run safely\"}\n";
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"retry_interaction\",\"success\":true}\n";
      } elsif ($type eq "settle_interaction") {
        print STDOUT "{\"type\":\"approval_request\",\"requestId\":\"settle-approval\",\"command\":\"run safely\"}\n";
        print STDOUT "{\"type\":\"agent_end\"}\n";
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"settle_interaction\",\"success\":true}\n";
      } elsif ($type eq "invalid_interactions") {
        $invalid_interactions_request_id = $id;
        print STDOUT "{\"type\":\"clarification_request\",\"requestId\":\"invalid-clarification\",\"question\":\"" . ("x" x 8001) . "\"}\n";
        print STDOUT "{\"type\":\"approval_request\",\"command\":\"missing request identifier\"}\n";
        print STDOUT "{\"type\":\"approval_request\",\"requestId\":\"   \",\"command\":\"whitespace request identifier\"}\n";
      } elsif ($type eq "overflow_interactions") {
        $overflow_interactions_request_id = $id;
        for my $index (1 .. 129) {
          print STDOUT "{\"type\":\"approval_request\",\"requestId\":\"overflow-$index\",\"command\":\"overflow $index\"}\n";
        }
      } elsif ($type eq "approval_response") {
        if ($request_id eq "overflow-129") {
          print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"approval_response\",\"success\":true}\n";
          print STDOUT "{\"id\":\"$overflow_interactions_request_id\",\"type\":\"response\",\"command\":\"overflow_interactions\",\"success\":true}\n";
        } elsif ($request_id eq "backend-approval" || $request_id eq "retry-approval") {
          $retry_attempts++ if $request_id eq "retry-approval";
          if ($request_id eq "retry-approval" && $retry_attempts == 1) {
            print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"approval_response\",\"success\":true,\"data\":{\"unexpected\":true}}\n";
          } else {
            print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"approval_response\",\"success\":true}\n";
          }
        } else {
          print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"approval_response\",\"success\":false,\"error\":\"wrong request ID\"}\n";
        }
      } elsif ($type eq "clarification_response") {
        if ($request_id eq "backend-clarification") {
          print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"clarification_response\",\"success\":true}\n";
        } elsif ($request_id eq "invalid-clarification") {
          $invalid_settlements++;
          print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"clarification_response\",\"success\":true}\n";
          if ($invalid_settlements == 3) {
            print STDOUT "{\"id\":\"$invalid_interactions_request_id\",\"type\":\"response\",\"command\":\"invalid_interactions\",\"success\":true}\n";
          }
        }
      } elsif ($type eq "abort") {
        $invalid_settlements++;
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"abort\",\"success\":true}\n";
        if ($invalid_settlements == 3) {
          print STDOUT "{\"id\":\"$invalid_interactions_request_id\",\"type\":\"response\",\"command\":\"invalid_interactions\",\"success\":true}\n";
        }
      } elsif ($type eq "verify_invalid_settlement") {
        my $success = $invalid_settlements == 3 ? "true" : "false";
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"verify_invalid_settlement\",\"success\":$success" . ($success eq "true" ? "" : ",\"error\":\"invalid interactions were not settled\"") . "}\n";
      } else {
        print STDOUT "{\"id\":\"$id\",\"type\":\"response\",\"command\":\"$type\",\"success\":true}\n";
      }
    }
    """#
}
