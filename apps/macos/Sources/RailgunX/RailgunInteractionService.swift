import Foundation
import RailgunTransport

/// Presentation-safe failures for approval and clarification responses.
enum RailgunInteractionServiceError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidResponse
    case rejected(String)
}

/// Resolves backend interactions without exposing transport errors to feature
/// state. Correlation and response validation remain transport responsibilities.
actor RailgunInteractionService {
    typealias ApprovalResponder = @Sendable (String, Bool) async throws -> Void
    typealias ClarificationResponder = @Sendable (String, String) async throws -> Void

    private let approvalResponder: ApprovalResponder
    private let clarificationResponder: ClarificationResponder

    init(
        approvalResponder: @escaping ApprovalResponder,
        clarificationResponder: @escaping ClarificationResponder
    ) {
        self.approvalResponder = approvalResponder
        self.clarificationResponder = clarificationResponder
    }

    init(rpcClient: RailgunRPCClient) {
        self.init(
            approvalResponder: { id, approved in
                try await rpcClient.respondToApproval(id: id, approved: approved)
            },
            clarificationResponder: { id, answer in
                try await rpcClient.respondToClarification(id: id, answer: answer)
            }
        )
    }

    func respondToApproval(id: String, approved: Bool) async throws {
        guard isValidCorrelationID(id) else { throw RailgunInteractionServiceError.invalidRequest }
        do {
            try await approvalResponder(id, approved)
        } catch {
            throw presentationError(for: error)
        }
    }

    func respondToClarification(id: String, answer: String) async throws {
        guard isValidCorrelationID(id), (try? RailgunRPCInteractionRequest.validateClarificationAnswer(answer)) != nil
        else { throw RailgunInteractionServiceError.invalidRequest }
        do {
            try await clarificationResponder(id, answer)
        } catch {
            throw presentationError(for: error)
        }
    }

    private func isValidCorrelationID(_ id: String) -> Bool {
        !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func presentationError(for error: Error) -> RailgunInteractionServiceError {
        if let error = error as? RailgunInteractionServiceError { return error }
        if let error = error as? RailgunRPCError {
            switch error {
            case .invalidInteractionResponse, .unknownInteraction, .mismatchedInteractionKind, .interactionResponseInFlight:
                return .invalidResponse
            default:
                break
            }
        }
        return .rejected("The interaction response could not be completed.")
    }
}

/// Bridges native approval and clarification controls to RPC effects while the
/// store remains the single source of presentation state.
@MainActor
final class RailgunInteractionCoordinator {
    private let store: RailgunAppStore
    private let service: RailgunInteractionService

    init(store: RailgunAppStore, service: RailgunInteractionService) {
        self.store = store
        self.service = service
    }

    func respondToApproval(id: String, approved: Bool) async {
        await respond(id: id, kind: .approval) {
            try await self.service.respondToApproval(id: id, approved: approved)
        }
    }

    func respondToClarification(id: String, answer: String) async {
        await respond(id: id, kind: .clarification) {
            try await self.service.respondToClarification(id: id, answer: answer)
        }
    }

    private func respond(
        id: String,
        kind: RailgunInteractionKind,
        effect: @escaping () async throws -> Void
    ) async {
        guard let request = store.state.interactions.requests.first(where: { $0.id == id }),
              request.kind == kind,
              !request.isSubmitting
        else { return }

        store.send(.interaction(.submissionStarted(id: id)))
        do {
            try await effect()
            store.send(.interaction(.submissionSucceeded(id: id)))
        } catch {
            store.send(.interaction(.submissionFailed(id: id, message: presentationMessage(for: error))))
        }
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunInteractionServiceError.invalidRequest:
            "Enter a valid response before submitting."
        case RailgunInteractionServiceError.invalidResponse:
            "The backend returned an invalid interaction acknowledgement."
        case let RailgunInteractionServiceError.rejected(message):
            message
        default:
            "The interaction response could not be completed."
        }
    }
}
