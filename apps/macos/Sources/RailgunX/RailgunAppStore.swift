import Foundation
import Observation
import RailgunTransport

/// The presentation state for the Task feature.
///
/// State changes are expressed as values and reduced synchronously. Effects
/// such as RPC calls deliberately live outside this type, which makes the
/// feature deterministic to test and prevents raw backend frames from leaking
/// into SwiftUI state.
struct RailgunAppState: Equatable {
    var backend: RailgunBackendState
    var session: RailgunSessionState
    var transcript: RailgunTranscriptState
    var controls: RailgunControlsState
    var interactions: RailgunInteractionState
    var activity: RailgunActivityState

    static let initial = Self(
        backend: .initial,
        session: .initial,
        transcript: .initial,
        controls: .initial,
        interactions: .initial,
        activity: .initial
    )
}

@MainActor
@Observable
final class RailgunAppStore {
    private(set) var state: RailgunAppState

    init(initialState: RailgunAppState = .initial) {
        state = initialState
    }

    func send(_ action: RailgunAppAction) {
        state = RailgunAppReducer.reduce(state, action.stamped(at: Self.currentTimestamp))
    }

    private static var currentTimestamp: Int {
        Int(Date().timeIntervalSince1970 * 1_000)
    }
}

enum RailgunAppAction: Equatable {
    case backend(RailgunBackendAction)
    case session(RailgunSessionAction)
    case transcript(RailgunTranscriptAction)
    case controls(RailgunControlsAction)
    case interaction(RailgunInteractionAction)
    case activity(RailgunActivityAction)
    case agentEvent(RailgunAgentEvent, at: Int? = nil)

    fileprivate func stamped(at timestamp: Int) -> Self {
        guard case let .agentEvent(event, at: nil) = self else { return self }
        return .agentEvent(event, at: timestamp)
    }
}

enum RailgunAppReducer {
    static func reduce(_ state: RailgunAppState, _ action: RailgunAppAction) -> RailgunAppState {
        switch action {
        case let .backend(action):
            var next = state
            next.backend = RailgunBackendReducer.reduce(state.backend, action)
            switch next.backend.phase {
            case let .failed(message), let .disconnected(message):
                return settleInterruptedRun(next, message: message)
            case .starting, .ready, .authenticationRequired:
                return next
            }
        case let .session(action):
            let session = RailgunSessionReducer.reduce(state.session, action)
            switch action {
            case let .hydrated(activeSessionID, transcript, todos, isRunning):
                var next = state
                next.session = session
                next.transcript = RailgunTranscriptReducer.hydrate(transcript, isRunning: isRunning)
                next.activity = RailgunActivityReducer.hydrate(transcript, todos: todos)
                next.session.activeSessionID = activeSessionID
                next.interactions = .initial
                return next
            case .created:
                var next = state
                next.session = session
                next.transcript = .initial
                next.activity = .initial
                next.interactions = .initial
                return next
            default:
                var next = state
                next.session = session
                return next
            }
        case let .transcript(action):
            var next = state
            next.transcript = RailgunTranscriptReducer.reduce(state.transcript, action)
            return next
        case let .controls(action):
            var next = state
            next.controls = RailgunControlsReducer.reduce(state.controls, action)
            return next
        case let .interaction(action):
            guard !action.isIncoming || state.transcript.isRunning else { return state }
            var next = state
            next.interactions = RailgunInteractionReducer.reduce(state.interactions, action)
            return next
        case let .activity(action):
            var next = state
            next.activity = RailgunActivityReducer.reduce(state.activity, action)
            return next
        case let .agentEvent(event, timestamp):
            return reduceAgentEvent(state, event, timestamp: timestamp)
        }
    }

