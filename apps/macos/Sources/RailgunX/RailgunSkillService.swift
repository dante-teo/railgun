import Foundation
import Observation
import RailgunTransport

enum RailgunSkillServiceError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidResponse
    case rejected(String)
}

/// Owns the skill RPC contract and validates every untrusted response before
/// it enters Settings state.
actor RailgunSkillService {
    typealias Request = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private static let timeout: Duration = .seconds(15)
    private static let maximumNameLength = RailgunRPCValidationLimits.skillName
    private static let maximumDescriptionLength = RailgunRPCValidationLimits.skillDescription
    private static let maximumBodyLength = RailgunRPCValidationLimits.skillBody
    private static let maximumSkills = 500

    private let request: Request

    init(request: @escaping Request) {
        self.request = request
    }

    init(rpcClient: RailgunRPCClient) {
        self.request = { command in
            try await rpcClient.request(command, timeout: Self.timeout)
        }
    }

    func list() async throws -> [RailgunSkillSummary] {
        let response = try await perform(.skillsList)
        guard let values = response.data?.objectValue?["skills"],
              case let .array(values) = values,
              values.count <= Self.maximumSkills
        else { throw RailgunSkillServiceError.invalidResponse }

        let skills = try values.map(parseSummary)
        guard Set(skills.map(\.name)).count == skills.count else {
            throw RailgunSkillServiceError.invalidResponse
        }
        return skills.sorted { $0.name < $1.name }
    }

    func get(name: String) async throws -> RailgunSkillDetail {
        try validateName(name)
        let response = try await perform(.skillGet, fields: ["name": .string(name)])
        guard let value = response.data?.objectValue?["skill"] else {
            throw RailgunSkillServiceError.invalidResponse
        }
        let detail = try parseDetail(value)
        guard detail.name == name else { throw RailgunSkillServiceError.invalidResponse }
        return detail
    }

    func create(
        name: String,
        description: String,
        body: String,
        isModelInvocationDisabled: Bool
    ) async throws -> RailgunSkillDetail {
        try validate(name: name, description: description, body: body)
        return try await mutate(
            .skillCreate,
            name: name,
            description: description,
            body: body,
            isModelInvocationDisabled: isModelInvocationDisabled
        )
    }

    func update(
        name: String,
        description: String,
        body: String,
        isModelInvocationDisabled: Bool
    ) async throws -> RailgunSkillDetail {
        try validate(name: name, description: description, body: body)
        return try await mutate(
            .skillUpdate,
            name: name,
            description: description,
            body: body,
            isModelInvocationDisabled: isModelInvocationDisabled
        )
    }

    func delete(name: String) async throws {
        try validateName(name)
        let response = try await perform(.skillDelete, fields: ["name": .string(name)])
        guard response.data == nil else { throw RailgunSkillServiceError.invalidResponse }
    }

    private func mutate(
        _ type: RailgunRPCCommandType,
        name: String,
        description: String,
        body: String,
        isModelInvocationDisabled: Bool
    ) async throws -> RailgunSkillDetail {
        let response = try await perform(type, fields: [
            "name": .string(name),
            "description": .string(description),
            "body": .string(body),
            "disableModelInvocation": .bool(isModelInvocationDisabled),
        ])
        guard let value = response.data?.objectValue?["skill"] else {
            throw RailgunSkillServiceError.invalidResponse
        }
        let detail = try parseDetail(value)
        guard detail.name == name else { throw RailgunSkillServiceError.invalidResponse }
        return detail
    }

    private func perform(
        _ type: RailgunRPCCommandType,
        fields: [String: RailgunJSONValue] = [:]
    ) async throws -> RailgunRPCResponse {
        let command: RailgunRPCCommand
        do {
            command = try RailgunRPCCommand(type: type, fields: fields)
        } catch {
            throw RailgunSkillServiceError.invalidRequest
        }

        let response: RailgunRPCResponse
        do {
            response = try await request(command)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw RailgunSkillServiceError.rejected("The skill request could not be completed.")
        }
        guard response.command == type.rawValue else {
            throw RailgunSkillServiceError.invalidResponse
        }
        guard response.success else {
            throw RailgunSkillServiceError.rejected(presentationMessage(response.error))
        }
        return response
    }

    private func parseSummary(_ value: RailgunJSONValue) throws -> RailgunSkillSummary {
        guard let object = value.objectValue,
              Set(object.keys) == Set(["name", "description", "disableModelInvocation"]),
              let name = object["name"]?.stringValue,
              validName(name),
              let description = object["description"]?.stringValue,
              validDescription(description),
              description.utf8.count <= Self.maximumDescriptionLength,
              let disabled = object["disableModelInvocation"]?.boolValue
        else { throw RailgunSkillServiceError.invalidResponse }
        return .init(name: name, description: description, isModelInvocationDisabled: disabled)
    }

    private func parseDetail(_ value: RailgunJSONValue) throws -> RailgunSkillDetail {
        guard let object = value.objectValue,
              Set(object.keys) == Set(["name", "description", "disableModelInvocation", "body"]),
              let summary = try? parseSummary(.object([
                  "name": object["name"] ?? .null,
                  "description": object["description"] ?? .null,
                  "disableModelInvocation": object["disableModelInvocation"] ?? .null,
              ])),
              let body = object["body"]?.stringValue,
              body.utf8.count <= Self.maximumBodyLength
        else { throw RailgunSkillServiceError.invalidResponse }
        return .init(
            name: summary.name,
            description: summary.description,
            body: body,
            isModelInvocationDisabled: summary.isModelInvocationDisabled
        )
    }

    private func validate(name: String, description: String, body: String) throws {
        try validateName(name)
        guard validDescription(description), description.utf8.count <= Self.maximumDescriptionLength else {
            throw RailgunSkillServiceError.invalidRequest
        }
        guard body.utf8.count <= Self.maximumBodyLength else {
            throw RailgunSkillServiceError.invalidRequest
        }
    }

    private func validateName(_ name: String) throws {
        guard validName(name) else { throw RailgunSkillServiceError.invalidRequest }
    }

    private func validName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= Self.maximumNameLength && name.allSatisfy {
            ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "-"
        }
    }

    private func validDescription(_ description: String) -> Bool {
        !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "The skill request was rejected." }
        return String(RailgunRPCRedactor.redact(text: message).prefix(240))
    }
}

