import Foundation
import RailgunTransport

/// Presentation-safe failures for session management requests.
enum RailgunSessionServiceError: Error, Equatable, Sendable {
    case invalidResponse
    case rejected(String)
}

struct RailgunRestoredSession: Equatable, Sendable {
    let id: String
    let transcript: [RailgunRestoredTranscriptEntry]
    let todos: [RailgunTodo]
    let isRunning: Bool
}

/// Owns session-management RPC effects. Reducers only receive its validated
/// results, keeping backend response handling out of feature state.
actor RailgunSessionService {
    typealias Request = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private static let timeout: Duration = .seconds(15)
    private static let maximumSessions = 500
    private static let maximumSummaryTextLength = 4_000
    private static let maximumTranscriptEntries = 2_000
    private static let maximumTranscriptPageEntries = 100
    private static let maximumTranscriptTextLength = 100_000
    private static let maximumToolNameLength = 128
    private static let maximumToolTargetLength = 256
    private static let maximumTodos = 256
    private static let maximumTodoTextLength = 2_000
    private static let maximumSafeInteger = 9_007_199_254_740_991

    private let request: Request

    init(request: @escaping Request) {
        self.request = request
    }

    init(rpcClient: RailgunRPCClient) {
        self.init { command in
            try await rpcClient.request(command, timeout: Self.timeout)
        }
    }

    func listSessions() async throws -> [RailgunSessionSummary] {
        try await list(.sessionList)
    }

    func listArchivedSessions() async throws -> [RailgunSessionSummary] {
        try await list(.sessionListArchived)
    }

    func create(modelID: String?) async throws -> String {
        let fields: [String: RailgunJSONValue] = modelID.map { ["modelId": .string($0)] } ?? [:]
        return try await requestSessionID(from: RailgunRPCCommandType.sessionNew, fields: fields)
    }

    func resume(_ sessionID: String) async throws -> RailgunRestoredSession {
        let fields: [String: RailgunJSONValue] = [
            "sessionId": .string(sessionID),
            "includeMessages": .bool(false),
        ]
        let loadedID = try await requestSessionID(
            from: RailgunRPCCommandType.sessionLoad,
            fields: fields
        )
        guard loadedID == sessionID else { throw RailgunSessionServiceError.invalidResponse }
        let state = try await restoredState(expectedSessionID: sessionID)
        let transcript = try await transcript(for: sessionID)
        return .init(id: sessionID, transcript: transcript, todos: state.todos, isRunning: state.isRunning)
    }

    /// Rehydrates the task currently active in the backend. Model changes can
    /// fork a persisted task, so callers must not assume the prior session ID
    /// is still active after `set_model` succeeds.
    func activeSession() async throws -> RailgunRestoredSession {
        let state = try await currentState()
        let transcript = try await transcript(for: state.id)
        return .init(id: state.id, transcript: transcript, todos: state.todos, isRunning: state.isRunning)
    }

    func archive(_ sessionID: String) async throws -> String {
        let fields: [String: RailgunJSONValue] = ["sessionId": .string(sessionID)]
        return try await requestSessionID(from: RailgunRPCCommandType.sessionArchive, fields: fields)
    }

    func restore(_ sessionID: String) async throws {
        let fields: [String: RailgunJSONValue] = ["sessionId": .string(sessionID)]
        _ = try await requestSessionID(from: RailgunRPCCommandType.sessionUnarchive, fields: fields)
    }

    private func list(_ type: RailgunRPCCommandType) async throws -> [RailgunSessionSummary] {
        let response = try await perform(type)
        guard let sessions = response.data?.objectValue?["sessions"], case let .array(values) = sessions,
              values.count <= Self.maximumSessions
        else { throw RailgunSessionServiceError.invalidResponse }
        return try values.map(parseSummary)
    }

    private func requestSessionID(
        from type: RailgunRPCCommandType,
        fields: [String: RailgunJSONValue]
    ) async throws -> String {
        let response = try await perform(type, fields: fields)
        guard let identifier = response.data?.objectValue?["sessionId"]?.stringValue,
              isValidIdentifier(identifier)
        else { throw RailgunSessionServiceError.invalidResponse }
        return identifier
    }

    private func perform(
        _ type: RailgunRPCCommandType,
        fields: [String: RailgunJSONValue] = [:]
    ) async throws -> RailgunRPCResponse {
        let command = try RailgunRPCCommand(type: type, fields: fields)
        let response: RailgunRPCResponse
        do {
            response = try await request(command)
        } catch {
            throw RailgunSessionServiceError.rejected("The task request could not be completed.")
        }
        guard response.command == type.rawValue else { throw RailgunSessionServiceError.invalidResponse }
        guard response.success else {
            throw RailgunSessionServiceError.rejected(presentationMessage(response.error))
        }
        return response
    }

    private func parseSummary(_ value: RailgunJSONValue) throws -> RailgunSessionSummary {
        guard let object = value.objectValue,
              let id = object["id"]?.stringValue, isValidIdentifier(id),
              let model = validText(object["model"]),
              let startedAt = validText(object["startedAtLocal"]),
              let messageCount = object["messageCount"]?.integerValue, messageCount >= 0,
              let firstUserPreview = validText(object["firstUserPreview"], allowsEmpty: true)
        else { throw RailgunSessionServiceError.invalidResponse }
        return .init(id: id, model: model, startedAt: startedAt, messageCount: messageCount, firstUserPreview: firstUserPreview)
    }

    private func isValidIdentifier(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.count <= 256
    }

    private func validText(_ value: RailgunJSONValue?, allowsEmpty: Bool = false) -> String? {
        guard let text = value?.stringValue,
              text.count <= Self.maximumSummaryTextLength,
              allowsEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return text
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "The task request was rejected." }
        let redacted = RailgunRPCRedactor.redact(text: message)
        return String(redacted.prefix(240))
    }

    private func restoredState(expectedSessionID: String) async throws -> (todos: [RailgunTodo], isRunning: Bool) {
        let state = try await currentState()
        guard state.id == expectedSessionID else { throw RailgunSessionServiceError.invalidResponse }
        return (state.todos, state.isRunning)
    }

    private func currentState() async throws -> (id: String, todos: [RailgunTodo], isRunning: Bool) {
        let response = try await perform(.getState)
        guard let object = response.data?.objectValue,
              let sessionID = object["sessionId"]?.stringValue,
              isValidIdentifier(sessionID),
              let isRunning = object["running"]?.boolValue,
              let todoValue = object["todos"],
              case let .array(todoValues) = todoValue,
              todoValues.count <= Self.maximumTodos
        else { throw RailgunSessionServiceError.invalidResponse }
        return (sessionID, try todoValues.map(parseTodo), isRunning)
    }

    private func transcript(for sessionID: String) async throws -> [RailgunRestoredTranscriptEntry] {
        var entries: [RailgunRestoredTranscriptEntry] = []
        var cursor = 0

        while entries.count < Self.maximumTranscriptEntries {
            let response = try await perform(.sessionTranscript, fields: [
                "sessionId": .string(sessionID),
                "cursor": .number(Double(cursor)),
                "limit": .number(Double(Self.maximumTranscriptPageEntries)),
            ])
            guard let object = response.data?.objectValue,
                  object["sessionId"]?.stringValue == sessionID,
                  let messageValue = object["messages"],
                  case let .array(values) = messageValue,
                  values.count <= Self.maximumTranscriptPageEntries
            else { throw RailgunSessionServiceError.invalidResponse }

            let page = try values.map(parseTranscriptEntry)
            guard entries.count + page.count <= Self.maximumTranscriptEntries else {
                throw RailgunSessionServiceError.invalidResponse
            }
            entries.append(contentsOf: page)

            guard let nextCursor = object["nextCursor"] else { return entries }
            guard !page.isEmpty else { throw RailgunSessionServiceError.invalidResponse }
            guard let next = safeNonNegativeInteger(nextCursor), next > cursor else {
                throw RailgunSessionServiceError.invalidResponse
            }
            cursor = next
        }
        throw RailgunSessionServiceError.invalidResponse
    }

    private func parseTranscriptEntry(_ value: RailgunJSONValue) throws -> RailgunRestoredTranscriptEntry {
        guard let object = value.objectValue, let role = object["role"]?.stringValue else {
            throw RailgunSessionServiceError.invalidResponse
        }
        switch role {
        case "user", "assistant":
            let messageID = try optionalPositiveInteger(object["messageId"])
            let startedAt = try optionalTimestamp(object["startedAt"])
            let completedAt = try optionalTimestamp(object["completedAt"])
            let branchable = try optionalBranchable(object["branchable"])
            guard let text = object["text"]?.stringValue,
                  !text.isEmpty,
                  text.count <= Self.maximumTranscriptTextLength,
                  !(role == "user" && completedAt != nil),
                  !(role == "assistant" && startedAt != nil),
                  !(branchable && (role != "assistant" || messageID == nil))
            else { throw RailgunSessionServiceError.invalidResponse }
            return .message(
                role: role == "user" ? .user : .assistant,
                text: text,
                messageID: messageID,
                branchable: branchable,
                startedAt: startedAt,
                completedAt: completedAt
            )
        case "tool":
            let target = try optionalText(object["target"], maximumLength: Self.maximumToolTargetLength)
            guard let id = object["id"]?.stringValue, isValidIdentifier(id),
                  let name = object["name"]?.stringValue,
                  !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  name.count <= Self.maximumToolNameLength,
                  let failed = object["failed"]?.boolValue
            else { throw RailgunSessionServiceError.invalidResponse }
            return .tool(id: id, name: name, failed: failed, target: target)
        default:
            throw RailgunSessionServiceError.invalidResponse
        }
    }

    private func parseTodo(_ value: RailgunJSONValue) throws -> RailgunTodo {
        guard let object = value.objectValue,
              let id = object["id"]?.stringValue, isValidIdentifier(id),
              let content = object["content"]?.stringValue,
              !content.isEmpty, content.count <= Self.maximumTodoTextLength,
              let rawStatus = object["status"]?.stringValue,
              let status = RailgunTodoStatus(rawValue: rawStatus)
        else { throw RailgunSessionServiceError.invalidResponse }
        return .init(id: id, content: content, status: status)
    }

    private func optionalPositiveInteger(_ value: RailgunJSONValue?) throws -> Int? {
        guard let value else { return nil }
        guard let integer = value.integerValue, integer > 0, integer <= Self.maximumSafeInteger else {
            throw RailgunSessionServiceError.invalidResponse
        }
        return integer
    }

    private func optionalTimestamp(_ value: RailgunJSONValue?) throws -> Int? {
        guard let value else { return nil }
        guard let integer = safeNonNegativeInteger(value) else {
            throw RailgunSessionServiceError.invalidResponse
        }
        return integer
    }

    private func optionalBranchable(_ value: RailgunJSONValue?) throws -> Bool {
        guard let value else { return false }
        guard value == .bool(true) else { throw RailgunSessionServiceError.invalidResponse }
        return true
    }

    private func optionalText(_ value: RailgunJSONValue?, maximumLength: Int) throws -> String? {
        guard let value else { return nil }
        guard let text = value.stringValue,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.count <= maximumLength
        else { throw RailgunSessionServiceError.invalidResponse }
        return text
    }

    private func safeNonNegativeInteger(_ value: RailgunJSONValue) -> Int? {
        guard let integer = value.integerValue,
              integer >= 0,
              integer <= Self.maximumSafeInteger
        else { return nil }
        return integer
    }
}

