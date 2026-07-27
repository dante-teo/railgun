import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunControlsServiceTests: XCTestCase {
    func testModelSelectionReducerAcknowledgesImmediatelyAndRevertsOnlyOnRejection() {
        let loaded = RailgunControlsSnapshot(
            models: [.init(id: "primary", name: "Primary"), .init(id: "selected", name: "Selected")],
            activeModelID: "primary",
            defaultModelID: "primary",
            moaPresets: [],
            activeMoAPresetName: nil,
            advisor: .disabled
        )
        var state = RailgunControlsReducer.reduce(.initial, .loaded(loaded))

        state = RailgunControlsReducer.reduce(state, .modelSelectionStarted("selected"))
        XCTAssertEqual(state.activeModelID, "selected")
        XCTAssertTrue(state.isMutating)

        state = RailgunControlsReducer.reduce(state, .modelSelectionReverted("Unavailable"))
        XCTAssertEqual(state.activeModelID, "primary")
        XCTAssertFalse(state.isMutating)
        XCTAssertEqual(state.error, "Unavailable")
    }

    func testControlsReducerTracksLoadMutationAndRecoverablePartialSave() {
        let loaded = RailgunControlsSnapshot(
            models: [.init(id: "primary", name: "Primary")],
            activeModelID: "primary",
            defaultModelID: "primary",
            moaPresets: [],
            activeMoAPresetName: nil,
            advisor: .disabled
        )
        let changed = RailgunControlsSnapshot(
            models: loaded.models,
            activeModelID: "selected",
            defaultModelID: "primary",
            moaPresets: [],
            activeMoAPresetName: nil,
            advisor: .disabled
        )

        var state = RailgunControlsReducer.reduce(.initial, .loading)
        XCTAssertTrue(state.isLoading)
        XCTAssertFalse(state.isLoaded)

        state = RailgunControlsReducer.reduce(state, .loaded(loaded))
        XCTAssertTrue(state.isLoaded)
        XCTAssertEqual(state.activeModelID, "primary")

        state = RailgunControlsReducer.reduce(state, .mutationStarted)
        XCTAssertTrue(state.isMutating)
        state = RailgunControlsReducer.reduce(
            state,
            .mutationFinished(changed, warning: "Default save failed")
        )
        XCTAssertFalse(state.isMutating)
        XCTAssertEqual(state.activeModelID, "selected")
        XCTAssertEqual(state.defaultModelID, "primary")
        XCTAssertEqual(state.error, "Default save failed")

        state = RailgunControlsReducer.reduce(state, .mutationFailed("Advisor update failed"))
        XCTAssertEqual(state.error, "Advisor update failed")
    }

    func testLoadedBackendRunBlocksControlsUntilRunSettlement() {
        let snapshot = RailgunControlsSnapshot(
            models: [.init(id: "primary", name: "Primary")],
            activeModelID: "primary",
            defaultModelID: nil,
            moaPresets: [],
            activeMoAPresetName: nil,
            advisor: .disabled,
            isBackendRunning: true
        )

        var state = RailgunControlsReducer.reduce(.initial, .loaded(snapshot))
        XCTAssertTrue(state.isBackendRunning)
        XCTAssertFalse(state.isReadyForMutation)

        state = RailgunControlsReducer.reduce(state, .backendRunChanged(false))
        XCTAssertFalse(state.isBackendRunning)
        XCTAssertTrue(state.isReadyForMutation)
    }

    func testLoadParsesCatalogStateAndAgentConfiguration() async throws {
        let service = RailgunControlsService { command in
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary", name: "Primary"),
                    controlsModel(id: "advisor", name: "Advisor"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary", isRunning: true))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(
                    model: "primary",
                    activePreset: "review",
                    advisor: .object(["enabled": .bool(true), "model": .string("advisor")])
                ))
            default:
                XCTFail("Unexpected command: \(command.type)")
                return try controlsResponse(for: command.type, data: .object([:]))
            }
        }

        let snapshot = try await service.load()

        XCTAssertEqual(snapshot.models, [
            .init(id: "primary", name: "Primary", contextWindow: 100_000),
            .init(id: "advisor", name: "Advisor", contextWindow: 100_000),
        ])
        XCTAssertEqual(snapshot.activeModelID, "primary")
        XCTAssertEqual(snapshot.defaultModelID, "primary")
        XCTAssertTrue(snapshot.isBackendRunning)
        XCTAssertEqual(snapshot.activeMoAPresetName, "review")
        XCTAssertEqual(snapshot.moaPresets, [.init(
            name: "review", referenceModelIDs: ["advisor"], aggregatorModelID: "primary", referenceMaxTokens: 4_000
        )])
        XCTAssertEqual(snapshot.advisor, .init(isEnabled: true, modelID: "advisor"))
    }

    func testLoadRejectsMalformedOversizedDuplicateAndInconsistentPayloads() async throws {
        let malformedCatalogs: [[RailgunJSONValue]] = [
            [controlsModel(id: "duplicate"), controlsModel(id: "duplicate")],
            Array(repeating: controlsModel(id: "model"), count: 257),
            [.object(["id": .string("missing-metadata")])],
        ]

        for catalog in malformedCatalogs {
            let service = RailgunControlsService { command in
                switch command.type {
                case .getAvailableModels:
                    return try controlsResponse(for: command.type, data: .object(["models": .array(catalog)]))
                case .getState:
                    return try controlsResponse(for: command.type, data: controlsState(model: "duplicate"))
                case .configGet:
                    return try controlsResponse(for: command.type, data: controlsConfig())
                default:
                    throw ControlsStubError.unexpectedCommand
                }
            }
            await assertInvalidControlsResponse(service)
        }

        let inconsistent = RailgunControlsService { command in
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([controlsModel(id: "known")])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "unknown"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig())
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }
        await assertInvalidControlsResponse(inconsistent)

        let inconsistentConfig = RailgunControlsService { command in
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([controlsModel(id: "primary")])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(activePreset: "missing"))
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }
        await assertInvalidControlsResponse(inconsistentConfig)
    }

    func testRefreshKeepsControlsUsableWhenTheActiveModelWasRetired() async throws {
        let stage = ControlsCatalogRefreshStage()
        let service = RailgunControlsService { command in
            switch command.type {
            case .refreshModelCatalog:
                return try controlsResponse(for: command.type, data: .object([:]))
            case .getAvailableModels:
                let models = await stage.nextCatalog()
                return try controlsResponse(for: command.type, data: .object(["models": .array(models)]))
            case .getState:
                let model = await stage.nextStateModel()
                return try controlsResponse(for: command.type, data: controlsState(model: model))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig())
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        _ = try await service.load()
        let refreshed = try await service.refreshModels()

        XCTAssertEqual(refreshed.activeModelID, "retired")
        XCTAssertEqual(refreshed.models.map(\.id), ["replacement", "advisor"])
    }

    func testModelSelectionChangesTheTaskAndPersistsTheDefault() async throws {
        let recorder = ControlsCommandRecorder()
        let service = RailgunControlsService { command in
            await recorder.record(command)
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary"), controlsModel(id: "selected"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(model: "primary"))
            case .setModel:
                XCTAssertEqual(command.fields["modelId"], .string("selected"))
                return try controlsResponse(for: command.type)
            case .configUpdate:
                XCTAssertEqual(command.fields["patch"], .object(["model": .string("selected")]))
                return try controlsResponse(for: command.type, data: controlsConfig(model: "selected"))
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        let saved = try await service.selectModel("selected")
        XCTAssertEqual(saved.snapshot.activeModelID, "selected")
        XCTAssertEqual(saved.snapshot.defaultModelID, "selected")
        XCTAssertNil(saved.warning)

        let commands = await recorder.commands()
        XCTAssertEqual(commands.filter { $0.type == .setModel }.count, 1)
        XCTAssertEqual(commands.filter { $0.type == .configUpdate }.count, 1)
    }

    func testDefaultPersistenceFailureRetainsTheChangedTaskModelAndReturnsAWarning() async throws {
        let service = RailgunControlsService { command in
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary"), controlsModel(id: "selected"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(model: "primary"))
            case .setModel:
                return try controlsResponse(for: command.type)
            case .configUpdate:
                return try controlsFailure(for: command.type, error: "disk full")
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        let result = try await service.selectModel("selected")

        XCTAssertEqual(result.snapshot.activeModelID, "selected")
        XCTAssertEqual(result.snapshot.defaultModelID, "primary")
        XCTAssertEqual(result.warning, "This task changed to selected, but the default was not saved.")
    }

    func testCachedDefaultSurvivesALaterPartialModelSelection() async throws {
        let configUpdates = ControlsConfigUpdateCounter()
        let service = RailgunControlsService { command in
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary"), controlsModel(id: "default"),
                    controlsModel(id: "selected"), controlsModel(id: "advisor"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(model: "primary"))
            case .setModel:
                return try controlsResponse(for: command.type)
            case .configUpdate:
                return await configUpdates.next() == 1
                    ? try controlsResponse(for: command.type, data: controlsConfig(model: "default"))
                    : try controlsFailure(for: command.type, error: "disk full")
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        _ = try await service.configureDefaultModel("default")
        let result = try await service.selectModel("selected")

        XCTAssertEqual(result.snapshot.activeModelID, "selected")
        XCTAssertEqual(result.snapshot.defaultModelID, "default")
        XCTAssertNotNil(result.warning)
    }

    func testDefaultModelConfigurationPersistsWithoutChangingTheActiveTaskModel() async throws {
        let recorder = ControlsCommandRecorder()
        let service = RailgunControlsService { command in
            await recorder.record(command)
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary"), controlsModel(id: "default"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(model: "primary"))
            case .configUpdate:
                XCTAssertEqual(command.fields["patch"], .object(["model": .string("default")]))
                return try controlsResponse(for: command.type, data: controlsConfig(model: "default"))
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        let saved = try await service.configureDefaultModel("default")

        XCTAssertEqual(saved.snapshot.activeModelID, "primary")
        XCTAssertEqual(saved.snapshot.defaultModelID, "default")
        let commands = await recorder.commands()
        XCTAssertEqual(commands.filter { $0.type == .setModel }.count, 0)
    }

    func testAgentUpdatesPersistOnlyTheirFieldsAndPreserveUnknownAdvisorFields() async throws {
        let recorder = ControlsCommandRecorder()
        let service = RailgunControlsService { command in
            await recorder.record(command)
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary"), controlsModel(id: "advisor"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(
                    advisor: .object(["enabled": .bool(false), "model": .string("advisor"), "future": .bool(true)])
                ))
            case .configUpdate:
                return try controlsResponse(for: command.type, data: controlsConfig())
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        let off = try await service.selectMoAPreset(nil)
        XCTAssertNil(off.snapshot.activeMoAPresetName)
        let advisor = try await service.configureAdvisor(.init(isEnabled: true, modelID: "primary"))
        XCTAssertEqual(advisor.snapshot.advisor, .init(isEnabled: true, modelID: "primary"))

        let patches = await recorder.commands().compactMap { $0.fields["patch"]?.objectValue }
        XCTAssertEqual(patches[0], ["activeMoaPreset": .null])
        XCTAssertEqual(patches[1]["advisor"], .object([
            "enabled": .bool(true), "model": .string("primary"), "future": .bool(true),
        ]))

        do {
            _ = try await service.configureAdvisor(.init(isEnabled: true, modelID: nil))
            XCTFail("Expected enabled advisor without a model to be rejected")
        } catch {
            XCTAssertEqual(error as? RailgunControlsServiceError, .advisorModelRequired)
        }
    }

    func testApprovalConfigurationLoadsPersistsAndRequiresAReviewerForAutoApproval() async throws {
        let recorder = ControlsCommandRecorder()
        let service = RailgunControlsService { command in
            await recorder.record(command)
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary"), controlsModel(id: "reviewer"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(
                    approvalMode: "smart",
                    reviewerModel: "reviewer"
                ))
            case .configUpdate:
                XCTAssertEqual(command.fields["patch"], .object([
                    "approvalMode": .string("smart"),
                    "reviewerModel": .string("reviewer"),
                ]))
                return try controlsResponse(for: command.type, data: controlsConfig())
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        let loaded = try await service.load()
        XCTAssertEqual(loaded.approval, .init(mode: .smart, reviewerModelID: "reviewer"))

        let saved = try await service.configureApproval(.init(mode: .smart, reviewerModelID: "reviewer"))
        XCTAssertEqual(saved.snapshot.approval, .init(mode: .smart, reviewerModelID: "reviewer"))

        do {
            _ = try await service.configureApproval(.init(mode: .smart, reviewerModelID: nil))
            XCTFail("Expected smart approval without a reviewer to be rejected")
        } catch {
            XCTAssertEqual(error as? RailgunControlsServiceError, .approvalModelRequired)
        }
    }

    func testApprovalConfigurationClearsThePersistedReviewerModel() async throws {
        let service = RailgunControlsService { command in
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([
                    controlsModel(id: "primary"), controlsModel(id: "reviewer"),
                ])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig(
                    approvalMode: "smart",
                    reviewerModel: "reviewer"
                ))
            case .configUpdate:
                XCTAssertEqual(command.fields["patch"], .object([
                    "approvalMode": .string("manual"),
                    "reviewerModel": .null,
                ]))
                return try controlsResponse(for: command.type, data: controlsConfig())
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }

        let saved = try await service.configureApproval(.init(mode: .manual, reviewerModelID: nil))

        XCTAssertEqual(saved.snapshot.approval, .manual)
    }

    func testCoordinatorLoadsStateAndBlocksMutationsDuringRunsOrBeforeLoading() async throws {
        let store = RailgunAppStore()
        let recorder = ControlsCommandRecorder()
        let service = RailgunControlsService { command in
            await recorder.record(command)
            switch command.type {
            case .getAvailableModels:
                return try controlsResponse(for: command.type, data: .object(["models": .array([controlsModel(id: "primary")])]))
            case .getState:
                return try controlsResponse(for: command.type, data: controlsState(model: "primary"))
            case .configGet:
                return try controlsResponse(for: command.type, data: controlsConfig())
            default:
                throw ControlsStubError.unexpectedCommand
            }
        }
        let coordinator = RailgunControlsCoordinator(store: store, service: service)

        await coordinator.useModel("primary")
        let commandsBeforeLoad = await recorder.commands()
        XCTAssertTrue(commandsBeforeLoad.isEmpty)

        await coordinator.refresh()
        XCTAssertTrue(store.state.controls.isLoaded)
        XCTAssertFalse(store.state.controls.isMutating)

        store.send(.transcript(.submit(id: "run", text: "Start", at: nil)))
        await coordinator.useModel("primary")
        let commandsDuringRun = await recorder.commands()
        XCTAssertEqual(commandsDuringRun.filter { $0.type == .setModel }.count, 0)
    }

    func testCompactionServiceSendsAFieldlessRequestAndRequiresAnEmptyAcknowledgement() async throws {
        let recorder = ControlsCommandRecorder()
        let compactCommand = try RailgunRPCCommand(type: .compact)
        let service = RailgunCompactionService { command in
            await recorder.record(command)
            return try controlsResponse(for: .compact)
        }

        try await service.compact()

        let commands = await recorder.commands()
        XCTAssertEqual(commands, [compactCommand])

        let malformed = RailgunCompactionService { _ in
            try controlsResponse(for: .compact, data: .object([:]))
        }
        do {
            try await malformed.compact()
            XCTFail("Expected malformed acknowledgement to be rejected")
        } catch {
            XCTAssertEqual(error as? RailgunCompactionServiceError, .invalidResponse)
        }
    }

    func testCompactionServiceRedactsRejectedErrorsAndCoordinatorAllowsRetryAfterFailure() async throws {
        let attempts = CompactionAttemptCounter()
        let compactCommand = try RailgunRPCCommand(type: .compact)
        let service = RailgunCompactionService { command in
            XCTAssertEqual(command, compactCommand)
            if await attempts.next() == 1 {
                return try controlsFailure(for: .compact, error: "token=secret")
            }
            return try controlsResponse(for: .compact)
        }
        let store = RailgunAppStore()
        store.send(.controls(.loaded(compactionSnapshot)))
        store.send(.transcript(.submit(id: "user", text: "Compact this", at: 0)))
        store.send(.transcript(.runEnded(at: 1)))
        let coordinator = RailgunCompactionCoordinator(store: store, service: service)

        await coordinator.compact()

        guard case let .failed(message) = store.state.controls.compactionStatus else {
            return XCTFail("Expected a recoverable compaction failure")
        }
        XCTAssertFalse(message.contains("secret"))
        XCTAssertTrue(store.state.controls.isReadyForMutation)

        await coordinator.compact()

        XCTAssertEqual(store.state.controls.compactionStatus, .completed)
        XCTAssertNil(store.state.controls.contextUsage)
        let attemptCount = await attempts.value
        XCTAssertEqual(attemptCount, 2)
    }

    func testCompactionCoordinatorPreventsDuplicateRequestsWhileACompactionIsPending() async throws {
        let recorder = ControlsCommandRecorder()
        let service = RailgunCompactionService { command in
            await recorder.record(command)
            return try controlsResponse(for: .compact)
        }
        let store = RailgunAppStore()
        store.send(.controls(.loaded(compactionSnapshot)))
        store.send(.transcript(.submit(id: "user", text: "Compact this", at: 0)))
        store.send(.controls(.compactionStarted))
        let coordinator = RailgunCompactionCoordinator(store: store, service: service)

        await coordinator.compact()

        let commands = await recorder.commands()
        XCTAssertTrue(commands.isEmpty)
        XCTAssertEqual(store.state.controls.compactionStatus, .inProgress)
    }

    private func assertInvalidControlsResponse(_ service: RailgunControlsService) async {
        do {
            _ = try await service.load()
            XCTFail("Expected invalid controls response")
        } catch {
            XCTAssertEqual(error as? RailgunControlsServiceError, .invalidResponse)
        }
    }
}

private enum ControlsStubError: Error { case unexpectedCommand }

private actor ControlsCommandRecorder {
    private var recorded: [RailgunRPCCommand] = []

    func record(_ command: RailgunRPCCommand) {
        recorded.append(command)
    }

    func commands() -> [RailgunRPCCommand] { recorded }
}

private actor ControlsConfigUpdateCounter {
    private var value = 0

    func next() -> Int {
        value += 1
        return value
    }
}

private actor ControlsCatalogRefreshStage {
    private var catalogRequestCount = 0
    private var stateRequestCount = 0

    func nextCatalog() -> [RailgunJSONValue] {
        defer { catalogRequestCount += 1 }
        return catalogRequestCount == 0
            ? [controlsModel(id: "primary"), controlsModel(id: "advisor")]
            : [controlsModel(id: "replacement"), controlsModel(id: "advisor")]
    }

    func nextStateModel() -> String {
        defer { stateRequestCount += 1 }
        return stateRequestCount == 0 ? "primary" : "retired"
    }
}

private actor CompactionAttemptCounter {
    private var attempts = 0

    func next() -> Int {
        attempts += 1
        return attempts
    }

    var value: Int { attempts }
}

private let compactionSnapshot = RailgunControlsSnapshot(
    models: [.init(id: "primary", name: "Primary", contextWindow: 100_000)],
    activeModelID: "primary",
    defaultModelID: nil,
    moaPresets: [],
    activeMoAPresetName: nil,
    advisor: .disabled
)

private func controlsModel(id: String, name: String? = nil) -> RailgunJSONValue {
    .object([
        "id": .string(id),
        "name": .string(name ?? id),
        "provider": .string("devin"),
        "baseUrl": .string("https://example.invalid"),
        "input": .array([.string("text")]),
        "supportsTools": .bool(true),
        "reasoning": .bool(false),
        "contextWindow": .number(100_000),
        "maxTokens": .number(8_000),
    ])
}

private func controlsState(model: String, isRunning: Bool = false) -> RailgunJSONValue {
    .object(["running": .bool(isRunning), "model": .string(model), "messageCount": .number(0)])
}

private func controlsConfig(
    model: String? = nil,
    activePreset: String? = nil,
    advisor: RailgunJSONValue = .object(["enabled": .bool(false), "model": .string("advisor")]),
    approvalMode: String? = nil,
    reviewerModel: String? = nil
) -> RailgunJSONValue {
    var config: [String: RailgunJSONValue] = [
        "moaPresets": .object([
            "review": .object([
                "referenceModels": .array([.object(["model": .string("advisor")])]),
                "aggregator": .object(["model": .string("primary")]),
                "referenceMaxTokens": .number(4_000),
            ]),
        ]),
        "advisor": advisor,
        "futureTopLevel": .string("preserved"),
    ]
    if let model { config["model"] = .string(model) }
    if let activePreset { config["activeMoaPreset"] = .string(activePreset) }
    if let approvalMode { config["approvalMode"] = .string(approvalMode) }
    if let reviewerModel { config["reviewerModel"] = .string(reviewerModel) }
    return .object(["config": .object(config)])
}

private func controlsResponse(
    for command: RailgunRPCCommandType,
    data: RailgunJSONValue? = nil
) throws -> RailgunRPCResponse {
    var object: [String: RailgunJSONValue] = [
        "type": .string("response"),
        "command": .string(command.rawValue),
        "success": .bool(true),
    ]
    if let data { object["data"] = data }
    return try .init(data: JSONEncoder().encode(RailgunJSONValue.object(object)))
}

private func controlsFailure(
    for command: RailgunRPCCommandType,
    error: String
) throws -> RailgunRPCResponse {
    try .init(data: JSONEncoder().encode(RailgunJSONValue.object([
        "type": .string("response"),
        "command": .string(command.rawValue),
        "success": .bool(false),
        "error": .string(error),
    ])))
}
