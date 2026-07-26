import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunPersonalizationServiceTests: XCTestCase {
    func testMemoryMutationsUseTheLegacyRPCContract() async throws {
        let recorder = PersonalizationCommandRecorder()
        let service = RailgunPersonalizationService { command in
            await recorder.record(command)
            switch command.type {
            case .memoryCreate, .memoryUpdate:
                return try personalizationResponse(command.type, data: .object(["memory": memoryValue(id: "memory-1")]))
            case .memoryDelete:
                return try personalizationResponse(command.type)
            default:
                throw PersonalizationTestError.unexpectedCommand
            }
        }

        _ = try await service.createMemory(content: "  Prefer concise replies  ", category: " preference ")
        _ = try await service.updateMemory(id: "memory-1", content: "Updated", category: "fact")
        try await service.deleteMemory(id: "memory-1")

        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.memoryCreate, .memoryUpdate, .memoryDelete])
        XCTAssertEqual(commands[0].fields, ["content": .string("Prefer concise replies"), "category": .string("preference")])
        XCTAssertEqual(commands[1].fields, ["memoryId": .string("memory-1"), "patch": .object(["content": .string("Updated"), "category": .string("fact")])])
        XCTAssertEqual(commands[2].fields, ["memoryId": .string("memory-1")])
    }

    func testListMemoriesChoosesSearchOnlyForAQuery() async throws {
        let recorder = PersonalizationCommandRecorder()
        let service = RailgunPersonalizationService { command in
            await recorder.record(command)
            return try personalizationResponse(command.type, data: .object(["memories": .array([memoryValue(id: "memory-1")])]))
        }

        _ = try await service.listMemories()
        _ = try await service.listMemories(query: " concise ")

        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.memoryList, .memorySearch])
        XCTAssertEqual(commands[0].fields, ["limit": .number(100)])
        XCTAssertEqual(commands[1].fields, ["query": .string("concise"), "limit": .number(100)])
    }

    func testCustomInstructionUsesOnlyTheRailgunDotfileAndSavesContent() async throws {
        let recorder = PersonalizationCommandRecorder()
        let service = RailgunPersonalizationService { command in
            await recorder.record(command)
            switch command.type {
            case .instructionFileGet, .instructionFileUpdate:
                let id = command.fields["fileId"]?.stringValue ?? ""
                return try personalizationResponse(command.type, data: .object(["file": instructionValue(id: id, content: "# Updated")]))
            default:
                throw PersonalizationTestError.unexpectedCommand
            }
        }

        let loaded = try await service.customInstruction()
        let saved = try await service.updateCustomInstruction(content: "# Updated")

        XCTAssertEqual(loaded.content, "# Updated")
        XCTAssertEqual(saved.label, "~/.railgun.md")
        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.instructionFileGet, .instructionFileUpdate])
        XCTAssertEqual(commands[0].fields, ["fileId": .string("railgun-dotfile")])
        XCTAssertEqual(commands[1].fields, ["fileId": .string("railgun-dotfile"), "content": .string("# Updated")])
    }

    func testRunDreamAcceptsOnlyTheExpectedSummary() async throws {
        let service = RailgunPersonalizationService { command in
            XCTAssertEqual(command.type, .dreamRun)
            XCTAssertTrue(command.fields.isEmpty)
            return try personalizationResponse(command.type, data: .object([
                "status": .string("completed"), "beforeCount": .number(5), "afterCount": .number(4),
            ]))
        }

        let summary = try await service.runDream()

        XCTAssertEqual(summary, .init(status: .completed, beforeCount: 5, afterCount: 4))
    }

    func testRunDreamDoesNotApplyTheInteractiveRequestTimeout() async throws {
        let recorder = PersonalizationTimeoutRecorder()
        let service = RailgunPersonalizationService(request: { command, timeout in
            await recorder.record(timeout)
            return try personalizationResponse(command.type, data: .object([
                "status": .string("completed"), "beforeCount": .number(5), "afterCount": .number(4),
            ]))
        })

        _ = try await service.runDream()

        let timeout = await recorder.lastTimeout()
        XCTAssertNil(timeout)
    }

    func testRunDreamRejectsMalformedSummaries() async throws {
        let service = RailgunPersonalizationService { command in
            try personalizationResponse(command.type, data: .object([
                "status": .string("completed"), "beforeCount": .number(5),
            ]))
        }

        await assertPersonalizationThrows(try await service.runDream()) { error in
            XCTAssertEqual(error as? RailgunPersonalizationServiceError, .invalidResponse)
        }
    }

    func testMalformedMemoryAndRedactedBackendFailuresAreNotExposed() async throws {
        let malformed = RailgunPersonalizationService { command in
            try personalizationResponse(command.type, data: .object(["memories": .array([.object(["id": .string("memory"), "content": .string("text"), "category": .string("fact")])])]))
        }
        await assertPersonalizationThrows(try await malformed.listMemories()) { error in
            XCTAssertEqual(error as? RailgunPersonalizationServiceError, .invalidResponse)
        }

        let rejected = RailgunPersonalizationService { command in
            try personalizationRejectedResponse(command.type, error: "Bearer sensitive-token was rejected")
        }
        await assertPersonalizationThrows(try await rejected.listMemories()) { error in
            guard case let .some(.rejected(message)) = error as? RailgunPersonalizationServiceError else {
                return XCTFail("Expected a rejected error")
            }
            XCTAssertFalse(message.contains("sensitive-token"))
        }
    }

    func testUnsavedInstructionDraftSurvivesARefresh() async throws {
        let service = RailgunPersonalizationService { command in
            try personalizationResponse(
                command.type,
                data: .object(["file": instructionValue(id: "railgun-dotfile", content: "Server instruction")])
            )
        }
        let store = RailgunPersonalizationStore(service: service)

        await store.loadCustomInstruction()
        store.updateInstructionDraft("Local unsaved instruction")
        await store.loadCustomInstruction()

        XCTAssertEqual(store.instructionDraft, "Local unsaved instruction")
        XCTAssertTrue(store.isInstructionDirty)
    }

    func testCreatedMemoryIsTreatedAsSavedWhenRefreshFails() async throws {
        let service = RailgunPersonalizationService { command in
            switch command.type {
            case .memoryCreate:
                return try personalizationResponse(command.type, data: .object(["memory": memoryValue(id: "memory-1")]))
            case .memoryList:
                throw PersonalizationTestError.unexpectedCommand
            default:
                throw PersonalizationTestError.unexpectedCommand
            }
        }
        let store = RailgunPersonalizationStore(service: service)

        let saved = await store.saveMemory(nil, content: "Remember this", category: "fact", query: "")

        XCTAssertTrue(saved)
        XCTAssertEqual(store.memoryError, "The memory was saved, but the list could not be refreshed.")
    }
}

