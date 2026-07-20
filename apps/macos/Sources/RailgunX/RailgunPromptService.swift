import Foundation
import RailgunTransport

/// Presentation-safe failures for task prompt and queue requests.
enum RailgunPromptServiceError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidResponse
    case rejected(String)
}

/// Sends the v1 task-submission commands and validates their empty acknowledgements.
actor RailgunPromptService {
    typealias Request = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private static let queueAcknowledgementTimeout: Duration = .seconds(15)
    private static let maximumMessageLength = 100_000

    private let request: Request

    init(request: @escaping Request) {
        self.request = request
    }

    init(rpcClient: RailgunRPCClient) {
        self.init { command in
            let timeout: Duration? = command.type == .prompt ? nil : Self.queueAcknowledgementTimeout
            return try await rpcClient.request(command, timeout: timeout)
        }
    }

    func prompt(_ message: String) async throws {
        try await perform(.prompt, message: message)
    }

    func steer(_ message: String) async throws {
        try await perform(.steer, message: message)
    }

    func followUp(_ message: String) async throws {
        try await perform(.followUp, message: message)
    }

    private func perform(_ type: RailgunRPCCommandType, message: String) async throws {
        guard isValid(message) else { throw RailgunPromptServiceError.invalidRequest }

        let command: RailgunRPCCommand
        do {
            command = try RailgunRPCCommand(type: type, fields: ["message": .string(message)])
        } catch {
            throw RailgunPromptServiceError.invalidRequest
        }

        let response: RailgunRPCResponse
        do {
            response = try await request(command)
        } catch {
            throw RailgunPromptServiceError.rejected("The task request could not be completed.")
        }

        guard response.command == type.rawValue else {
            throw RailgunPromptServiceError.invalidResponse
        }
        guard response.success else {
            throw RailgunPromptServiceError.rejected(presentationMessage(response.error))
        }
        guard response.data == nil else {
            throw RailgunPromptServiceError.invalidResponse
        }
    }

    private func isValid(_ message: String) -> Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && message.count <= Self.maximumMessageLength
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "The task request was rejected." }
        return String(RailgunRPCRedactor.redact(text: message).prefix(240))
    }
}

/// Bridges composer intent to RPC effects while keeping presentation state in the store.
@MainActor
final class RailgunPromptCoordinator {
    private let store: RailgunAppStore
    private let service: RailgunPromptService

    init(store: RailgunAppStore, service: RailgunPromptService) {
        self.store = store
        self.service = service
    }

    func submit(_ message: String) async -> Bool {
        guard !store.state.transcript.isRunning else {
            return await enqueue(message, kind: .steering)
        }

        let request = RailgunRunRequest(userID: nextID(prefix: "prompt"), text: message)
        store.send(.transcript(.submit(id: request.userID, text: request.text, at: nil)))
        observePromptAcknowledgement(userID: request.userID, text: request.text)
        return true
    }

    func enqueue(_ message: String, kind: RailgunQueueKind) async -> Bool {
        guard store.state.transcript.isRunning, !store.state.transcript.isStopping else { return false }
        do {
            switch kind {
            case .steering:
                try await service.steer(message)
            case .followUp:
                try await service.followUp(message)
            }
            store.send(.transcript(.queueAccepted(id: nextID(prefix: "queue"), kind: kind, text: message)))
            return true
        } catch {
            store.send(.transcript(.queueRejected(
                kind: kind,
                text: message,
                message: presentationMessage(for: error)
            )))
            return false
        }
    }

    func retry() async -> Bool {
        guard let failedRun = store.state.transcript.failedRun else { return false }
        store.send(.transcript(.retry))
        observePromptAcknowledgement(userID: failedRun.userID, text: failedRun.text)
        return true
    }

    func retryQueue() async -> Bool {
        guard let failedQueue = store.state.transcript.failedQueue else { return false }
        return await enqueue(failedQueue.text, kind: failedQueue.kind)
    }

    private func observePromptAcknowledgement(userID: String, text: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await service.prompt(text)
            } catch {
                guard store.state.transcript.activeRun?.userID == userID else { return }
                store.send(.transcript(.requestFailed(
                    userID: userID,
                    text: text,
                    message: presentationMessage(for: error)
                )))
            }
        }
    }

    private func nextID(prefix: String) -> String {
        "\(prefix)-\(UUID().uuidString)"
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunPromptServiceError.invalidRequest:
            "Enter a message before submitting."
        case RailgunPromptServiceError.invalidResponse:
            "The backend returned an invalid task acknowledgement."
        case let RailgunPromptServiceError.rejected(message):
            message
        default:
            "The task request could not be completed."
        }
    }
}