    private static func reduceAgentEvent(
        _ state: RailgunAppState,
        _ event: RailgunAgentEvent,
        timestamp: Int?
    ) -> RailgunAppState {
        switch event {
        case .runStarted:
            var next = reduce(state, .transcript(.runStarted))
            next.activity = RailgunActivityReducer.reduce(next.activity, .runStarted)
            return next
        case .runEnded:
            return settleRun(reduce(state, .transcript(.runEnded(at: timestamp))))
        case .sessionSaved:
            return state
        case let .assistantDelta(text):
            return reduce(state, .transcript(.assistantDelta(
                id: "assistant-\(state.transcript.nextOrder)",
                text: text,
                at: timestamp
            )))
        case .assistantCompleted:
            var next = reduce(state, .transcript(.assistantCompleted(at: timestamp)))
            next.activity = RailgunActivityReducer.reduce(next.activity, .aggregationCompleted)
            return next
        case let .queueUpdated(steering, followUp):
            return reduce(state, .transcript(.queueUpdated(steering: steering, followUp: followUp)))
        case let .contextUsage(inputTokens, outputTokens):
            return reduce(state, .controls(.contextUsage(.init(inputTokens: inputTokens, outputTokens: outputTokens))))
        case let .contextReset(reason):
            return reduce(state, .controls(.contextReset(reason)))
        case let .toolStarted(id, name, input):
            return reduceOrderedActivity(state, .toolStarted(id: id, name: name, input: input))
        case let .toolEnded(id, name, failed, output, todos):
            return reduce(state, .activity(.toolEnded(id: id, name: name, failed: failed, output: output, todos: todos)))
        case let .moaReferenceStarted(index, count, model):
            return reduceOrderedActivity(state, .moaReferenceStarted(index: index, count: count, model: model))
        case let .moaReferenceEnded(index, model, preview):
            return reduce(state, .activity(.moaReferenceEnded(index: index, model: model, preview: preview)))
        case let .moaAggregating(model, referenceCount):
            return reduceOrderedActivity(state, .moaAggregating(model: model, referenceCount: referenceCount))
        case let .advisorNote(severity, text):
            return reduceOrderedActivity(state, .advisorNote(severity: severity, text: text))
        case let .subagentStarted(goal, index, count):
            return reduceOrderedActivity(state, .subagentStarted(goal: goal, index: index, count: count))
        case let .subagentEnded(goal, index, result):
            return reduce(state, .activity(.subagentEnded(goal: goal, index: index, result: result)))
        }
    }

    private static func reduceOrderedActivity(_ state: RailgunAppState, _ action: RailgunActivityAction) -> RailgunAppState {
        let activity = RailgunActivityReducer.reduce(
            state.activity,
            action.withOrder(state.transcript.nextOrder)
        )
        guard activity != state.activity else { return state }
        var next = state
        next.activity = activity
        next.transcript.nextOrder += 1
        return next
    }

    private static func settleInterruptedRun(_ state: RailgunAppState, message: String) -> RailgunAppState {
        var next = state
        if let activeRun = state.transcript.activeRun {
            next.transcript = RailgunTranscriptReducer.reduce(
                state.transcript,
                .requestFailed(userID: activeRun.userID, text: activeRun.text, message: message)
            )
        } else {
            next.transcript = RailgunTranscriptReducer.reduce(state.transcript, .runEnded(at: nil))
        }
        return settleRun(next)
    }

    private static func settleRun(_ state: RailgunAppState) -> RailgunAppState {
        var next = state
        next.interactions = .initial
        next.activity = RailgunActivityReducer.reduce(state.activity, .settle)
        return next
    }
}

enum RailgunBackendPhase: Equatable {
    case starting
    case ready
    case authenticationRequired
    case failed(String)
    case disconnected(String)
}

struct RailgunBackendState: Equatable {
    var phase: RailgunBackendPhase
    var capabilities: Set<String>

    static let initial = Self(phase: .starting, capabilities: [])
}

enum RailgunBackendAction: Equatable {
    case starting
    case ready(capabilities: Set<String>)
    case authenticationRequired
    case failed(message: String)
    case disconnected(message: String)
}

enum RailgunBackendReducer {
    static func reduce(_ state: RailgunBackendState, _ action: RailgunBackendAction) -> RailgunBackendState {
        switch action {
        case .starting: .init(phase: .starting, capabilities: [])
        case let .ready(capabilities): .init(phase: .ready, capabilities: capabilities)
        case .authenticationRequired: .init(phase: .authenticationRequired, capabilities: [])
        case let .failed(message): .init(phase: .failed(message), capabilities: [])
        case let .disconnected(message): .init(phase: .disconnected(message), capabilities: [])
        }
    }
}

