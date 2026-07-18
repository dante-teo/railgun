import Foundation
import RailgunTransport

/// Presentation-safe failures for session management requests.
enum RailgunSessionServiceError: Error, Equatable, Sendable {
    case invalidResponse
    case rejected(String)
}

/// Owns session-management RPC effects. Reducers only receive its validated
/// results, keeping backend response handling out of feature state.
actor RailgunSessionService {
    typealias Request = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private static let timeout: Duration = .seconds(15)
    private static let maximumSessions = 500
    private static let maximumTextLength = 4_000

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

    func resume(_ sessionID: String) async throws {
        let fields: [String: RailgunJSONValue] = [
            "sessionId": .string(sessionID),
            "includeMessages": .bool(false),
        ]
        let loadedID = try await requestSessionID(
            from: RailgunRPCCommandType.sessionLoad,
            fields: fields
        )
        guard loadedID == sessionID else { throw RailgunSessionServiceError.invalidResponse }
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
              text.count <= Self.maximumTextLength,
              allowsEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return text
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "The task request was rejected." }
        let redacted = RailgunRPCRedactor.redact(text: message)
        return String(redacted.prefix(240))
    }
}

/// Bridges user intent to session effects and dispatches only reducer actions.
@MainActor
final class RailgunSessionCoordinator {
    private let store: RailgunAppStore
    private let service: RailgunSessionService

    init(store: RailgunAppStore, service: RailgunSessionService) {
        self.store = store
        self.service = service
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
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    func resume(_ sessionID: String) async {
        do {
            try await service.resume(sessionID)
            store.send(.session(.hydrated(activeSessionID: sessionID, transcript: [], todos: [], isRunning: false)))
        } catch {
            store.send(.session(.failed(message: presentationMessage(for: error))))
        }
    }

    func archive(_ sessionID: String) async {
        let model = store.state.session.selectedSession?.model
        do {
            let freshSessionID = try await service.archive(sessionID)
            activateNewSession(id: freshSessionID, model: model)
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
