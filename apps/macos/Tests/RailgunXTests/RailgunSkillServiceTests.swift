import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunSkillServiceTests: XCTestCase {
    func testSkillServiceUsesTheCRUDContractAndRefreshesValidatedDetails() async throws {
        let recorder = SkillCommandRecorder()
        let service = RailgunSkillService { command in
            await recorder.record(command)
            switch command.type {
            case .skillsList:
                return try skillResponse(command.type, data: .object([
                    "skills": .array([skillSummaryValue(name: "review")]),
                ]))
            case .skillGet, .skillCreate, .skillUpdate:
                return try skillResponse(command.type, data: .object([
                    "skill": skillDetailValue(name: command.fields["name"]?.stringValue ?? "review"),
                ]))
            case .skillDelete:
                return try skillResponse(command.type)
            default:
                throw SkillTestError.unexpectedCommand
            }
        }

        let listed = try await service.list()
        XCTAssertEqual(listed, [.init(name: "review", description: "Review work", isModelInvocationDisabled: false)])
        _ = try await service.get(name: "review")
        _ = try await service.create(name: "new-skill", description: "New", body: "Body", isModelInvocationDisabled: true)
        _ = try await service.update(name: "new-skill", description: "Updated", body: "Updated body", isModelInvocationDisabled: false)
        try await service.delete(name: "new-skill")

        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.skillsList, .skillGet, .skillCreate, .skillUpdate, .skillDelete])
        XCTAssertEqual(commands[2].fields["disableModelInvocation"], .bool(true))
        XCTAssertEqual(commands[3].fields["name"], .string("new-skill"))
    }

    func testSkillServiceRejectsMalformedResponsesAndRedactsFailures() async throws {
        let malformed = RailgunSkillService { command in
            try skillResponse(command.type, data: .object(["skills": .array([.object(["name": .string("review")])])]))
        }
        await assertSkillThrows({ try await malformed.list() }) { error in
            XCTAssertEqual(error as? RailgunSkillServiceError, .invalidResponse)
        }

        let rejected = RailgunSkillService { command in
            try skillRejectedResponse(command.type, error: "Bearer secret-skill-token rejected")
        }
        await assertSkillThrows({ try await rejected.get(name: "review") }) { error in
            guard case let .some(.rejected(message)) = error as? RailgunSkillServiceError else {
                return XCTFail("Expected a rejected skill request")
            }
            XCTAssertFalse(message.contains("secret-skill-token"))
        }
    }

    func testSkillServicePreservesCancellation() async {
        let service = RailgunSkillService { _ in throw CancellationError() }

        await assertSkillThrows({ try await service.get(name: "review") }) { error in
            XCTAssertTrue(error is CancellationError)
        }
    }

    func testSkillStoreRefreshesAfterCreateUpdateAndDelete() async throws {
        let recorder = SkillCommandRecorder()
        let service = RailgunSkillService { command in
            await recorder.record(command)
            switch command.type {
            case .skillsList:
                return try skillResponse(command.type, data: .object(["skills": .array([])]))
            case .skillCreate, .skillUpdate:
                return try skillResponse(command.type, data: .object(["skill": skillDetailValue(name: "new-skill")]))
            case .skillDelete:
                return try skillResponse(command.type)
            default:
                throw SkillTestError.unexpectedCommand
            }
        }
        let store = RailgunSkillsStore(service: service)

        await store.load()
        let created = await store.create(name: "new-skill", description: "New", body: "Body", isModelInvocationDisabled: false)
        XCTAssertTrue(created)
        let updated = await store.update(name: "new-skill", description: "Updated", body: "Updated", isModelInvocationDisabled: true)
        XCTAssertTrue(updated)
        let deleted = await store.delete(name: "new-skill")
        XCTAssertTrue(deleted)

        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.skillsList, .skillCreate, .skillsList, .skillUpdate, .skillsList, .skillDelete, .skillsList])
        XCTAssertNil(store.error)
    }

    func testSkillStoreRetryRepeatsTheFailedDetailRequest() async throws {
        let recorder = SkillCommandRecorder()
        let service = RailgunSkillService { command in
            await recorder.record(command)
            switch command.type {
            case .skillsList:
                return try skillResponse(command.type, data: .object([
                    "skills": .array([skillSummaryValue(name: "review")]),
                ]))
            case .skillGet:
                let recorded = await recorder.commands
                let detailAttempts = recorded.filter { $0.type == .skillGet }.count
                if detailAttempts == 1 {
                    return try skillRejectedResponse(command.type, error: "temporary failure")
                }
                return try skillResponse(command.type, data: .object([
                    "skill": skillDetailValue(name: "review"),
                ]))
            default:
                throw SkillTestError.unexpectedCommand
            }
        }
        let store = RailgunSkillsStore(service: service)

        await store.load()
        await store.loadDetail(name: "review")
        XCTAssertNotNil(store.error)

        await store.retry()

        XCTAssertEqual(store.selectedSkill?.name, "review")
        XCTAssertNil(store.error)
    }

    func testSkillStoreIgnoresCanceledStaleDetailResponses() async throws {
        let requests = SkillDetailRequestQueue()
        let service = RailgunSkillService { command in
            guard command.type == .skillGet,
                  let name = command.fields["name"]?.stringValue
            else { throw SkillTestError.unexpectedCommand }
            return try await requests.response(for: name)
        }
        let store = RailgunSkillsStore(service: service)

        let first = Task { await store.loadDetail(name: "first") }
        await requests.waitUntilRequested("first")
        first.cancel()
        let second = Task { await store.loadDetail(name: "second") }
        await requests.waitUntilRequested("second")

        try await requests.succeed("second")
        await second.value
        try await requests.succeed("first")
        await first.value

        XCTAssertEqual(store.selectedSkill?.name, "second")
        XCTAssertNil(store.error)
        XCTAssertFalse(store.isLoadingDetail)
    }

    func testSkillDTOValidationKeepsNamesImmutableAndBodiesBounded() throws {
        XCTAssertThrowsError(try RailgunRPCCommand(type: .skillCreate, fields: [
            "name": .string("Bad Name"),
            "description": .string("Description"),
            "body": .string("Body"),
        ]))
        XCTAssertThrowsError(try RailgunRPCCommand(type: .skillUpdate, fields: [
            "name": .string("review"),
            "description": .string("Description"),
        ]))
        XCTAssertThrowsError(try RailgunRPCCommand(type: .skillCreate, fields: [
            "name": .string("review"),
            "description": .string("Description"),
            "body": .string(String(repeating: "é", count: 100_001)),
        ]))
        let command = try RailgunRPCCommand(type: .skillUpdate, fields: [
            "name": .string("review"),
            "description": .string("Description"),
            "body": .string("Body"),
            "disableModelInvocation": .bool(false),
        ])
        XCTAssertEqual(command.fields["name"], .string("review"))
    }
}