struct RailgunSessionSummary: Equatable, Identifiable, Sendable {
    let id: String
    let model: String
    let startedAt: String
    let messageCount: Int
    let firstUserPreview: String
    /// A newly-created session has no saved checkpoint yet, so it must not be
    /// represented as a persisted sidebar entry.
    let isPersisted: Bool

    init(
        id: String,
        model: String,
        startedAt: String,
        messageCount: Int,
        firstUserPreview: String,
        isPersisted: Bool = true
    ) {
        self.id = id
        self.model = model
        self.startedAt = startedAt
        self.messageCount = messageCount
        self.firstUserPreview = firstUserPreview
        self.isPersisted = isPersisted
    }

    var displayTitle: String {
        firstUserPreview.isEmpty ? "Untitled Task" : firstUserPreview
    }
}

struct RailgunSessionState: Equatable {
    var activeSessionID: String?
    var sessions: [RailgunSessionSummary]
    var archivedSessions: [RailgunSessionSummary]
    var isLoading: Bool
    var error: String? = nil
    var activeSession: RailgunSessionSummary? = nil

    static let initial = Self(activeSessionID: nil, sessions: [], archivedSessions: [], isLoading: false)

    var selectedSession: RailgunSessionSummary? {
        guard let activeSessionID else { return nil }
        return activeSession?.id == activeSessionID
            ? activeSession
            : sessions.first(where: { $0.id == activeSessionID })
    }
}

enum RailgunRestoredTranscriptEntry: Equatable {
    enum Role: Equatable { case user, assistant }

    case message(
        role: Role,
        text: String,
        messageID: Int? = nil,
        branchable: Bool = false,
        startedAt: Int? = nil,
        completedAt: Int? = nil
    )
    case tool(id: String, name: String, failed: Bool, target: String? = nil)
}

enum RailgunSessionAction: Equatable {
    case loading
    case loaded([RailgunSessionSummary])
    case archivedLoaded([RailgunSessionSummary])
    case created(id: String, model: String?)
    case selected(String?)
    case hydrated(activeSessionID: String, transcript: [RailgunRestoredTranscriptEntry], todos: [RailgunTodo], isRunning: Bool)
    case failed(message: String)
}

enum RailgunSessionReducer {
    static func reduce(_ state: RailgunSessionState, _ action: RailgunSessionAction) -> RailgunSessionState {
        switch action {
        case .loading:
            var next = state
            next.isLoading = true
            next.error = nil
            return next
        case let .loaded(sessions):
            var next = state
            next.sessions = sessions
            next.isLoading = false
            next.error = nil
            next.activeSession = activeSession(for: next.activeSessionID, in: sessions, preserving: state.activeSession)
            return next
        case let .archivedLoaded(sessions):
            var next = state
            next.archivedSessions = sessions
            next.isLoading = false
            next.error = nil
            return next
        case let .created(id, model):
            var next = state
            next.activeSessionID = id
            next.activeSession = .init(
                id: id,
                model: model ?? "Default model",
                startedAt: "Just now",
                messageCount: 0,
                firstUserPreview: "",
                isPersisted: false
            )
            next.isLoading = false
            next.error = nil
            return next
        case let .selected(id):
            var next = state
            next.activeSessionID = id
            next.activeSession = activeSession(for: id, in: state.sessions, preserving: nil)
            return next
        case let .hydrated(id, _, _, _):
            var next = state
            next.activeSessionID = id
            next.activeSession = activeSession(for: id, in: state.sessions, preserving: state.activeSession)
            next.isLoading = false
            next.error = nil
            return next
        case let .failed(message):
            var next = state
            next.isLoading = false
            next.error = message
            return next
        }
    }

    private static func activeSession(
        for id: String?,
        in sessions: [RailgunSessionSummary],
        preserving existing: RailgunSessionSummary?
    ) -> RailgunSessionSummary? {
        guard let id else { return nil }
        if let saved = sessions.first(where: { $0.id == id }) { return saved }
        guard let existing, existing.id == id, !existing.isPersisted else { return nil }
        return existing
    }
}

