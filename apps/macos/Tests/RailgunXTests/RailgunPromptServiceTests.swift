import Foundation
import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunPromptServiceTests: XCTestCase {
    func testServiceRoutesValidatedPromptSteeringAndFollowUpCommands() async throws {
        let recorder = PromptRequestRecorder()
        let service = RailgunPromptService { command in
            await recorder.record(command)
            return try acknowledgement(for: command.type)
        }

        try await service.prompt("Start task")
        try await service.steer("Change course")
        try await service.followUp("Do this next")

        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.prompt, .steer, .followUp])
        XCTAssertEqual(commands.map { $0.fields["message"]?.stringValue }, ["Start task", "Change course", "Do this next"])
    }

    func testServiceRejectsBlankMessagesBeforeSendingARequest() async throws {
        let recorder = PromptRequestRecorder()
        let service = RailgunPromptService { command in
            await recorder.record(command)
            return try acknowledgement(for: command.type)
        }

        await XCTAssertThrowsErrorAsync(try await service.prompt(" \n\t ")) { error in
            XCTAssertEqual(error as? RailgunPromptServiceError, .invalidRequest)
        }
        let commands = await recorder.commands
        XCTAssertTrue(commands.isEmpty)
    }

    func testServiceConvertsRejectedAndMalformedAcknowledgementsToSafeErrors() async throws {
        let rejected = RailgunPromptService { command in
            try response(for: command.type, success: false, error: "Bearer sensitive-token was rejected")
        }
        await XCTAssertThrowsErrorAsync(try await rejected.steer("Retry")) { error in
            guard case let .some(.rejected(message)) = error as? RailgunPromptServiceError else {
                return XCTFail("Expected a rejected presentation error")
            }
            XCTAssertFalse(message.contains("sensitive-token"))
        }

        let malformed = RailgunPromptService { command in
            try response(for: command.type, success: true, data: .object([:]))
        }
        await XCTAssertThrowsErrorAsync(try await malformed.followUp("Next")) { error in
            XCTAssertEqual(error as? RailgunPromptServiceError, .invalidResponse)
        }

        let mismatched = RailgunPromptService { _ in
            try acknowledgement(for: .abort)
        }
        await XCTAssertThrowsErrorAsync(try await mismatched.prompt("Start")) { error in
            XCTAssertEqual(error as? RailgunPromptServiceError, .invalidResponse)
        }
    }

    func testCoordinatorKeepsAcceptingQueueCommandsWhileAnInitialPromptAwaitsItsFinalResponse() async throws {
        let store = RailgunAppStore()
        let gate = PromptResponseGate()
        let service = RailgunPromptService { command in
            try await gate.response(for: command)
        }
        let coordinator = RailgunPromptCoordinator(store: store, service: service)

        let didStart = await coordinator.submit("Start")
        XCTAssertTrue(didStart)
        XCTAssertTrue(store.state.transcript.isRunning)
        XCTAssertEqual(store.state.transcript.messages.map(\.text), ["Start"])

        let didQueueSteering = await coordinator.enqueue("Steer", kind: .steering)
        XCTAssertTrue(didQueueSteering)
        XCTAssertEqual(store.state.transcript.queue.map(\.kind), [.steering])

        try await gate.releasePrompt()
    }

    func testQueueRetryPreservesTheRejectedFollowUpKindAndText() async throws {
        let store = RailgunAppStore()
        let recorder = PromptRequestRecorder()
        let attempts = PromptAttemptCounter()
        let service = RailgunPromptService { command in
            await recorder.record(command)
            if command.type == .followUp, await attempts.isFirstAttempt() {
                return try response(for: command.type, success: false, error: "Follow-up unavailable")
            }
            return try acknowledgement(for: command.type)
        }
        let coordinator = RailgunPromptCoordinator(store: store, service: service)

        let didStart = await coordinator.submit("Start")
        XCTAssertTrue(didStart)
        let didQueueFollowUp = await coordinator.enqueue("Continue later", kind: .followUp)
        XCTAssertFalse(didQueueFollowUp)
        XCTAssertEqual(
            store.state.transcript.failedQueue,
            .init(kind: .followUp, text: "Continue later", message: "Follow-up unavailable")
        )

        let didRetry = await coordinator.retryQueue()
        XCTAssertTrue(didRetry)
        XCTAssertNil(store.state.transcript.failedQueue)
        let commands = await recorder.commands
        XCTAssertEqual(commands.filter { $0.type == .prompt }.count, 1)
        XCTAssertEqual(
            commands.filter { $0.type == .followUp }.map { $0.fields["message"]?.stringValue },
            ["Continue later", "Continue later"]
        )
    }
}

private actor PromptRequestRecorder {
    private(set) var commands: [RailgunRPCCommand] = []

    func record(_ command: RailgunRPCCommand) {
        commands.append(command)
    }
}

private actor PromptAttemptCounter {
    private var attempts = 0

    func isFirstAttempt() -> Bool {
        defer { attempts += 1 }
        return attempts == 0
    }
}

private actor PromptResponseGate {
    private var promptContinuation: CheckedContinuation<RailgunRPCResponse, Error>?
    private var isPromptReleased = false

    func response(for command: RailgunRPCCommand) async throws -> RailgunRPCResponse {
        guard command.type == .prompt else { return try acknowledgement(for: command.type) }
        if isPromptReleased { return try acknowledgement(for: command.type) }
        return try await withCheckedThrowingContinuation { continuation in
            promptContinuation = continuation
        }
    }

    func releasePrompt() throws {
        isPromptReleased = true
        promptContinuation?.resume(returning: try acknowledgement(for: .prompt))
        promptContinuation = nil
    }
}

private func acknowledgement(for command: RailgunRPCCommandType) throws -> RailgunRPCResponse {
    try response(for: command, success: true)
}

private func response(
    for command: RailgunRPCCommandType,
    success: Bool,
    data: RailgunJSONValue? = nil,
    error: String? = nil
) throws -> RailgunRPCResponse {
    var object: [String: RailgunJSONValue] = [
        "type": .string("response"),
        "command": .string(command.rawValue),
        "success": .bool(success),
    ]
    if let data { object["data"] = data }
    if let error { object["error"] = .string(error) }
    return try .init(data: JSONEncoder().encode(RailgunJSONValue.object(object)))
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