private actor PersonalizationCommandRecorder {
    private(set) var commands: [RailgunRPCCommand] = []
    func record(_ command: RailgunRPCCommand) { commands.append(command) }
}

private actor PersonalizationTimeoutRecorder {
    private var timeouts: [Duration?] = []

    func record(_ timeout: Duration?) {
        timeouts.append(timeout)
    }

    func lastTimeout() -> Duration? {
        timeouts.last ?? nil
    }
}

private enum PersonalizationTestError: Error { case unexpectedCommand }

private func memoryValue(id: String) -> RailgunJSONValue {
    .object(["id": .string(id), "content": .string("Prefer concise replies"), "category": .string("preference"), "createdAt": .number(1_720_000_000)])
}

private func instructionValue(id: String, content: String? = nil) -> RailgunJSONValue {
    var value: [String: RailgunJSONValue] = ["id": .string(id), "label": .string("~/.railgun.md"), "status": .string("active")]
    if let content { value["content"] = .string(content) }
    return .object(value)
}

private func personalizationResponse(_ command: RailgunRPCCommandType, data: RailgunJSONValue? = nil) throws -> RailgunRPCResponse {
    var value: [String: RailgunJSONValue] = [
        "type": .string("response"), "command": .string(command.rawValue), "success": .bool(true),
    ]
    if let data { value["data"] = data }
    return try RailgunRPCResponse(data: JSONEncoder().encode(RailgunJSONValue.object(value)))
}

private func personalizationRejectedResponse(_ command: RailgunRPCCommandType, error: String) throws -> RailgunRPCResponse {
    try RailgunRPCResponse(data: JSONEncoder().encode(RailgunJSONValue.object([
        "type": .string("response"), "command": .string(command.rawValue), "success": .bool(false), "error": .string(error),
    ])))
}

@MainActor
private func assertPersonalizationThrows<T>(
    _ expression: @autoclosure () async throws -> T,
    _ verify: (Error) -> Void
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error")
    } catch {
        verify(error)
    }
}
