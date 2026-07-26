import Foundation
import Observation
import RailgunTransport

struct RailgunAgentMemory: Identifiable, Equatable, Sendable {
    let id: String
    let content: String
    let category: String
    let createdAt: Date
}

struct RailgunInstructionFile: Equatable, Sendable {
    let label: String
    let content: String
}

enum RailgunDreamStatus: String, Equatable, Sendable {
    case completed
    case skipped
}

struct RailgunDreamSummary: Equatable, Sendable {
    let status: RailgunDreamStatus
    let beforeCount: Int
    let afterCount: Int
}

enum RailgunPersonalizationServiceError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidResponse
    case rejected(String)
}

/// Owns the memory and instruction-file RPC contracts used by Personalization.
actor RailgunPersonalizationService {
    typealias Request = @Sendable (RailgunRPCCommand, Duration?) async throws -> RailgunRPCResponse
    typealias TimedRequest = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private static let timeout: Duration = .seconds(15)
    private static let maximumMemories = 100
    private static let maximumMemoryIDLength = 256
    private static let maximumMemoryContentLength = 100_000
    private static let maximumMemoryCategoryLength = 100
    private static let maximumInstructionLabelLength = 100
    private static let maximumInstructionContentLength = 1_000_000
    private static let maximumSearchLength = 10_000
    static let customInstructionID = "railgun-dotfile"
    private static let instructionStatuses: Set<String> = ["missing", "active", "shadowed"]

    private let request: Request

    init(request: @escaping TimedRequest) {
        self.request = { command, _ in try await request(command) }
    }

    init(request: @escaping Request) {
        self.request = request
    }

    init(rpcClient: RailgunRPCClient) {
        self.request = { command, timeout in
            try await rpcClient.request(command, timeout: timeout)
        }
    }

    func listMemories(query: String? = nil) async throws -> [RailgunAgentMemory] {
        let normalizedQuery = query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !normalizedQuery.isEmpty, normalizedQuery.count > Self.maximumSearchLength {
            throw RailgunPersonalizationServiceError.invalidRequest
        }
        let response = try await perform(
            normalizedQuery.isEmpty ? .memoryList : .memorySearch,
            fields: normalizedQuery.isEmpty
                ? ["limit": .number(Double(Self.maximumMemories))]
                : ["query": .string(normalizedQuery), "limit": .number(Double(Self.maximumMemories))]
        )
        guard let memories = response.data?.objectValue?["memories"], case let .array(values) = memories,
              values.count <= Self.maximumMemories
        else { throw RailgunPersonalizationServiceError.invalidResponse }
        let parsed = try values.map(parseMemory)
        guard Set(parsed.map(\.id)).count == parsed.count else {
            throw RailgunPersonalizationServiceError.invalidResponse
        }
        return parsed
    }

    func createMemory(content: String, category: String) async throws -> RailgunAgentMemory {
        let mutation = try validatedMemoryMutation(content: content, category: category)
        let response = try await perform(.memoryCreate, fields: mutation)
        guard let memory = response.data?.objectValue?["memory"] else {
            throw RailgunPersonalizationServiceError.invalidResponse
        }
        return try parseMemory(memory)
    }

    func updateMemory(id: String, content: String, category: String) async throws -> RailgunAgentMemory {
        guard validMemoryID(id) else { throw RailgunPersonalizationServiceError.invalidRequest }
        let mutation = try validatedMemoryMutation(content: content, category: category)
        let response = try await perform(.memoryUpdate, fields: [
            "memoryId": .string(id), "patch": .object(mutation),
        ])
        guard let memory = response.data?.objectValue?["memory"] else {
            throw RailgunPersonalizationServiceError.invalidResponse
        }
        let updated = try parseMemory(memory)
        guard updated.id == id else { throw RailgunPersonalizationServiceError.invalidResponse }
        return updated
    }

    func deleteMemory(id: String) async throws {
        guard validMemoryID(id) else { throw RailgunPersonalizationServiceError.invalidRequest }
        let response = try await perform(.memoryDelete, fields: ["memoryId": .string(id)])
        guard response.data == nil else { throw RailgunPersonalizationServiceError.invalidResponse }
    }

    func runDream() async throws -> RailgunDreamSummary {
        // Dream can run a multi-step agent workflow, so it must not inherit the
        // normal interactive RPC timeout.
        let response = try await perform(.dreamRun, timeout: nil)
        guard let object = response.data?.objectValue,
              Set(object.keys) == Set(["status", "beforeCount", "afterCount"]),
              let rawStatus = object["status"]?.stringValue, let status = RailgunDreamStatus(rawValue: rawStatus),
              let beforeCount = nonNegativeInteger(object["beforeCount"]),
              let afterCount = nonNegativeInteger(object["afterCount"])
        else { throw RailgunPersonalizationServiceError.invalidResponse }
        return .init(status: status, beforeCount: beforeCount, afterCount: afterCount)
    }

    func customInstruction() async throws -> RailgunInstructionFile {
        let response = try await perform(.instructionFileGet, fields: ["fileId": .string(Self.customInstructionID)])
        guard let file = response.data?.objectValue?["file"] else {
            throw RailgunPersonalizationServiceError.invalidResponse
        }
        return try parseInstructionFile(file)
    }

    func updateCustomInstruction(content: String) async throws -> RailgunInstructionFile {
        guard content.count <= Self.maximumInstructionContentLength else {
            throw RailgunPersonalizationServiceError.invalidRequest
        }
        let response = try await perform(.instructionFileUpdate, fields: ["fileId": .string(Self.customInstructionID), "content": .string(content)])
        guard let file = response.data?.objectValue?["file"] else {
            throw RailgunPersonalizationServiceError.invalidResponse
        }
        return try parseInstructionFile(file)
    }

    private func validatedMemoryMutation(content: String, category: String) throws -> [String: RailgunJSONValue] {
        let content = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let category = category.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, content.count <= Self.maximumMemoryContentLength,
              !category.isEmpty, category.count <= Self.maximumMemoryCategoryLength
        else { throw RailgunPersonalizationServiceError.invalidRequest }
        return ["content": .string(content), "category": .string(category)]
    }

    private func perform(
        _ type: RailgunRPCCommandType,
        fields: [String: RailgunJSONValue] = [:],
        timeout: Duration? = RailgunPersonalizationService.timeout
    ) async throws -> RailgunRPCResponse {
        let command: RailgunRPCCommand
        do {
            command = try RailgunRPCCommand(type: type, fields: fields)
        } catch {
            throw RailgunPersonalizationServiceError.invalidRequest
        }
        let response: RailgunRPCResponse
        do {
            response = try await request(command, timeout)
        } catch {
            throw RailgunPersonalizationServiceError.rejected("The personalization request could not be completed.")
        }
        guard response.command == type.rawValue else { throw RailgunPersonalizationServiceError.invalidResponse }
        guard response.success else { throw RailgunPersonalizationServiceError.rejected(presentationMessage(response.error)) }
        return response
    }

    private func parseMemory(_ value: RailgunJSONValue) throws -> RailgunAgentMemory {
        guard let object = value.objectValue,
              Set(object.keys) == Set(["id", "content", "category", "createdAt"]),
              let id = object["id"]?.stringValue, validMemoryID(id),
              let content = object["content"]?.stringValue, validMemoryText(content, maximumLength: Self.maximumMemoryContentLength),
              let category = object["category"]?.stringValue, validMemoryText(category, maximumLength: Self.maximumMemoryCategoryLength),
              case let .number(timestamp)? = object["createdAt"], timestamp.isFinite
        else { throw RailgunPersonalizationServiceError.invalidResponse }
        return .init(id: id, content: content, category: category, createdAt: Date(timeIntervalSince1970: timestamp))
    }

    private func parseInstructionFile(_ value: RailgunJSONValue) throws -> RailgunInstructionFile {
        guard let object = value.objectValue,
              Set(object.keys) == Set(["id", "label", "status", "content"]),
              object["id"]?.stringValue == Self.customInstructionID,
              let label = object["label"]?.stringValue, !label.isEmpty, label.count <= Self.maximumInstructionLabelLength,
              let status = object["status"]?.stringValue, Self.instructionStatuses.contains(status),
              let content = object["content"]?.stringValue, content.count <= Self.maximumInstructionContentLength
        else { throw RailgunPersonalizationServiceError.invalidResponse }
        return .init(label: label, content: content)
    }

    private func validMemoryID(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.count <= Self.maximumMemoryIDLength
    }

    private func validMemoryText(_ value: String, maximumLength: Int) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.count <= maximumLength
    }

    private func nonNegativeInteger(_ value: RailgunJSONValue?) -> Int? {
        guard let value = value?.integerValue, value >= 0 else { return nil }
        return value
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "The personalization request was rejected." }
        return String(RailgunRPCRedactor.redact(text: message).prefix(240))
    }
}

