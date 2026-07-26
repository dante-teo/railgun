import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunScheduledServiceTests: XCTestCase {
    func testListPaginatesAndPreservesRunMetadata() async throws {
        let service = RailgunScheduledService { command in
            XCTAssertEqual(command.type, .cronList)
            XCTAssertNil(command.fields["editableOnly"])
            let cursor = command.fields["cursor"]?.integerValue
            if cursor == 0 {
                return try scheduledResponse(.cronList, data: .object([
                    "jobs": .array([scheduledJob(id: "one", lastRun: 1_752_500_000_000, status: "failed", error: "Bearer secret-token failed")]),
                    "nextCursor": .number(1),
                ]))
            }
            return try scheduledResponse(.cronList, data: .object([
                "jobs": .array([scheduledJob(id: "two", lastRun: nil, status: nil, error: nil)]),
            ]))
        }

        let jobs = try await service.list()

        XCTAssertEqual(jobs.map(\.id), ["one", "two"])
        XCTAssertEqual(jobs[0].lastStatus, .failed)
        XCTAssertFalse(jobs[0].lastError?.contains("secret-token") == true)
        XCTAssertNil(jobs[1].lastRun)
        XCTAssertNil(jobs[1].lastStatus)
    }

    func testCreateUpdateAndRemoveUseConstrainedAcknowledgements() async throws {
        let recorder = ScheduledCommandRecorder()
        let service = RailgunScheduledService { command in
            await recorder.record(command)
            switch command.type {
            case .cronAdd, .cronUpdate:
                return try scheduledResponse(command.type, data: .object(["jobId": .string("job")]))
            case .cronRemove:
                return try scheduledResponse(command.type)
            default:
                throw ScheduledTestError.unexpectedCommand
            }
        }

        let created = try await service.create(prompt: "  Daily summary  ", schedule: "0   9 * * *")
        let updated = try await service.update(created, prompt: "Updated", schedule: "30 9 * * *")
        try await service.remove(updated)

        let commands = await recorder.commands
        XCTAssertEqual(commands.map(\.type), [.cronAdd, .cronUpdate, .cronRemove])
        XCTAssertEqual(commands[0].fields["includeJob"], .bool(false))
        XCTAssertEqual(commands[0].fields["schedule"], .string("0 9 * * *"))
        XCTAssertEqual(commands[1].fields["patch"], .object(["prompt": .string("Updated"), "schedule": .string("30 9 * * *")]))
        XCTAssertEqual(commands[2].fields, ["jobId": .string("job")])
    }

    func testInvalidFormDoesNotRequestTheBackend() async throws {
        let recorder = ScheduledCommandRecorder()
        let service = RailgunScheduledService { command in
            await recorder.record(command)
            return try scheduledResponse(command.type)
        }

        await assertScheduledThrows(try await service.create(prompt: " ", schedule: "* * * * *")) { error in
            XCTAssertEqual(error as? RailgunScheduledServiceError, .invalidRequest)
        }
        await assertScheduledThrows(try await service.create(prompt: "Run", schedule: "* * * *")) { error in
            XCTAssertEqual(error as? RailgunScheduledServiceError, .invalidRequest)
        }
        let commands = await recorder.commands
        XCTAssertTrue(commands.isEmpty)
    }

    func testListRejectsMalformedPayloadsAndRedactsBackendErrors() async throws {
        let malformed = RailgunScheduledService { command in
            try scheduledResponse(command.type, data: .object(["jobs": .string("not an array")]))
        }
        await assertScheduledThrows(try await malformed.list()) { error in
            XCTAssertEqual(error as? RailgunScheduledServiceError, .invalidResponse)
        }

        let rejected = RailgunScheduledService { command in
            try scheduledRejectedResponse(command.type, error: "Bearer sensitive-token was rejected")
        }
        await assertScheduledThrows(try await rejected.list()) { error in
            guard case let .some(.rejected(message)) = error as? RailgunScheduledServiceError else {
                return XCTFail("Expected a rejected error")
            }
            XCTAssertFalse(message.contains("sensitive-token"))
        }
    }

    func testReducerInvalidatesLoadsAndRetainsRowsUntilDeleteAcknowledges() {
        let job = RailgunScheduledJob(id: "one", schedule: "0 9 * * *", prompt: "Run", lastRun: nil, lastStatus: nil, lastError: nil)
        var state = RailgunScheduledReducer.reduce(.initial, .loading(generation: 1))
        state = RailgunScheduledReducer.reduce(state, .mutationStarted)
        XCTAssertFalse(state.isLoading)
        state = RailgunScheduledReducer.reduce(state, .loaded(generation: 1, jobs: [job]))
        XCTAssertTrue(state.jobs.isEmpty)
        XCTAssertFalse(state.isLoading)
        state = RailgunScheduledReducer.reduce(state, .mutationFailed("Rejected"))
        XCTAssertFalse(state.isLoading)
        XCTAssertFalse(state.isMutating)
        state = RailgunScheduledReducer.reduce(state, .mutationStarted)
        state = RailgunScheduledReducer.reduce(state, .created(job))
        XCTAssertEqual(state.jobs, [job])
        state = RailgunScheduledReducer.reduce(state, .mutationStarted)
        state = RailgunScheduledReducer.reduce(state, .mutationFailed("Rejected"))
        XCTAssertEqual(state.jobs, [job])
        state = RailgunScheduledReducer.reduce(state, .mutationStarted)
        state = RailgunScheduledReducer.reduce(state, .removed(job.id))
        XCTAssertTrue(state.jobs.isEmpty)
    }

    func testPresentationAndFormHelpersAreDeterministic() {
        XCTAssertEqual(RailgunScheduledForm.normalized(prompt: " Run ", schedule: "0\t9  * * *").schedule, "0 9 * * *")
        XCTAssertEqual(RailgunScheduledForm.validationMessage(prompt: "Run", schedule: "0 9 * *"), "Use exactly five cron fields.")
        let failed = RailgunScheduledJob(id: "one", schedule: "0 9 * * *", prompt: "Run", lastRun: nil, lastStatus: .failed, lastError: "Nope")
        XCTAssertEqual(RailgunScheduledPresentation.statusText(for: failed), "Failed")
        XCTAssertEqual(RailgunScheduledPresentation.lastRunText(for: failed), "Not yet run")
    }

    func testDestinationLeavesTheActiveTaskSelectionUntouched() {
        var state = RailgunAppState.initial
        state = RailgunAppReducer.reduce(state, .session(.selected("saved-task")))
        state = RailgunAppReducer.reduce(state, .destination(.scheduled))
        XCTAssertEqual(state.destination, .scheduled)
        XCTAssertEqual(state.session.activeSessionID, "saved-task")
        state = RailgunAppReducer.reduce(state, .destination(.task))
        XCTAssertEqual(state.session.activeSessionID, "saved-task")
    }
}