enum RailgunMessageStatus: Equatable { case streaming, complete, failed, stopped }
enum RailgunQueueKind: Equatable { case steering, followUp }

struct RailgunTranscriptMessage: Equatable, Identifiable {
    enum Role: Equatable { case user, assistant }

    let id: String
    let role: Role
    var text: String
    var status: RailgunMessageStatus
    let order: Int
    let messageID: Int?
    let branchable: Bool
    let startedAt: Int?
    var completedAt: Int?
}

struct RailgunQueuedMessage: Equatable, Identifiable {
    let id: String
    let kind: RailgunQueueKind
    let text: String
}

struct RailgunTranscriptState: Equatable {
    var messages: [RailgunTranscriptMessage]
    var queue: [RailgunQueuedMessage]
    var isRunning: Bool
    var isStopping: Bool
    var submissionError: String?
    var activeRun: RailgunRunRequest?
    var failedRun: RailgunFailedRun?
    var nextOrder: Int

    static let initial = Self(messages: [], queue: [], isRunning: false, isStopping: false, submissionError: nil, activeRun: nil, failedRun: nil, nextOrder: 1)
}

struct RailgunRunRequest: Equatable { let userID: String; let text: String }
struct RailgunFailedRun: Equatable { let userID: String; let text: String; let message: String }

enum RailgunTranscriptAction: Equatable {
    case submit(id: String, text: String, at: Int?)
    case retry
    case requestFailed(userID: String, text: String, message: String)
    case runStarted
    case assistantDelta(id: String, text: String, at: Int? = nil)
    case assistantCompleted(at: Int? = nil)
    case queueAccepted(id: String, kind: RailgunQueueKind, text: String)
    case queueUpdated(steering: [String], followUp: [String])
    case queueRejected(message: String)
    case stopRequested
    case stopFailed(message: String)
    case stopAcknowledged
    case runEnded(at: Int? = nil)
    case reset
}

enum RailgunTranscriptReducer {
    static func reduce(_ state: RailgunTranscriptState, _ action: RailgunTranscriptAction) -> RailgunTranscriptState {
        switch action {
        case let .submit(id, text, at):
            var next = state
            next.messages.append(.init(id: id, role: .user, text: text, status: .complete, order: state.nextOrder, messageID: nil, branchable: false, startedAt: at, completedAt: nil))
            next.queue = []
            next.isRunning = true
            next.isStopping = false
            next.submissionError = nil
            next.activeRun = .init(userID: id, text: text)
            next.failedRun = nil
            next.nextOrder += 1
            return next
        case .retry:
            guard let failed = state.failedRun else { return state }
            var next = state
            next.messages = state.messages.map { $0.id == failed.userID ? withStatus($0, .complete) : $0 }
            next.isRunning = true
            next.isStopping = false
            next.submissionError = nil
            next.activeRun = .init(userID: failed.userID, text: failed.text)
            next.failedRun = nil
            return next
        case let .requestFailed(userID, text, message):
            return fail(state, userID: userID, text: text, message: message)
        case .runStarted:
            var next = state
            next.isRunning = true
            return next
        case let .assistantDelta(id, text, at):
            guard state.isRunning else { return state }
            var next = state
            if let last = state.messages.last, last.role == .assistant, last.status == .streaming {
                next.messages[next.messages.count - 1].text += text
            } else {
                next.messages.append(.init(id: id, role: .assistant, text: text, status: .streaming, order: state.nextOrder, messageID: nil, branchable: false, startedAt: at, completedAt: nil))
                next.nextOrder += 1
            }
            return next
        case let .assistantCompleted(at):
            var next = state
            finishLastAssistant(&next, status: .complete, completedAt: at)
            return next
        case let .queueAccepted(id, kind, text):
            guard state.isRunning, !state.isStopping else { return state }
            var next = state
            next.queue.append(.init(id: id, kind: kind, text: text))
            next.submissionError = nil
            return next
        case let .queueUpdated(steering, followUp):
            let result = reconcile(queue: state.queue, steering: steering, followUp: followUp)
            var next = state
            next.queue = result.remaining
            for item in result.injected {
                next.messages.append(.init(id: "injected-\(item.id)", role: .user, text: item.text, status: .complete, order: next.nextOrder, messageID: nil, branchable: false, startedAt: nil, completedAt: nil))
                next.nextOrder += 1
            }
            return next
        case let .queueRejected(message):
            var next = state
            next.submissionError = message
            return next
        case .stopRequested:
            guard state.isRunning, !state.isStopping else { return state }
            var next = state
            next.isStopping = true
            next.submissionError = nil
            return next
        case let .stopFailed(message):
            guard state.isRunning else { return state }
            var next = state
            next.isStopping = false
            next.submissionError = message
            return next
        case .stopAcknowledged:
            var next = state
            next.queue = []
            return next
        case let .runEnded(at):
            var next = state
            finishLastAssistant(&next, status: state.isStopping ? .stopped : .complete, completedAt: at)
            next.queue = []
            next.isRunning = false
            next.isStopping = false
            next.activeRun = nil
            return next
        case .reset:
            return .initial
        }
    }