@MainActor
@Observable
final class RailgunSkillsStore {
    private enum RetryRequest {
        case list
        case detail(String)
    }

    private let service: RailgunSkillService
    private var retryRequest: RetryRequest?
    private var detailLoadGeneration = 0

    private(set) var skills: [RailgunSkillSummary] = []
    private(set) var selectedSkill: RailgunSkillDetail?
    private(set) var isLoading = false
    private(set) var isLoadingDetail = false
    private(set) var isMutating = false
    private(set) var error: String?

    init(service: RailgunSkillService) {
        self.service = service
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        do {
            skills = try await service.list()
            retryRequest = nil
        } catch {
            self.error = presentationMessage(for: error)
            retryRequest = .list
        }
        isLoading = false
    }

    func loadDetail(name: String) async {
        detailLoadGeneration += 1
        let generation = detailLoadGeneration
        isLoadingDetail = true
        error = nil
        retryRequest = nil
        defer {
            if generation == detailLoadGeneration {
                isLoadingDetail = false
            }
        }
        do {
            let detail = try await service.get(name: name)
            guard generation == detailLoadGeneration, !Task.isCancelled else { return }
            selectedSkill = detail
            retryRequest = nil
        } catch {
            guard generation == detailLoadGeneration, !Task.isCancelled else { return }
            self.error = presentationMessage(for: error)
            selectedSkill = nil
            retryRequest = .detail(name)
        }
    }

    func clearSelection() {
        detailLoadGeneration += 1
        isLoadingDetail = false
        selectedSkill = nil
        if case .some(.detail(_)) = retryRequest {
            retryRequest = nil
            error = nil
        }
    }

    func retry() async {
        switch retryRequest {
        case let .some(.detail(name)):
            await loadDetail(name: name)
        case .some(.list), .none:
            await load()
        }
    }

    func create(
        name: String,
        description: String,
        body: String,
        isModelInvocationDisabled: Bool
    ) async -> Bool {
        guard !isMutating else { return false }
        isMutating = true
        error = nil
        retryRequest = nil
        do {
            selectedSkill = try await service.create(
                name: name,
                description: description,
                body: body,
                isModelInvocationDisabled: isModelInvocationDisabled
            )
        } catch {
            self.error = presentationMessage(for: error)
            isMutating = false
            return false
        }
        await refreshAfterMutation(successMessage: "The skill was created, but the list could not be refreshed.")
        isMutating = false
        return true
    }

    func update(
        name: String,
        description: String,
        body: String,
        isModelInvocationDisabled: Bool
    ) async -> Bool {
        guard !isMutating else { return false }
        isMutating = true
        error = nil
        retryRequest = nil
        do {
            selectedSkill = try await service.update(
                name: name,
                description: description,
                body: body,
                isModelInvocationDisabled: isModelInvocationDisabled
            )
        } catch {
            self.error = presentationMessage(for: error)
            isMutating = false
            return false
        }
        await refreshAfterMutation(successMessage: "The skill was saved, but the list could not be refreshed.")
        isMutating = false
        return true
    }

    func delete(name: String) async -> Bool {
        guard !isMutating else { return false }
        isMutating = true
        error = nil
        retryRequest = nil
        do {
            try await service.delete(name: name)
        } catch {
            self.error = presentationMessage(for: error)
            isMutating = false
            return false
        }
        if selectedSkill?.name == name { selectedSkill = nil }
        await refreshAfterMutation(successMessage: "The skill was deleted, but the list could not be refreshed.")
        isMutating = false
        return true
    }

    private func refreshAfterMutation(successMessage: String) async {
        do {
            skills = try await service.list()
            retryRequest = nil
        } catch {
            self.error = successMessage
            retryRequest = .list
        }
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunSkillServiceError.invalidRequest:
            "Use a lowercase skill name (letters, numbers, and hyphens), a description, and a body within the allowed limits."
        case RailgunSkillServiceError.invalidResponse:
            "The backend returned an invalid skill response."
        case let RailgunSkillServiceError.rejected(message):
            String(RailgunRPCRedactor.redact(text: message).prefix(240))
        default:
            "The skill request could not be completed."
        }
    }
}
