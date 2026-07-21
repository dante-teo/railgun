import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunAppStoreTests: XCTestCase {
    func testSessionListPreservesBackendOrderAndSupportsSelectionClearing() {
        let first = RailgunSessionSummary(
            id: "first",
            model: "gpt-5",
            startedAt: "2026-07-19 09:00",
            messageCount: 2,
            firstUserPreview: "First task"
        )
        let second = RailgunSessionSummary(
            id: "second",
            model: "gpt-5-mini",
            startedAt: "2026-07-19 10:00",
            messageCount: 1,
            firstUserPreview: "Second task"
        )

        var state = RailgunAppReducer.reduce(.initial, .session(.loading))
        state = RailgunAppReducer.reduce(state, .session(.loaded([second, first])))
        state = RailgunAppReducer.reduce(state, .session(.selected("first")))

        XCTAssertFalse(state.session.isLoading)
        XCTAssertEqual(state.session.sessions.map(\.id), ["second", "first"])
        XCTAssertEqual(state.session.selectedSession, first)

        state = RailgunAppReducer.reduce(state, .session(.selected(nil)))

        XCTAssertNil(state.session.activeSessionID)
        XCTAssertNil(state.session.selectedSession)
    }

    func testSessionSummaryUsesUntitledTaskForAnEmptyPreview() {
        let summary = RailgunSessionSummary(
            id: "session-1",
            model: "gpt-5",
            startedAt: "2026-07-19 09:00",
            messageCount: 0,
            firstUserPreview: ""
        )

        XCTAssertEqual(summary.displayTitle, "Untitled Task")
    }

    func testTaskDetailPresentationHandlesLoadingEmptySelectedAndStaleSelections() {
        let summary = RailgunSessionSummary(
            id: "session-1",
            model: "gpt-5",
            startedAt: "2026-07-19 09:00",
            messageCount: 1,
            firstUserPreview: "Inspect the task shell"
        )

        XCTAssertEqual(
            RailgunTaskDetailPresentation(session: .init(
                activeSessionID: nil,
                sessions: [],
                archivedSessions: [],
                isLoading: true
            )),
            .loading
        )
        XCTAssertEqual(RailgunTaskDetailPresentation(session: .initial), .empty)
        XCTAssertEqual(
            RailgunTaskDetailPresentation(session: .init(
                activeSessionID: "session-1",
                sessions: [summary],
                archivedSessions: [],
                isLoading: false
            )),
            .selected(summary)
        )
        XCTAssertEqual(
            RailgunTaskDetailPresentation(session: .init(
                activeSessionID: "missing",
                sessions: [summary],
                archivedSessions: [],
                isLoading: false
            )),
            .staleSelection("missing")
        )
        XCTAssertEqual(
            RailgunTaskDetailPresentation(session: .init(
                activeSessionID: nil,
                sessions: [summary],
                archivedSessions: [],
                isLoading: false
            )),
            .selectionRequired
        )
    }

    func testOnlySelectedTaskPresentationDisplaysTranscriptMessages() {
        let summary = RailgunSessionSummary(
            id: "session-1",
            model: "gpt-5",
            startedAt: "2026-07-19 09:00",
            messageCount: 1,
            firstUserPreview: "Inspect the task shell"
        )

        XCTAssertTrue(RailgunTaskDetailPresentation.selected(summary).displaysTranscriptMessages)
        XCTAssertFalse(RailgunTaskDetailPresentation.loading.displaysTranscriptMessages)
        XCTAssertFalse(RailgunTaskDetailPresentation.empty.displaysTranscriptMessages)
        XCTAssertFalse(RailgunTaskDetailPresentation.selectionRequired.displaysTranscriptMessages)
        XCTAssertFalse(
            RailgunTaskDetailPresentation
                .staleSelection("missing")
                .displaysTranscriptMessages
        )
    }

    func testSessionOperationErrorPresentationPreservesFailureMessage() {
        XCTAssertNil(RailgunSessionOperationErrorPresentation(session: .initial))

        let presentation = RailgunSessionOperationErrorPresentation(
            session: .init(
                activeSessionID: nil,
                sessions: [],
                archivedSessions: [],
                isLoading: false,
                error: "Could not archive the task."
            )
        )

        XCTAssertEqual(presentation?.message, "Could not archive the task.")
    }

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
                    .message(role: .user, text: "Find it", messageID: 20, startedAt: 10),
                    .tool(id: "tool-1", name: "read_file", failed: false, target: "notes.md"),
                    .message(role: .assistant, text: "Found it", messageID: 22, branchable: true, completedAt: 20),
                ],
                todos: [RailgunTodo(id: "todo-1", content: "Ship it", status: .inProgress)],
                isRunning: false
            ))
        )

        XCTAssertEqual(state.session.activeSessionID, "session-1")
        XCTAssertEqual(state.transcript.messages.map(\.order), [1, 3])
        XCTAssertEqual(state.transcript.messages.last?.messageID, 22)
        XCTAssertEqual(state.transcript.messages.first?.startedAt, 10)
        XCTAssertEqual(state.transcript.messages.last?.completedAt, 20)
        XCTAssertEqual(state.transcript.nextOrder, 4)
        XCTAssertEqual(
            state.activity.entries,
            [.tool(id: "tool-1", name: "read_file", status: .success, order: 2, input: "notes.md", output: nil)]
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

    func testQueueReconciliationInjectsMixedKindsInAcknowledgementFIFOOrder() {
        var state = RailgunAppState.initial
        state = RailgunAppReducer.reduce(state, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "steer", kind: .steering, text: "same")))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "follow", kind: .followUp, text: "same")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.queueUpdated(steering: ["same"], followUp: ["same"])))

        XCTAssertEqual(state.transcript.queue.map(\.id), ["steer", "follow"])

        state = RailgunAppReducer.reduce(state, .agentEvent(.queueUpdated(steering: [], followUp: [])))

        XCTAssertTrue(state.transcript.queue.isEmpty)
        XCTAssertEqual(state.transcript.messages.map(\.text), ["start", "same", "same"])
        XCTAssertEqual(state.transcript.messages.suffix(2).map(\.id), ["injected-steer", "injected-follow"])
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

    func testInteractionSubmissionUpdatesOnlyItsRequestAndChoiceDefaultsToFirstOption() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .interaction(.received(.approval(id: "one", command: "echo one"))))
        state = RailgunAppReducer.reduce(state, .interaction(.received(.clarification(id: "two", question: "Which?", choices: ["Safe", "Fast"]))))

        state = RailgunAppReducer.reduce(state, .interaction(.submissionStarted(id: "one")))

        XCTAssertTrue(state.interactions.requests[0].isSubmitting)
        XCTAssertFalse(state.interactions.requests[1].isSubmitting)
        XCTAssertEqual(state.interactions.requests[1].answer, "Safe")

        state = RailgunAppReducer.reduce(state, .interaction(.submissionSucceeded(id: "one")))

        XCTAssertEqual(state.interactions.requests.map(\.id), ["two"])
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
        XCTAssertEqual(state.backend.phase, .disconnected("Connection lost"))
        XCTAssertFalse(state.transcript.isRunning)
    }

    func testDuplicateActivityStartDoesNotConsumeAChronologySlot() {
        var state = RailgunAppState.initial
        state = RailgunAppReducer.reduce(state, .agentEvent(.toolStarted(id: "tool", name: "read_file", input: nil)))
        state = RailgunAppReducer.reduce(state, .agentEvent(.toolStarted(id: "tool", name: "read_file", input: nil)))
        state = RailgunAppReducer.reduce(state, .agentEvent(.runStarted))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta("answer")))

        XCTAssertEqual(state.activity.entries, [
            .tool(id: "tool", name: "read_file", status: .running, order: 1, input: nil, output: nil),
        ])
        XCTAssertEqual(state.transcript.messages.last?.order, 2)
        XCTAssertEqual(state.transcript.nextOrder, 3)
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

    func testQueueFailureRetainsItsCommandForASameKindRetry() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(
            state,
            .transcript(.queueRejected(kind: .followUp, text: "continue", message: "Unavailable"))
        )

        XCTAssertEqual(
            state.transcript.failedQueue,
            .init(kind: .followUp, text: "continue", message: "Unavailable")
        )

        state = RailgunAppReducer.reduce(
            state,
            .transcript(.queueAccepted(id: "retry", kind: .followUp, text: "continue"))
        )

        XCTAssertNil(state.transcript.failedQueue)
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

        XCTAssertTrue(state.transcript.isStopping)
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "late", kind: .steering, text: "ignore")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta("partial")))
        state = RailgunAppReducer.reduce(state, .agentEvent(.runEnded))

        XCTAssertTrue(state.transcript.queue.isEmpty)
        XCTAssertEqual(state.transcript.messages.last?.status, .stopped)
    }

    func testStopAcknowledgementClearsTheCurrentQueueButNotANewRun() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "first", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "queued", kind: .steering, text: "queue")))
        state = RailgunAppReducer.reduce(state, .transcript(.stopRequested))
        state = RailgunAppReducer.reduce(state, .transcript(.stopAcknowledged))

        XCTAssertTrue(state.transcript.queue.isEmpty)

        state = RailgunAppReducer.reduce(state, .transcript(.runEnded(at: 1)))
        state = RailgunAppReducer.reduce(state, .transcript(.submit(id: "second", text: "restart", at: 2)))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "new-queue", kind: .followUp, text: "continue")))
        state = RailgunAppReducer.reduce(state, .transcript(.stopAcknowledged))

        XCTAssertEqual(state.transcript.queue.map(\.id), ["new-queue"])
    }

    func testStopDefersQueueReconciliationUntilTheAbortAcknowledgement() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "queued", kind: .steering, text: "queue")))
        state = RailgunAppReducer.reduce(state, .transcript(.stopRequested))
        state = RailgunAppReducer.reduce(state, .agentEvent(.queueUpdated(steering: [], followUp: [])))

        XCTAssertEqual(state.transcript.queue.map(\.id), ["queued"])
        XCTAssertEqual(state.transcript.messages.map(\.text), ["start"])

        state = RailgunAppReducer.reduce(state, .transcript(.stopAcknowledged))
        XCTAssertTrue(state.transcript.queue.isEmpty)
    }

    func testStopFailureReconcilesTheQueueUpdateDeferredDuringCancellation() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "consumed", kind: .steering, text: "use this")))
        state = RailgunAppReducer.reduce(state, .transcript(.queueAccepted(id: "remaining", kind: .followUp, text: "continue")))
        state = RailgunAppReducer.reduce(state, .transcript(.stopRequested))
        state = RailgunAppReducer.reduce(state, .agentEvent(.queueUpdated(steering: [], followUp: ["continue"])))

        state = RailgunAppReducer.reduce(state, .transcript(.stopFailed(message: "Abort unavailable")))

        XCTAssertFalse(state.transcript.isStopping)
        XCTAssertEqual(state.transcript.queue.map(\.id), ["remaining"])
        XCTAssertEqual(state.transcript.messages.map(\.text), ["start", "use this"])
        XCTAssertEqual(state.transcript.submissionError, "Abort unavailable")
        XCTAssertNil(state.transcript.deferredQueueUpdate)
    }

    func testStopFailureKeepsARejectedQueueAndMarksStopAsTheRetryTarget() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(
            state,
            .transcript(.queueRejected(kind: .followUp, text: "continue", message: "Queue unavailable"))
        )
        state = RailgunAppReducer.reduce(state, .transcript(.stopRequested))

        state = RailgunAppReducer.reduce(state, .transcript(.stopFailed(message: "Abort unavailable")))

        XCTAssertEqual(
            state.transcript.failedQueue,
            .init(kind: .followUp, text: "continue", message: "Queue unavailable")
        )
        XCTAssertEqual(state.transcript.failedStopMessage, "Abort unavailable")
    }

    func testOutOfDateStopFailureDoesNotChangeAnActiveRun() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 0)))
        state = RailgunAppReducer.reduce(state, .transcript(.stopFailed(message: "late failure")))

        XCTAssertTrue(state.transcript.isRunning)
        XCTAssertFalse(state.transcript.isStopping)
        XCTAssertNil(state.transcript.submissionError)
    }

    func testLiveAssistantKeepsOneStreamingMessageAndRecordsBoundaries() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 10)))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta("partial"), at: 20))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta(" output"), at: 21))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantCompleted, at: 30))

        XCTAssertEqual(state.transcript.messages.map(\.text), ["start", "partial output"])
        XCTAssertEqual(state.transcript.messages.last?.startedAt, 20)
        XCTAssertEqual(state.transcript.messages.last?.completedAt, 30)
        XCTAssertEqual(state.transcript.messages.last?.status, .complete)
        XCTAssertEqual(state.transcript.nextOrder, 3)
    }

    func testRunEndCompletesUnfinishedAssistantWithItsBoundaryTimestamp() {
        var state = RailgunAppReducer.reduce(.initial, .transcript(.submit(id: "user", text: "start", at: 10)))
        state = RailgunAppReducer.reduce(state, .agentEvent(.assistantDelta("partial"), at: 20))
        state = RailgunAppReducer.reduce(state, .agentEvent(.runEnded, at: 30))

        XCTAssertEqual(state.transcript.messages.last?.status, .complete)
        XCTAssertEqual(state.transcript.messages.last?.completedAt, 30)
        XCTAssertFalse(state.transcript.isRunning)
    }
}