    static func hydrate(_ entries: [RailgunRestoredTranscriptEntry], isRunning: Bool) -> RailgunTranscriptState {
        var messages: [RailgunTranscriptMessage] = []
        for (offset, entry) in entries.enumerated() {
            guard case let .message(role, text, messageID, branchable, startedAt, completedAt) = entry else { continue }
            messages.append(.init(id: "restored-\(offset + 1)", role: role == .user ? .user : .assistant, text: text, status: .complete, order: offset + 1, messageID: messageID, branchable: branchable, startedAt: startedAt, completedAt: completedAt))
        }
        return .init(messages: messages, queue: [], isRunning: isRunning, isStopping: false, submissionError: nil, activeRun: nil, failedRun: nil, nextOrder: entries.count + 1)
    }

    private static func withStatus(_ message: RailgunTranscriptMessage, _ status: RailgunMessageStatus) -> RailgunTranscriptMessage {
        var copy = message
        copy.status = status
        return copy
    }

    private static func finishLastAssistant(
        _ state: inout RailgunTranscriptState,
        status: RailgunMessageStatus,
        completedAt: Int? = nil
    ) {
        guard let index = state.messages.lastIndex(where: { $0.role == .assistant && $0.status == .streaming }) else { return }
        state.messages[index].status = status
        state.messages[index].completedAt = completedAt ?? state.messages[index].completedAt
    }

    private static func reconcile(queue: [RailgunQueuedMessage], steering: [String], followUp: [String]) -> (remaining: [RailgunQueuedMessage], injected: [RailgunQueuedMessage]) {
        let steeringResult = reconcile(queue.filter { $0.kind == .steering }, backend: steering)
        let followUpResult = reconcile(queue.filter { $0.kind == .followUp }, backend: followUp)
        let remainingIDs = Set((steeringResult.remaining + followUpResult.remaining).map(\ .id))
        let injectedIDs = Set((steeringResult.injected + followUpResult.injected).map(\ .id))
        return (queue.filter { remainingIDs.contains($0.id) }, queue.filter { injectedIDs.contains($0.id) })
    }

    private static func reconcile(_ current: [RailgunQueuedMessage], backend: [String]) -> (remaining: [RailgunQueuedMessage], injected: [RailgunQueuedMessage]) {
        for removed in 0 ... current.count {
            let remaining = Array(current.dropFirst(removed))
            guard remaining.count <= backend.count else { continue }
            guard !(remaining.isEmpty && !backend.isEmpty) else { continue }
            if remaining.map(\ .text) == backend {
                return (remaining, Array(current.prefix(removed)))
            }
        }
        return (current, [])
    }

    private static func fail(_ state: RailgunTranscriptState, userID: String, text: String, message: String) -> RailgunTranscriptState {
        guard let userIndex = state.messages.firstIndex(where: { $0.id == userID }) else { return state }
        var next = state
        if let assistantIndex = next.messages.indices.reversed().first(where: { $0 > userIndex && next.messages[$0].role == .assistant }) {
            next.messages[assistantIndex].status = .failed
        } else {
            next.messages[userIndex].status = .failed
        }
        next.queue = []
        next.isRunning = false
        next.isStopping = false
        next.activeRun = nil
        next.failedRun = .init(userID: userID, text: text, message: message)
        return next
    }
}

