import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunAppStoreTests: XCTestCase {
    func testStoreRoutesNormalizedRunEventsWithoutRetainingRawBackendData() {
        let store = RailgunAppStore()

        store.send(.backend(.ready(capabilities: ["sessions"])))
        store.send(.transcript(.submit(id: "user-1", text: "Inspect the retry loop", at: 10)))
        store.send(.agentEvent(.runStarted))
        store.send(.agentEvent(.assistantDelta("It retries")))
        store.send(.agentEvent(.assistantDelta(" forever.")))
        store.send(.agentEvent(.assistantCompleted))
        store.send(.agentEvent(.runEnded))

        XCTAssertEqual(store.state.backend.phase, .ready)
        XCTAssertEqual(store.state.backend.capabilities, ["sessions"])
        XCTAssertEqual(store.state.transcript.messages.map(\.text), ["Inspect the retry loop", "It retries forever."])
        XCTAssertEqual(store.state.transcript.messages.last?.status, .complete)
        XCTAssertFalse(store.state.transcript.isRunning)
        XCTAssertFalse(store.state.transcript.isStopping)
    }

    func testSessionHydrationKeepsTranscriptChronologyAndActivitySeparate() {
        let state = RailgunAppReducer.reduce(
            .initial,
            .session(.hydrated(
                activeSessionID: "session-1",
                transcript: [
                    .message(role: .user, text: "Find it"),
                    .tool(id: "tool-1", name: "read_file", failed: false),
                    .message(role: .assistant, text: "Found it", messageID: 22, branchable: true),
                ],
                todos: [RailgunTodo(id: "todo-1", content: "Ship it", status: .inProgress)],
                isRunning: false
            ))
        )

        XCTAssertEqual(state.session.activeSessionID, "session-1")
        XCTAssertEqual(state.transcript.messages.map(\.order), [1, 3])
        XCTAssertEqual(state.transcript.messages.last?.messageID, 22)
        XCTAssertEqual(
            state.activity.entries,
            [.tool(id: "tool-1", name: "read_file", status: .success, order: 2, input: nil, output: nil)]
        )
        XCTAssertEqual(state.activity.todos, [RailgunTodo(id: "todo-1", content: "Ship it", status: .inProgress)])
    }

    func testQueueReconciliationPreservesDuplicateFIFOIdentityAndInjectsConsumedMessages() {
        var state = RailgunAppState.initial
        state = RailgunAppReducer.reduce(state, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "first", kind: .steering, text: "same")))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "second", kind: .steering, text: "same")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.queueUpdated(steering: ["same"], followUp: [])))

        XCTAssertEqual(state.transcript.queue.map(\.id), ["second"])
        XCTAssertEqual(state.transcript.messages.map(\.text), ["start", "same"])
    }

    func testInteractionsStayInArrivalOrderAndSettleWhenTheRunEnds() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .interaction(.received(.approval(id: "one", command: "echo one"))))
        state = RailgunAppReducer.reduce(state, .interaction(.received(.clarification(id: "two", question: "Which?", choices: ["A", "B"]))))
        state = RailgunAppReducer.reduce(state, .interaction(.answerChanged(id: "two", answer: "B")))
        state = RailgunAppReducer.reduce(state, .interaction(.submissionFailed(id: "two", message: "Retry")))

        XCTAssertEqual(state.interactions.requests.map(\.id), ["one", "two"])
        XCTAssertEqual(state.interactions.requests.last?.answer, "B")
        XCTAssertEqual(state.interactions.requests.last?.error, "Retry")

        state = RailgunAppReducer.reduce(state, .agentEvent(.runEnded))
        XCTAssertTrue(state.interactions.requests.isEmpty)
    }

    func testActivitySettlesRunningWorkAndUpdatesContextControls() {
        var state = RailgunAppState.initial
        state = RailgunAppReducer.reduce(state, .agentEvent(.toolStarted(id: "tool", name: "read_file", input: "safe")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.toolEnded(id: "tool", name: "read_file", failed: false, output: "done", todos: nil)))
        state = RailgunAppReducer.reduce(state, .agentEvent(.subagentStarted(goal: "Inspect", index: 0, count: 1)))
        state = RailgunAppReducer.reduce(state, .agentEvent(.contextUsage(inputTokens: 12, outputTokens: 8)))
        state = RailgunAppReducer.reduce(state, .backend(.disconnected(message: "Connection lost")))

        XCTAssertEqual(state.controls.contextUsage, .init(inputTokens: 12, outputTokens: 8))
        XCTAssertEqual(
            state.activity.entries,
            [.tool(id: "tool", name: "read_file", status: .success, order: 1, input: "safe", output: "done")]
        )
        XCTAssertEqual(state.activity.subagents.first?.status, .interrupted)
        XCTAssertEqual(state.backend.phase, .disconnected)
        XCTAssertFalse(state.transcript.isRunning)
    }

    func testRunEndSettlesStreamingAssistantExactlyOnce() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.stopRequested))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta("partial")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.runEnded))

        XCTAssertEqual(state.transcript.messages.last?.status, .stopped)
        XCTAssertFalse(state.transcript.isRunning)
        XCTAssertFalse(state.transcript.isStopping)
    }

    func testBackendInterruptionFailsTheActiveRunAndPreservesRetryDetails() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "retry me", at: 0)))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta("partial")))
        state = RailgunAppReducer.reduce(state, .backend(.disconnected(message: "Connection lost")))

        XCTAssertEqual(state.backend.phase, .disconnected("Connection lost"))
        XCTAssertEqual(state.transcript.messages.last?.status, .failed)
        XCTAssertEqual(state.transcript.failedRun, .init(userID: "user", text: "retry me", message: "Connection lost"))
        XCTAssertNil(state.transcript.activeRun)
        XCTAssertFalse(state.transcript.isRunning)
    }

    func testLateRunStartDoesNotUndoAnInFlightStopRequest() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.stopRequested))
        state = RailgunAppReducer.reduce(state, .agentEvent(.runStarted))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "late", kind: .steering, text: "ignore")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta("partial")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.runEnded))

        XCTAssertTrue(state.transcript.queue.isEmpty)
        XCTAssertEqual(state.transcript.messages.last?.status, .stopped)
    }
}