/// Bridges user intent to session effects and dispatches only reducer actions.
@MainActor
final class RailgunSessionCoordinator {
    private let store: RailgunAppStore
    private let service: RailgunSessionService
    private let controlsDidActivate: (@MainActor () async -> Void)?

    init(
        store: RailgunAppStore,
        service: RailgunSessionService,
        controlsDidActivate: (@MainActor () async -> Void)? = nil
    ) {
        self.store = store
        self.service = service
        self.controlsDidActivate = controlsDidActivate
    }

    func refresh() async {
        store.send(.session(.loading))
        do {
            async let sessions = service.listSessions()
            async let archived = service.listArchivedSessions()
            let (active, inactive) = try await (sessions, archived)
            store.send(.session(.loaded(active)))
            store.send(.session(.archivedLoaded(inactive)))
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    func create(modelID: String? = nil) async {
        do {
            let sessionID = try await service.create(modelID: modelID)
            activateNewSession(id: sessionID, model: modelID)
            await controlsDidActivate?()
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    func resume(_ sessionID: String) async {
        do {
            let restored = try await service.resume(sessionID)
            store.send(.session(.hydrated(
                activeSessionID: restored.id,
                transcript: restored.transcript,
                todos: restored.todos,
                isRunning: restored.isRunning
            )))
            await controlsDidActivate?()
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    func refreshAfterModelChange(modelID: String) async {
        do {
            let restored = try await service.activeSession()
            activateNewSession(id: restored.id, model: modelID)
            store.send(.session(.hydrated(
                activeSessionID: restored.id,
                transcript: restored.transcript,
                todos: restored.todos,
                isRunning: restored.isRunning
            )))
            await refresh()
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    func archive(_ sessionID: String) async {
        let model = store.state.session.selectedSession?.model
        do {
            let freshSessionID = try await service.archive(sessionID)
            activateNewSession(id: freshSessionID, model: model)
            await controlsDidActivate?()
            await refresh()
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    func restore(_ sessionID: String) async {
        do {
            try await service.restore(sessionID)
            await refresh()
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    private func activateNewSession(id: String, model: String?) {
        store.send(.session(.created(id: id, model: model)))
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunSessionServiceError.invalidResponse:
            "The backend returned invalid task data."
        case let RailgunSessionServiceError.rejected(message):
            message
        default:
            "The task request could not be completed."
        }
    }
}