struct RailgunContextUsage: Equatable { let inputTokens: Int; let outputTokens: Int }

struct RailgunModel: Equatable, Identifiable {
    let id: String
    let name: String
}

struct RailgunControlsState: Equatable {
    var models: [RailgunModel]
    var activeModelID: String?
    var defaultModelID: String?
    var contextUsage: RailgunContextUsage?
    var lastContextReset: RailgunContextResetReason?
    var isMutating: Bool
    var error: String?

    static let initial = Self(models: [], activeModelID: nil, defaultModelID: nil, contextUsage: nil, lastContextReset: nil, isMutating: false, error: nil)
}

enum RailgunControlsAction: Equatable {
    case loaded(models: [RailgunModel], activeModelID: String, defaultModelID: String?)
    case contextUsage(RailgunContextUsage)
    case contextReset(RailgunContextResetReason)
    case mutationStarted
    case mutationFinished(activeModelID: String?)
    case mutationFailed(String)
}

enum RailgunControlsReducer {
    static func reduce(_ state: RailgunControlsState, _ action: RailgunControlsAction) -> RailgunControlsState {
        var next = state
        switch action {
        case let .loaded(models, activeModelID, defaultModelID):
            next.models = models
            next.activeModelID = activeModelID
            next.defaultModelID = defaultModelID
            next.isMutating = false
            next.error = nil
        case let .contextUsage(usage): next.contextUsage = usage
        case let .contextReset(reason):
            next.contextUsage = nil
            next.lastContextReset = reason
        case .mutationStarted:
            next.isMutating = true
            next.error = nil
        case let .mutationFinished(activeModelID):
            next.activeModelID = activeModelID
            next.isMutating = false
        case let .mutationFailed(message):
            next.isMutating = false
            next.error = message
        }
        return next
    }
}

enum RailgunInteractionKind: Equatable { case approval, clarification }

struct RailgunInteractionRequest: Equatable, Identifiable {
    let id: String
    let kind: RailgunInteractionKind
    let command: String?
    let question: String?
    let choices: [String]?
    var answer: String
    var isSubmitting: Bool
    var error: String?
}

struct RailgunInteractionState: Equatable {
    var requests: [RailgunInteractionRequest]
    static let initial = Self(requests: [])
}

enum RailgunInteractionAction: Equatable {
    case received(RailgunRPCInteraction)
    case answerChanged(id: String, answer: String)
    case submissionStarted(id: String)
    case submissionSucceeded(id: String)
    case submissionFailed(id: String, message: String)
    case settle

    var isIncoming: Bool {
        if case .received = self { return true }
        return false
    }
}

enum RailgunInteractionReducer {
    static func reduce(_ state: RailgunInteractionState, _ action: RailgunInteractionAction) -> RailgunInteractionState {
        switch action {
        case let .received(interaction):
            guard !state.requests.contains(where: { $0.id == interaction.id }) else { return state }
            var next = state
            switch interaction {
            case let .approval(id, command):
                next.requests.append(.init(id: id, kind: .approval, command: command, question: nil, choices: nil, answer: "", isSubmitting: false, error: nil))
            case let .clarification(id, question, choices):
                next.requests.append(.init(id: id, kind: .clarification, command: nil, question: question, choices: choices, answer: "", isSubmitting: false, error: nil))
            }
            return next
        case let .answerChanged(id, answer):
            return update(state, id: id) { request in
                guard request.kind == .clarification else { return request }
                var next = request
                next.answer = answer
                next.error = nil
                return next
            }
        case let .submissionStarted(id):
            return update(state, id: id) { request in
                var next = request
                next.isSubmitting = true
                next.error = nil
                return next
            }
        case let .submissionSucceeded(id):
            var next = state
            next.requests.removeAll { $0.id == id }
            return next
        case let .submissionFailed(id, message):
            return update(state, id: id) { request in
                var next = request
                next.isSubmitting = false
                next.error = message
                return next
            }
        case .settle: return .initial
        }
    }

    private static func update(_ state: RailgunInteractionState, id: String, transform: (RailgunInteractionRequest) -> RailgunInteractionRequest) -> RailgunInteractionState {
        var next = state
        next.requests = state.requests.map { $0.id == id ? transform($0) : $0 }
        return next
    }
}