private actor ScheduledCommandRecorder {
    private(set) var commands: [RailgunRPCCommand] = []
    func record(_ command: RailgunRPCCommand) { commands.append(command) }
}

private enum ScheduledTestError: Error { case unexpectedCommand }

private func scheduledJob(id: String, lastRun: Int?, status: String?, error: String?) -> RailgunJSONValue {
    var value: [String: RailgunJSONValue] = [
        "id": .string(id), "schedule": .string("0 9 * * *"), "prompt": .string("Run \(id)"),
        "lastRun": lastRun.map { .number(Double($0)) } ?? .null,
    ]
    if let status { value["lastStatus"] = .string(status) }
    if let error { value["lastError"] = .string(error) }
    return .object(value)
}

private func scheduledResponse(_ command: RailgunRPCCommandType, data: RailgunJSONValue? = nil) throws -> RailgunRPCResponse {
    var value: [String: RailgunJSONValue] = [
        "type": .string("response"), "command": .string(command.rawValue), "success": .bool(true),
    ]
    if let data { value["data"] = data }
    return try RailgunRPCResponse(data: JSONEncoder().encode(RailgunJSONValue.object(value)))
}

private func scheduledRejectedResponse(_ command: RailgunRPCCommandType, error: String) throws -> RailgunRPCResponse {
    try RailgunRPCResponse(data: JSONEncoder().encode(RailgunJSONValue.object([
        "type": .string("response"), "command": .string(command.rawValue), "success": .bool(false), "error": .string(error),
    ])))
}

@MainActor
private func assertScheduledThrows<T: Sendable>(
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
