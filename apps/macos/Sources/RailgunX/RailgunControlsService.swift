import Foundation
import RailgunTransport

enum RailgunControlsServiceError: Error, Equatable, Sendable {
    case invalidResponse
    case invalidSelection
    case advisorModelRequired
    case rejected(String)
}

struct RailgunControlsMutationResult: Equatable, Sendable {
    let snapshot: RailgunControlsSnapshot
    let warning: String?
}

/// Owns the v1 task-control RPC contract. The service keeps raw configuration
/// only long enough to make narrow patches, so client updates never discard
/// fields added by a newer backend.
actor RailgunControlsService {
    typealias Request = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private struct LoadedControls: Sendable {
        let snapshot: RailgunControlsSnapshot
        let config: [String: RailgunJSONValue]
    }

    private static let timeout: Duration = .seconds(15)
    private static let maximumModels = 256
    private static let maximumPresets = 128
    private static let maximumModelIDLength = 256
    private static let maximumModelNameLength = 500
    private static let maximumPresetNameLength = 256
    private static let maximumReferenceModels = 8
    private static let maximumBaseURLLength = 2_048
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

    func load() async throws -> RailgunControlsSnapshot {
        let loaded = try await loadDetailed()
        return loaded.snapshot
    }

    /// Applies a model to the active task and saves it as the default. A failed
    /// persistence request deliberately remains a partial success because the
    /// active task has already changed.
    func selectModel(_ modelID: String) async throws -> RailgunControlsMutationResult {
        let loaded = try await loadDetailed()
        guard isValidIdentifier(modelID), loaded.snapshot.models.contains(where: { $0.id == modelID }) else {
            throw RailgunControlsServiceError.invalidSelection
        }

        try await acknowledge(.setModel, fields: ["modelId": .string(modelID)])
        let snapshot = loaded.snapshot.withModel(
            activeModelID: modelID,
            defaultModelID: loaded.snapshot.defaultModelID
        )

        do {
            try await updateConfig(["model": .string(modelID)])
            return .init(
                snapshot: snapshot.withModel(activeModelID: modelID, defaultModelID: modelID),
                warning: nil
            )
        } catch {
            return .init(
                snapshot: snapshot,
                warning: "This task changed to \(modelID), but the default was not saved."
            )
        }
    }

    func selectMoAPreset(_ presetName: String?) async throws -> RailgunControlsMutationResult {
        let loaded = try await loadDetailed()
        guard presetName == nil || loaded.snapshot.moaPresets.contains(where: { $0.name == presetName }) else {
            throw RailgunControlsServiceError.invalidSelection
        }

        try await updateConfig(["activeMoaPreset": presetName.map(RailgunJSONValue.string) ?? .null])
        return .init(
            snapshot: loaded.snapshot.withMoAPreset(presetName),
            warning: nil
        )
    }

    func configureAdvisor(_ advisor: RailgunAdvisorConfiguration) async throws -> RailgunControlsMutationResult {
        let loaded = try await loadDetailed()
        guard !advisor.isEnabled || advisor.modelID != nil else {
            throw RailgunControlsServiceError.advisorModelRequired
        }
        guard advisor.modelID == nil || loaded.snapshot.models.contains(where: { $0.id == advisor.modelID }) else {
            throw RailgunControlsServiceError.invalidSelection
        }

        var rawAdvisor = loaded.config["advisor"]?.objectValue ?? [:]
        rawAdvisor["enabled"] = .bool(advisor.isEnabled)
        if let modelID = advisor.modelID {
            rawAdvisor["model"] = .string(modelID)
        } else {
            rawAdvisor.removeValue(forKey: "model")
        }
        try await updateConfig(["advisor": .object(rawAdvisor)])

        return .init(
            snapshot: loaded.snapshot.withAdvisor(advisor),
            warning: nil
        )
    }

    private func loadDetailed() async throws -> LoadedControls {
        async let catalogRequest = perform(.getAvailableModels)
        async let stateRequest = perform(.getState)
        async let configRequest = perform(.configGet)
        let (catalogResponse, stateResponse, configResponse) = try await (
            catalogRequest,
            stateRequest,
            configRequest
        )

        let models = try parseModels(catalogResponse.data)
        let state = try parseState(stateResponse.data)
        guard models.contains(where: { $0.id == state.modelID }) else {
            throw RailgunControlsServiceError.invalidResponse
        }
        let config = try parseConfig(configResponse.data)
        return .init(
            snapshot: .init(
                models: models,
                activeModelID: state.modelID,
                defaultModelID: config.defaultModelID,
                moaPresets: config.moaPresets,
                activeMoAPresetName: config.activeMoAPresetName,
                advisor: config.advisor,
                isBackendRunning: state.isRunning
            ),
            config: config.raw
        )
    }

    private func perform(
        _ type: RailgunRPCCommandType,
        fields: [String: RailgunJSONValue] = [:]
    ) async throws -> RailgunRPCResponse {
        let command: RailgunRPCCommand
        do {
            command = try RailgunRPCCommand(type: type, fields: fields)
        } catch {
            throw RailgunControlsServiceError.invalidSelection
        }
        let response: RailgunRPCResponse
        do {
            response = try await request(command)
        } catch {
            throw RailgunControlsServiceError.rejected("The task controls could not be updated.")
        }
        guard response.command == type.rawValue else { throw RailgunControlsServiceError.invalidResponse }
        guard response.success else {
            throw RailgunControlsServiceError.rejected(presentationMessage(response.error))
        }
        return response
    }

    private func acknowledge(
        _ type: RailgunRPCCommandType,
        fields: [String: RailgunJSONValue]
    ) async throws {
        let response = try await perform(type, fields: fields)
        guard response.data == nil else { throw RailgunControlsServiceError.invalidResponse }
    }

    private func updateConfig(_ patch: [String: RailgunJSONValue]) async throws {
        let response = try await perform(.configUpdate, fields: ["patch": .object(patch)])
        guard response.data?.objectValue?["config"]?.objectValue != nil else {
            throw RailgunControlsServiceError.invalidResponse
        }
    }

    private func parseModels(_ data: RailgunJSONValue?) throws -> [RailgunModel] {
        guard let values = data?.objectValue?["models"], case let .array(rawModels) = values,
              rawModels.count <= Self.maximumModels
        else { throw RailgunControlsServiceError.invalidResponse }

        var identifiers = Set<String>()
        return try rawModels.map { value in
            guard let object = value.objectValue,
                  let id = validIdentifier(object["id"]),
                  let name = validText(object["name"], maximumLength: Self.maximumModelNameLength),
                  identifiers.insert(id).inserted,
                  object["provider"]?.stringValue == "devin",
                  let baseURL = object["baseUrl"]?.stringValue, baseURL.count <= Self.maximumBaseURLLength,
                  let inputs = object["input"], case let .array(inputValues) = inputs,
                  !inputValues.isEmpty, inputValues.count <= 2,
                  Set(inputValues.compactMap(\.stringValue)).count == inputValues.count,
                  inputValues.allSatisfy({ $0.stringValue == "text" || $0.stringValue == "image" }),
                  object["supportsTools"]?.boolValue == true,
                  object["reasoning"]?.boolValue != nil,
                  positiveInteger(object["contextWindow"]) != nil,
                  positiveInteger(object["maxTokens"]) != nil
            else { throw RailgunControlsServiceError.invalidResponse }
            return .init(id: id, name: name)
        }
    }

    private func parseState(_ data: RailgunJSONValue?) throws -> (modelID: String, isRunning: Bool) {
        guard let object = data?.objectValue,
              let modelID = validIdentifier(object["model"]),
              let isRunning = object["running"]?.boolValue,
              let messageCount = object["messageCount"]?.integerValue,
              messageCount >= 0, messageCount <= Self.maximumSafeInteger
        else { throw RailgunControlsServiceError.invalidResponse }
        return (modelID, isRunning)
    }

    private func parseConfig(_ data: RailgunJSONValue?) throws -> (
        raw: [String: RailgunJSONValue],
        defaultModelID: String?,
        moaPresets: [RailgunMoAPreset],
        activeMoAPresetName: String?,
        advisor: RailgunAdvisorConfiguration
    ) {
        guard let raw = data?.objectValue?["config"]?.objectValue else {
            throw RailgunControlsServiceError.invalidResponse
        }
        let defaultModelID: String?
        if let value = raw["model"], value != .null {
            guard let modelID = validIdentifier(value) else { throw RailgunControlsServiceError.invalidResponse }
            defaultModelID = modelID
        } else {
            defaultModelID = nil
        }

        let presets = try parseMoAPresets(raw["moaPresets"])
        let activeMoAPresetName: String?
        if let value = raw["activeMoaPreset"], value != .null {
            guard let name = validPresetName(value), presets.contains(where: { $0.name == name }) else {
                throw RailgunControlsServiceError.invalidResponse
            }
            activeMoAPresetName = name
        } else {
            activeMoAPresetName = nil
        }

        let advisor = try parseAdvisor(raw["advisor"])
        return (raw, defaultModelID, presets, activeMoAPresetName, advisor)
    }

    private func parseMoAPresets(_ value: RailgunJSONValue?) throws -> [RailgunMoAPreset] {
        guard let value else { return [] }
        guard let raw = value.objectValue, raw.count <= Self.maximumPresets else {
            throw RailgunControlsServiceError.invalidResponse
        }
        return try raw.map { name, value in
            guard let name = validPresetName(.string(name)),
                  let object = value.objectValue,
                  let references = object["referenceModels"], case let .array(rawReferences) = references,
                  !rawReferences.isEmpty, rawReferences.count <= Self.maximumReferenceModels,
                  let aggregator = object["aggregator"]?.objectValue,
                  let aggregatorModelID = validIdentifier(aggregator["model"])
            else { throw RailgunControlsServiceError.invalidResponse }
            let referenceModelIDs = try rawReferences.map { reference in
                guard let modelID = validIdentifier(reference.objectValue?["model"]) else {
                    throw RailgunControlsServiceError.invalidResponse
                }
                return modelID
            }
            let referenceMaxTokens: Int?
            if let value = object["referenceMaxTokens"] {
                guard let limit = positiveInteger(value) else { throw RailgunControlsServiceError.invalidResponse }
                referenceMaxTokens = limit
            } else {
                referenceMaxTokens = nil
            }
            return .init(
                name: name,
                referenceModelIDs: referenceModelIDs,
                aggregatorModelID: aggregatorModelID,
                referenceMaxTokens: referenceMaxTokens
            )
        }
    }

    private func parseAdvisor(_ value: RailgunJSONValue?) throws -> RailgunAdvisorConfiguration {
        guard let value else { return .disabled }
        guard let object = value.objectValue else { throw RailgunControlsServiceError.invalidResponse }
        let enabled: Bool
        if let rawEnabled = object["enabled"] {
            guard let parsed = rawEnabled.boolValue else { throw RailgunControlsServiceError.invalidResponse }
            enabled = parsed
        } else {
            enabled = false
        }
        let modelID: String?
        if let rawModel = object["model"] {
            guard let parsed = validIdentifier(rawModel) else { throw RailgunControlsServiceError.invalidResponse }
            modelID = parsed
        } else {
            modelID = nil
        }
        guard !enabled || modelID != nil else { throw RailgunControlsServiceError.invalidResponse }
        return .init(isEnabled: enabled, modelID: modelID)
    }

    private func validIdentifier(_ value: RailgunJSONValue?) -> String? {
        guard let value = value?.stringValue,
              isValidIdentifier(value)
        else { return nil }
        return value
    }

    private func isValidIdentifier(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && value.count <= Self.maximumModelIDLength
    }

    private func validPresetName(_ value: RailgunJSONValue?) -> String? {
        guard let value = value?.stringValue,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= Self.maximumPresetNameLength
        else { return nil }
        return value
    }

    private func validText(_ value: RailgunJSONValue?, maximumLength: Int) -> String? {
        guard let value = value?.stringValue,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= maximumLength
        else { return nil }
        return value
    }

    private func positiveInteger(_ value: RailgunJSONValue?) -> Int? {
        guard let value = value?.integerValue,
              value > 0, value <= Self.maximumSafeInteger
        else { return nil }
        return value
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "The task controls request was rejected." }
        return String(RailgunRPCRedactor.redact(text: message).prefix(240))
    }
}