enum RailgunActivityStatus: Equatable { case running, success, error, interrupted }

enum RailgunActivityEntry: Equatable {
    case tool(
        id: String,
        name: String,
        status: RailgunActivityStatus,
        order: Int,
        input: String?,
        output: String?
    )
    case moaReference(id: String, index: Int, count: Int, model: String, status: RailgunActivityStatus, order: Int, preview: String?)
    case moaAggregation(id: String, model: String, referenceCount: Int, status: RailgunActivityStatus, order: Int)

    var status: RailgunActivityStatus {
        switch self {
        case let .tool(_, _, status, _, _, _), let .moaReference(_, _, _, _, status, _, _), let .moaAggregation(_, _, _, status, _): status
        }
    }

    var order: Int {
        switch self {
        case let .tool(_, _, _, order, _, _), let .moaReference(_, _, _, _, _, order, _), let .moaAggregation(_, _, _, _, order): order
        }
    }
}

struct RailgunSubagentActivity: Equatable {
    enum Status: Equatable { case running, completed, interrupted }
    let index: Int
    let count: Int
    var goal: String
    var status: Status
    var result: String?
}

struct RailgunAdvisorNote: Equatable { let severity: RailgunAdvisorSeverity; let text: String; let order: Int }

struct RailgunActivityState: Equatable {
    var entries: [RailgunActivityEntry]
    var todos: [RailgunTodo]
    var isLoadingTodos: Bool
    var subagents: [RailgunSubagentActivity]
    var advisorNotes: [RailgunAdvisorNote]

    static let initial = Self(entries: [], todos: [], isLoadingTodos: false, subagents: [], advisorNotes: [])
}

enum RailgunActivityAction: Equatable {
    case toolStarted(id: String, name: String, input: String?, order: Int = 0)
    case toolEnded(id: String, name: String, failed: Bool, output: String?, todos: [RailgunTodo]?)
    case moaReferenceStarted(index: Int, count: Int, model: String, order: Int = 0)
    case moaReferenceEnded(index: Int, model: String, preview: String)
    case moaAggregating(model: String, referenceCount: Int, order: Int = 0)
    case advisorNote(severity: RailgunAdvisorSeverity, text: String, order: Int = 0)
    case subagentStarted(goal: String, index: Int, count: Int, order: Int = 0)
    case subagentEnded(goal: String, index: Int, result: String)
    case aggregationCompleted
    case runStarted
    case settle

    func withOrder(_ order: Int) -> Self {
        switch self {
        case let .toolStarted(id, name, input, _): .toolStarted(id: id, name: name, input: input, order: order)
        case let .moaReferenceStarted(index, count, model, _): .moaReferenceStarted(index: index, count: count, model: model, order: order)
        case let .moaAggregating(model, referenceCount, _): .moaAggregating(model: model, referenceCount: referenceCount, order: order)
        case let .advisorNote(severity, text, _): .advisorNote(severity: severity, text: text, order: order)
        case let .subagentStarted(goal, index, count, _): .subagentStarted(goal: goal, index: index, count: count, order: order)
        default: self
        }
    }
}

