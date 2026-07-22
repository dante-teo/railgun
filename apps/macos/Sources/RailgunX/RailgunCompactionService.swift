import Foundation
import RailgunTransport

enum RailgunCompactionServiceError: Error, Equatable, Sendable {
    case invalidResponse
    case rejected(String)
}

/// Owns the manual-compaction RPC contract. Compaction can legitimately take
/// longer than ordinary control mutations, so it deliberately has no client timeout.
actor RailgunCompactionService {
    typealias Request = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private let request: Request

    init(request: @escaping Request) {
        self.request = request
    }

    init(rpcClient: RailgunRPCClient) {
        self.init { command in
            try await rpcClient.request(command, timeout: nil)
        }
    }

    func compact() async throws {
        let command = try RailgunRPCCommand(type: .compact)
        let response: RailgunRPCResponse
        do {
            response = try await request(command)
        } catch {
            throw RailgunCompactionServiceError.rejected("Context compaction could not be completed.")
        }

        guard response.command == RailgunRPCCommandType.compact.rawValue else {
            throw RailgunCompactionServiceError.invalidResponse
        }
        guard response.success else {
            throw RailgunCompactionServiceError.rejected(presentationMessage(response.error))
        }
        guard response.data == nil else {
            throw RailgunCompactionServiceError.invalidResponse
        }
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "Context compaction was rejected." }
        return String(RailgunRPCRedactor.redact(text: message).prefix(240))
    }
}

@MainActor
final class RailgunCompactionCoordinator {
    private let store: RailgunAppStore
    private let service: RailgunCompactionService

    init(store: RailgunAppStore, service: RailgunCompactionService) {
        self.store = store
        self.service = service
    }

    func compact() async {
        guard canCompact else { return }
        store.send(.controls(.compactionStarted))
        do {
            try await service.compact()
            store.send(.controls(.compactionFinished))
        } catch {
            store.send(.controls(.compactionFailed(presentationMessage(for: error))))
        }
    }

    private var canCompact: Bool {
        store.state.controls.isReadyForMutation
            && !store.state.transcript.isRunning
            && !store.state.transcript.messages.isEmpty
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunCompactionServiceError.invalidResponse:
            "The backend returned an invalid compaction response."
        case let RailgunCompactionServiceError.rejected(message):
            message
        default:
            "Context compaction could not be completed."
        }
    }
}