/// Bridges task-control intent to effects and keeps the reducer as the sole
/// owner of SwiftUI-observed state.
@MainActor
final class RailgunControlsCoordinator {
    private let store: RailgunAppStore
    private let service: RailgunControlsService
    private var modelDidChange: (@MainActor (String) async -> Void)?

    init(
        store: RailgunAppStore,
        service: RailgunControlsService,
        modelDidChange: (@MainActor (String) async -> Void)? = nil
    ) {
        self.store = store
        self.service = service
        self.modelDidChange = modelDidChange
    }

    func setModelDidChange(_ handler: @escaping @MainActor (String) async -> Void) {
        modelDidChange = handler
    }

    func refresh() async {
        store.send(.controls(.loading))
        do {
            store.send(.controls(.loaded(try await service.load())))
        } catch {
            store.send(.controls(.loadFailed(presentationMessage(for: error))))
        }
    }

    func useModel(_ modelID: String) async {
        await performMutation(
            { try await self.service.selectModel(modelID) },
            afterSuccess: { await self.modelDidChange?(modelID) }
        )
    }

    func selectMoAPreset(_ presetName: String?) async {
        await performMutation {
            try await self.service.selectMoAPreset(presetName)
        }
    }

    func configureAdvisor(_ advisor: RailgunAdvisorConfiguration) async {
        await performMutation {
            try await self.service.configureAdvisor(advisor)
        }
    }

    private func performMutation(
        _ operation: () async throws -> RailgunControlsMutationResult,
        afterSuccess: @MainActor () async -> Void = {}
    ) async {
        guard canMutate else { return }
        store.send(.controls(.mutationStarted))
        do {
            let result = try await operation()
            await afterSuccess()
            store.send(.controls(.mutationFinished(result.snapshot, warning: result.warning)))
        } catch {
            store.send(.controls(.mutationFailed(presentationMessage(for: error))))
        }
    }

    private var canMutate: Bool {
        store.state.controls.isReadyForMutation && !store.state.transcript.isRunning
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunControlsServiceError.invalidResponse:
            "The backend returned invalid task controls."
        case RailgunControlsServiceError.invalidSelection:
            "That selection is no longer available."
        case RailgunControlsServiceError.advisorModelRequired:
            "Choose an advisor model before enabling the advisor."
        case let RailgunControlsServiceError.rejected(message):
            message
        default:
            "The task controls could not be updated."
        }
    }
}