enum RailgunActivityReducer {
    static func reduce(_ state: RailgunActivityState, _ action: RailgunActivityAction) -> RailgunActivityState {
        var next = state
        switch action {
        case let .toolStarted(id, name, input, order):
            guard !state.entries.contains(where: { isRunningTool($0, id: id, name: name) }) else { return state }
            next.entries.append(.tool(id: id, name: name, status: .running, order: order, input: input, output: nil))
            next.isLoadingTodos = state.isLoadingTodos || name == "todo"
        case let .toolEnded(id, name, failed, output, todos):
            guard let index = state.entries.firstIndex(where: { isRunningTool($0, id: id, name: name) }) else { return state }
            if name == "todo", !failed, let todos {
                next.entries.remove(at: index)
                next.todos = todos
                next.isLoadingTodos = hasRunningTodo(next.entries)
            } else if case let .tool(_, existingName, _, order, input, _) = state.entries[index] {
                next.entries[index] = .tool(
                    id: id,
                    name: existingName,
                    status: failed ? .error : .success,
                    order: order,
                    input: input,
                    output: output
                )
                next.isLoadingTodos = name == "todo" ? hasRunningTodo(next.entries) : state.isLoadingTodos
            }
        case let .moaReferenceStarted(index, count, model, order):
            next.entries.append(.moaReference(id: "moa-\(index)-\(model)-\(order)", index: index, count: count, model: model, status: .running, order: order, preview: nil))
        case let .moaReferenceEnded(index, model, preview):
            guard let entryIndex = state.entries.firstIndex(where: { isRunningReference($0, index: index, model: model) }),
                  case let .moaReference(id, _, count, _, _, order, _) = state.entries[entryIndex]
            else { return state }
            next.entries[entryIndex] = .moaReference(id: id, index: index, count: count, model: model, status: .success, order: order, preview: preview)
        case let .moaAggregating(model, referenceCount, order):
            next.entries.append(.moaAggregation(id: "moa-aggregation-\(order)", model: model, referenceCount: referenceCount, status: .running, order: order))
        case let .advisorNote(severity, text, order):
            next.advisorNotes.append(.init(severity: severity, text: text, order: order))
        case let .subagentStarted(goal, index, count, _):
            next.subagents.removeAll { $0.index == index }
            next.subagents.append(.init(index: index, count: count, goal: goal, status: .running, result: nil))
        case let .subagentEnded(goal, index, result):
            guard let index = state.subagents.firstIndex(where: { $0.index == index && $0.status == .running }) else { return state }
            next.subagents[index].goal = goal
            next.subagents[index].result = result
            next.subagents[index].status = .completed
        case .aggregationCompleted:
            next.entries = state.entries.map { entry in
                guard case let .moaAggregation(id, model, count, .running, order) = entry else { return entry }
                return .moaAggregation(id: id, model: model, referenceCount: count, status: .success, order: order)
            }
        case .runStarted:
            next.subagents = []
            next.advisorNotes = []
        case .settle:
            next.entries = state.entries.map(settle)
            next.subagents = state.subagents.map { item in
                guard item.status == .running else { return item }
                var copy = item
                copy.status = .interrupted
                return copy
            }
            next.isLoadingTodos = false
        }
        return next
    }

    static func hydrate(_ transcript: [RailgunRestoredTranscriptEntry], todos: [RailgunTodo]) -> RailgunActivityState {
        var entries: [RailgunActivityEntry] = []
        for (offset, item) in transcript.enumerated() {
            guard case let .tool(id, name, failed, target) = item else { continue }
            entries.append(.tool(id: id, name: name, status: failed ? .error : .success, order: offset + 1, input: target, output: nil))
        }
        return .init(entries: entries, todos: todos, isLoadingTodos: false, subagents: [], advisorNotes: [])
    }

    private static func isRunningTool(_ entry: RailgunActivityEntry, id: String, name: String) -> Bool {
        guard case let .tool(candidateID, candidateName, status, _, _, _) = entry else { return false }
        return candidateID == id && candidateName == name && status == .running
    }

    private static func isRunningReference(_ entry: RailgunActivityEntry, index: Int, model: String) -> Bool {
        guard case let .moaReference(_, candidateIndex, _, candidateModel, status, _, _) = entry else { return false }
        return candidateIndex == index && candidateModel == model && status == .running
    }

    private static func hasRunningTodo(_ entries: [RailgunActivityEntry]) -> Bool {
        entries.contains {
            guard case let .tool(_, name, status, _, _, _) = $0 else { return false }
            return name == "todo" && status == .running
        }
    }

    private static func settle(_ entry: RailgunActivityEntry) -> RailgunActivityEntry {
        switch entry {
        case let .tool(id, name, .running, order, input, output):
            .tool(id: id, name: name, status: .interrupted, order: order, input: input, output: output)
        case let .moaReference(id, index, count, model, .running, order, preview): .moaReference(id: id, index: index, count: count, model: model, status: .interrupted, order: order, preview: preview)
        case let .moaAggregation(id, model, count, .running, order): .moaAggregation(id: id, model: model, referenceCount: count, status: .interrupted, order: order)
        default: entry
        }
    }
}
