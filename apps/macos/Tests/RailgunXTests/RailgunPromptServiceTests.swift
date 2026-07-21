import Foundation
import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunPromptServiceTests: XCTestCase {
    func testServiceRoutesValidatedPromptQueueAndAbortCommands() async throws {
        let recorder = PromptRequestRecorder()
        let service = RailgunPromptService { command in
            await recorder.record(command)
            return try acknowledgement(for: command.type)
        }

        try await service.prompt("Start task")
        try await service.steer("Change course")
        try await service.followUp("Do this next")
        try await service.abort()

        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.prompt, .steer, .followUp, .abort])
        XCTAssertEqual(
            commands.dropLast().map { $0.fields["message"]?.stringValue },
            ["Start task", "Change course", "Do this next"]
        )
        XCTAssertTrue(commands.last?.fields.isEmpty == true)
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

    func testAbortConvertsRejectedAndMalformedAcknowledgementsToSafeErrors() async throws {
        let rejected = RailgunPromptService { command in
            try response(for: command.type, success: false, error: "Bearer sensitive-token was rejected")
        }
        await XCTAssertThrowsErrorAsync(try await rejected.abort()) { error in
            guard case let .some(.rejected(message)) = error as? RailgunPromptServiceError else {
                return XCTFail("Expected a rejected presentation error")
            }
            XCTAssertFalse(message.contains("sensitive-token"))
        }

        let malformed = RailgunPromptService { command in
            try response(for: command.type, success: true, data: .object([:]))
        }
        await XCTAssertThrowsErrorAsync(try await malformed.abort()) { error in
            XCTAssertEqual(error as? RailgunPromptServiceError, .invalidResponse)
        }

        let mismatched = RailgunPromptService { _ in
            try acknowledgement(for: .prompt)
        }
        await XCTAssertThrowsErrorAsync(try await mismatched.abort()) { error in
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

    func testCoordinatorOptimisticallyStopsOnlyOnceThenAppliesTheAcknowledgement() async throws {
        let store = RailgunAppStore()
        store.send(.transcript(.submit(id: "user", text: "Start", at: 0)))
        store.send(.transcript(.queueAccepted(id: "queued", kind: .steering, text: "Change course")))
        let gate = AbortResponseGate()
        let coordinator = RailgunPromptCoordinator(
            store: store,
            service: RailgunPromptService { command in try await gate.response(for: command) }
        )

        let firstStop = Task { await coordinator.stop() }
        await gate.waitUntilAbortRequested()

        XCTAssertTrue(store.state.transcript.isStopping)
        let duplicateStop = await coordinator.stop()
        XCTAssertFalse(duplicateStop)

        try await gate.releaseAbort()

        let didStop = await firstStop.value
        XCTAssertTrue(didStop)
        XCTAssertTrue(store.state.transcript.isStopping)
        XCTAssertTrue(store.state.transcript.queue.isEmpty)
        let commands = await gate.commands
        XCTAssertEqual(commands.map(\.type), [.abort])
    }

    func testCoordinatorRecoversFromFailedAbortAndAllowsAnotherStopAttempt() async throws {
        let store = RailgunAppStore()
        store.send(.transcript(.submit(id: "user", text: "Start", at: 0)))
        let attempts = AbortAttemptCounter()
        let coordinator = RailgunPromptCoordinator(
            store: store,
            service: RailgunPromptService { command in
                if command.type == .abort, await attempts.isFirstAttempt() {
                    return try response(
                        for: command.type,
                        success: false,
                        error: "Bearer sensitive-token was rejected"
                    )
                }
                return try acknowledgement(for: command.type)
            }
        )

        let firstStop = await coordinator.stop()
        XCTAssertFalse(firstStop)
        XCTAssertFalse(store.state.transcript.isStopping)
        XCTAssertTrue(store.state.transcript.isRunning)
        XCTAssertFalse(store.state.transcript.submissionError?.contains("sensitive-token") ?? true)

        let secondStop = await coordinator.stop()
        XCTAssertTrue(secondStop)
        XCTAssertTrue(store.state.transcript.isStopping)
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

private actor AbortResponseGate {
    private var abortResponseContinuation: CheckedContinuation<RailgunRPCResponse, Error>?
    private var abortRequestedContinuation: CheckedContinuation<Void, Never>?
    private(set) var commands: [RailgunRPCCommand] = []

    func response(for command: RailgunRPCCommand) async throws -> RailgunRPCResponse {
        commands.append(command)
        guard command.type == .abort else { return try acknowledgement(for: command.type) }
        abortRequestedContinuation?.resume()
        abortRequestedContinuation = nil
        return try await withCheckedThrowingContinuation { continuation in
            abortResponseContinuation = continuation
        }
    }

    func waitUntilAbortRequested() async {
        guard !commands.contains(where: { $0.type == .abort }) else { return }
        await withCheckedContinuation { continuation in
            abortRequestedContinuation = continuation
        }
    }

    func releaseAbort() throws {
        abortResponseContinuation?.resume(returning: try acknowledgement(for: .abort))
        abortResponseContinuation = nil
    }
}

private actor AbortAttemptCounter {
    private var attempts = 0

    func isFirstAttempt() -> Bool {
        defer { attempts += 1 }
        return attempts == 0
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