@MainActor
@Observable
final class RailgunPersonalizationStore {
    private let service: RailgunPersonalizationService

    private(set) var memories: [RailgunAgentMemory] = []
    private(set) var memoryCount = 0
    private(set) var isLoadingMemories = false
    private(set) var isMutatingMemory = false
    private(set) var isRunningDream = false
    private(set) var memoryError: String?
    private(set) var dreamResult: RailgunDreamSummary?
    private(set) var dreamError: String?

    private(set) var instructionFile: RailgunInstructionFile?
    private(set) var instructionDraft = ""
    private(set) var isLoadingInstructions = false
    private(set) var isSavingInstruction = false
    private(set) var instructionError: String?

    private var memoryLoadGeneration = 0

    init(service: RailgunPersonalizationService) {
        self.service = service
    }

    func loadMemories(query: String) async {
        let generation = beginMemoryLoad()
        isLoadingMemories = true
        memoryError = nil
        do {
            let loadedMemories = try await service.listMemories(query: query)
            guard isCurrentMemoryLoad(generation) else { return }
            memories = loadedMemories
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                memoryCount = loadedMemories.count
            }
        } catch {
            guard isCurrentMemoryLoad(generation) else { return }
            memoryError = presentationMessage(for: error)
        }
        if isCurrentMemoryLoad(generation) {
            isLoadingMemories = false
        }
    }

    func saveMemory(_ memory: RailgunAgentMemory?, content: String, category: String, query: String) async -> Bool {
        guard !isMutatingMemory else { return false }
        isMutatingMemory = true
        memoryError = nil
        do {
            if let memory {
                _ = try await service.updateMemory(id: memory.id, content: content, category: category)
            } else {
                _ = try await service.createMemory(content: content, category: category)
            }
        } catch {
            memoryError = presentationMessage(for: error)
            isMutatingMemory = false
            return false
        }

        do {
            try await refreshAfterMemoryMutation(query: query)
        } catch {
            memoryError = "The memory was saved, but the list could not be refreshed."
        }
        isMutatingMemory = false
        return true
    }

    func deleteMemory(_ memory: RailgunAgentMemory, query: String) async -> Bool {
        guard !isMutatingMemory else { return false }
        isMutatingMemory = true
        memoryError = nil
        do {
            try await service.deleteMemory(id: memory.id)
        } catch {
            memoryError = presentationMessage(for: error)
            isMutatingMemory = false
            return false
        }

        do {
            try await refreshAfterMemoryMutation(query: query)
        } catch {
            memoryError = "The memory was deleted, but the list could not be refreshed."
        }
        isMutatingMemory = false
        return true
    }

    func runDream(query: String) async {
        guard !isRunningDream, memoryCount >= 5 else { return }
        isRunningDream = true
        dreamError = nil
        dreamResult = nil
        do {
            dreamResult = try await service.runDream()
        } catch {
            dreamError = presentationMessage(for: error)
            isRunningDream = false
            return
        }

        do {
            try await refreshAfterMemoryMutation(query: query)
        } catch {
            dreamError = "Dream completed, but the memories could not be refreshed."
        }
        isRunningDream = false
    }

    func loadCustomInstruction() async {
        isLoadingInstructions = true
        instructionError = nil
        do {
            let file = try await service.customInstruction()
            let shouldReplaceDraft = instructionFile == nil || !isInstructionDirty
            instructionFile = file
            if shouldReplaceDraft {
                instructionDraft = file.content
            }
        } catch {
            instructionError = presentationMessage(for: error)
        }
        isLoadingInstructions = false
    }

    var isInstructionDirty: Bool {
        guard let instructionFile else { return false }
        return instructionDraft != instructionFile.content
    }

    func updateInstructionDraft(_ content: String) {
        instructionDraft = content
    }

    func revertInstructionDraft() {
        instructionDraft = instructionFile?.content ?? ""
    }

    func saveInstruction() async -> Bool {
        guard instructionFile != nil, !isSavingInstruction else { return false }
        isSavingInstruction = true
        instructionError = nil
        do {
            let file = try await service.updateCustomInstruction(content: instructionDraft)
            instructionFile = file
            instructionDraft = file.content
            isSavingInstruction = false
            return true
        } catch {
            instructionError = presentationMessage(for: error)
            isSavingInstruction = false
            return false
        }
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunPersonalizationServiceError.invalidRequest:
            "Enter a memory category and content, each within the allowed length."
        case RailgunPersonalizationServiceError.invalidResponse:
            "The backend returned invalid personalization data."
        case let RailgunPersonalizationServiceError.rejected(message):
            message
        default:
            "The personalization request could not be completed."
        }
    }

    private func refreshAfterMemoryMutation(query: String) async throws {
        let generation = beginMemoryLoad()
        let refreshedMemories = try await service.listMemories(query: query)
        let allMemories = try await service.listMemories()
        guard isCurrentMemoryLoad(generation) else { return }
        memories = refreshedMemories
        memoryCount = allMemories.count
        isLoadingMemories = false
    }

    private func beginMemoryLoad() -> Int {
        memoryLoadGeneration += 1
        return memoryLoadGeneration
    }

    private func isCurrentMemoryLoad(_ generation: Int) -> Bool {
        generation == memoryLoadGeneration
    }
}
