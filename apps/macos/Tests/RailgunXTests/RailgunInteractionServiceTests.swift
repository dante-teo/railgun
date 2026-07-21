import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunInteractionServiceTests: XCTestCase {
    func testServiceRoutesApprovalAndClarificationResponses() async throws {
        let recorder = InteractionResponseRecorder()
        let service = RailgunInteractionService(
            approvalResponder: { id, approved in await recorder.recordApproval(id: id, approved: approved) },
            clarificationResponder: { id, answer in await recorder.recordClarification(id: id, answer: answer) }
        )

        try await service.respondToApproval(id: "approval-1", approved: false)
        try await service.respondToClarification(id: "clarification-1", answer: "Use the safe path")

        let responses = await recorder.responses
        XCTAssertEqual(
            responses,
            [.approval(id: "approval-1", approved: false), .clarification(id: "clarification-1", answer: "Use the safe path")]
        )
    }

    func testServiceRejectsBlankClarificationAnswersBeforeSending() async {
        let recorder = InteractionResponseRecorder()
        let service = RailgunInteractionService(
            approvalResponder: { id, approved in await recorder.recordApproval(id: id, approved: approved) },
            clarificationResponder: { id, answer in await recorder.recordClarification(id: id, answer: answer) }
        )

        await XCTAssertThrowsErrorAsync(try await service.respondToClarification(id: "clarification-1", answer: " \n ")) { error in
            XCTAssertEqual(error as? RailgunInteractionServiceError, .invalidRequest)
        }
        let responses = await recorder.responses
        XCTAssertTrue(responses.isEmpty)
    }

    func testServiceMapsMalformedAndRetryableFailuresToPresentationSafeErrors() async {
        let malformed = RailgunInteractionService(
            approvalResponder: { _, _ in throw RailgunRPCError.invalidInteractionResponse },
            clarificationResponder: { _, _ in }
        )
        await XCTAssertThrowsErrorAsync(try await malformed.respondToApproval(id: "approval-1", approved: true)) { error in
            XCTAssertEqual(error as? RailgunInteractionServiceError, .invalidResponse)
        }

        let rejected = RailgunInteractionService(
            approvalResponder: { _, _ in throw InteractionStubError.retryable("Bearer secret-token") },
            clarificationResponder: { _, _ in }
        )
        await XCTAssertThrowsErrorAsync(try await rejected.respondToApproval(id: "approval-1", approved: true)) { error in
            XCTAssertEqual(
                error as? RailgunInteractionServiceError,
                .rejected("The interaction response could not be completed.")
            )
        }
    }

    func testCoordinatorRetainsFailedRequestForRetryAndRemovesOnlyTheSettledRequest() async {
        let store = RailgunAppStore()
        store.send(.transcript(.submit(id: "user", text: "Start", at: 0)))
        store.send(.interaction(.received(.approval(id: "approval", command: "echo safe"))))
        store.send(.interaction(.received(.clarification(id: "clarification", question: "Which?", choices: ["Fast", "Safe"]))))
        let attempts = InteractionAttemptCounter()
        let service = RailgunInteractionService(
            approvalResponder: { _, _ in
                if await attempts.isFirstAttempt() {
                    throw InteractionStubError.retryable("temporary")
                }
            },
            clarificationResponder: { _, _ in }
        )
        let coordinator = RailgunInteractionCoordinator(store: store, service: service)

        await coordinator.respondToApproval(id: "approval", approved: true)

        XCTAssertEqual(store.state.interactions.requests.map(\.id), ["approval", "clarification"])
        XCTAssertFalse(store.state.interactions.requests[0].isSubmitting)
        XCTAssertEqual(store.state.interactions.requests[0].error, "The interaction response could not be completed.")
        XCTAssertEqual(store.state.interactions.requests[1].answer, "Fast")

        await coordinator.respondToApproval(id: "approval", approved: false)

        XCTAssertEqual(store.state.interactions.requests.map(\.id), ["clarification"])
    }
}

private enum InteractionStubError: Error { case retryable(String) }

private enum InteractionResponse: Equatable {
    case approval(id: String, approved: Bool)
    case clarification(id: String, answer: String)
}

private actor InteractionResponseRecorder {
    private(set) var responses: [InteractionResponse] = []

    func recordApproval(id: String, approved: Bool) {
        responses.append(.approval(id: id, approved: approved))
    }

    func recordClarification(id: String, answer: String) {
        responses.append(.clarification(id: id, answer: answer))
    }
}

private actor InteractionAttemptCounter {
    private var attempts = 0

    func isFirstAttempt() -> Bool {
        defer { attempts += 1 }
        return attempts == 0
    }
}

@MainActor
private func XCTAssertThrowsErrorAsync(
    _ expression: @autoclosure () async throws -> Void,
    _ verify: (Error) -> Void
) async {
    do {
        try await expression()
        XCTFail("Expected an error")
    } catch {
        verify(error)
    }
}