private actor SkillCommandRecorder {
    private(set) var commands: [RailgunRPCCommand] = []
    func record(_ command: RailgunRPCCommand) { commands.append(command) }
}

private actor SkillDetailRequestQueue {
    private var continuations: [String: CheckedContinuation<RailgunRPCResponse, any Error>] = [:]

    func response(for name: String) async throws -> RailgunRPCResponse {
        try await withCheckedThrowingContinuation { continuation in
            continuations[name] = continuation
        }
    }

    func waitUntilRequested(_ name: String) async {
        while continuations[name] == nil {
            await Task.yield()
        }
    }

    func succeed(_ name: String) throws {
        guard let continuation = continuations.removeValue(forKey: name) else {
            throw SkillTestError.unexpectedCommand
        }
        continuation.resume(returning: try skillResponse(
            .skillGet,
            data: .object(["skill": skillDetailValue(name: name)])
        ))
    }
}

private enum SkillTestError: Error { case unexpectedCommand }

private func skillSummaryValue(name: String) -> RailgunJSONValue {
    .object([
        "name": .string(name),
        "description": .string("Review work"),
        "disableModelInvocation": .bool(false),
    ])
}

private func skillDetailValue(name: String) -> RailgunJSONValue {
    .object([
        "name": .string(name),
        "description": .string("Review work"),
        "disableModelInvocation": .bool(false),
        "body": .string("# Review\n\nReview work."),
    ])
}

private func skillResponse(_ command: RailgunRPCCommandType, data: RailgunJSONValue? = nil) throws -> RailgunRPCResponse {
    var value: [String: RailgunJSONValue] = [
        "type": .string("response"),
        "command": .string(command.rawValue),
        "success": .bool(true),
    ]
    if let data { value["data"] = data }
    return try RailgunRPCResponse(data: JSONEncoder().encode(RailgunJSONValue.object(value)))
}

private func skillRejectedResponse(_ command: RailgunRPCCommandType, error: String) throws -> RailgunRPCResponse {
    try RailgunRPCResponse(data: JSONEncoder().encode(RailgunJSONValue.object([
        "type": .string("response"),
        "command": .string(command.rawValue),
        "success": .bool(false),
        "error": .string(error),
    ])))
}

@MainActor
private func assertSkillThrows<T: Sendable>(
    _ expression: () async throws -> T,
    _ verify: (Error) -> Void
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error")
    } catch {
        verify(error)
    }
}
