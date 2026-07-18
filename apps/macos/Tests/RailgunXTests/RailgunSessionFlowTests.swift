import Foundation
import XCTest
import RailgunTransport
@testable import RailgunX

@MainActor
final class RailgunSessionFlowTests: XCTestCase {
    func testSessionServiceListsActiveAndArchivedSessionsInBackendOrder() async throws {
        let service = RailgunSessionService { command in
            switch command.type {
            case .sessionList:
                return try response(
                    for: command.type,
                    data: .object(["sessions": .array([
                        summary(id: "newer", preview: "Newer task"),
                        summary(id: "older", preview: "Older task"),
                    ])])
                )
            case .sessionListArchived:
                return try response(
                    for: command.type,
                    data: .object(["sessions": .array([summary(id: "archived", preview: "Archived task")])])
                )
            default:
                XCTFail("Unexpected command: \(command.type)")
                return try response(for: command.type, data: .object([:]))
            }
        }

        let sessions = try await service.listSessions()
        let archived = try await service.listArchivedSessions()

        XCTAssertEqual(sessions.map(\.id), ["newer", "older"])
        XCTAssertEqual(archived.map(\.id), ["archived"])
    }

    func testSessionServiceRejectsMalformedSummaryWithoutUpdatingTheStore() async throws {
        let store = RailgunAppStore()
        let service = RailgunSessionService { command in
            try response(
                for: command.type,
                data: .object(["sessions": .array([.object(["id": .string("missing fields")])])])
            )
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)

        await coordinator.refresh()

        XCTAssertTrue(store.state.session.sessions.isEmpty)
        XCTAssertEqual(store.state.session.error, "The backend returned invalid task data.")
    }

    func testResumeHydratesPaginatedTranscriptStateAndSafeMetadataInBackendOrder() async throws {
        let store = RailgunAppStore()
        let selected = RailgunSessionSummary(
            id: "saved", model: "gpt-5", startedAt: "Today", messageCount: 3, firstUserPreview: "Resume me"
        )
        store.send(.session(.loaded([selected])))
        let service = RailgunSessionService { command in
            switch command.type {
            case .sessionLoad:
                XCTAssertEqual(command.fields["sessionId"], .string("saved"))
                XCTAssertEqual(command.fields["includeMessages"], .bool(false))
                return try response(for: command.type, data: .object(["sessionId": .string("saved")]))
            case .getState:
                return try response(for: command.type, data: .object([
                    "sessionId": .string("saved"),
                    "running": .bool(true),
                    "todos": .array([.object([
                        "id": .string("todo-1"),
                        "content": .string("Ship it"),
                        "status": .string("in_progress"),
                    ])]),
                ]))
            case .sessionTranscript:
                let cursor = command.fields["cursor"]?.integerValue
                XCTAssertEqual(command.fields["sessionId"], .string("saved"))
                XCTAssertEqual(command.fields["limit"]?.integerValue, 100)
                if cursor == 0 {
                    return try response(for: command.type, data: .object([
                        "sessionId": .string("saved"),
                        "messages": .array([
                            .object([
                                "role": .string("user"), "text": .string("Find it"),
                                "messageId": .number(10), "startedAt": .number(100),
                            ]),
                            .object([
                                "role": .string("tool"), "id": .string("tool-1"),
                                "name": .string("read_file"), "failed": .bool(false), "target": .string("notes.md"),
                            ]),
                        ]),
                        "nextCursor": .number(2),
                    ]))
                }
                XCTAssertEqual(cursor, 2)
                return try response(for: command.type, data: .object([
                    "sessionId": .string("saved"),
                    "messages": .array([.object([
                        "role": .string("assistant"), "text": .string("Found it"),
                        "messageId": .number(12), "branchable": .bool(true), "completedAt": .number(120),
                    ])]),
                ]))
            default:
                XCTFail("Unexpected command: \(command.type)")
                return try response(for: command.type, data: .object([:]))
            }
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)

        await coordinator.resume("saved")

        XCTAssertEqual(store.state.session.activeSessionID, "saved")
        XCTAssertEqual(store.state.transcript.messages.map(\.text), ["Find it", "Found it"])
        XCTAssertEqual(store.state.transcript.messages.map(\.order), [1, 3])
        XCTAssertEqual(store.state.transcript.messages.first?.startedAt, 100)
        XCTAssertEqual(store.state.transcript.messages.last?.completedAt, 120)
        XCTAssertEqual(store.state.transcript.messages.last?.messageID, 12)
        XCTAssertTrue(store.state.transcript.messages.last?.branchable ?? false)
        XCTAssertEqual(store.state.transcript.nextOrder, 4)
        XCTAssertTrue(store.state.transcript.isRunning)
        XCTAssertEqual(store.state.activity.entries, [
            .tool(id: "tool-1", name: "read_file", status: .success, order: 2, input: "notes.md", output: nil),
        ])
        XCTAssertEqual(store.state.activity.todos, [.init(id: "todo-1", content: "Ship it", status: .inProgress)])
        XCTAssertNil(store.state.session.error)
    }

    func testResumeRejectsStalledTranscriptWithoutReplacingCurrentState() async throws {
        let store = RailgunAppStore()
        store.send(.session(.created(id: "current", model: nil)))
        store.send(.transcript(.submit(id: "user", text: "Keep this", at: 1)))
        let original = store.state
        let service = RailgunSessionService { command in
            switch command.type {
            case .sessionLoad:
                return try response(for: command.type, data: .object(["sessionId": .string("saved")]))
            case .getState:
                return try response(for: command.type, data: .object([
                    "sessionId": .string("saved"), "running": .bool(false), "todos": .array([]),
                ]))
            case .sessionTranscript:
                return try response(for: command.type, data: .object([
                    "sessionId": .string("saved"), "messages": .array([]), "nextCursor": .number(0),
                ]))
            default:
                throw ResumeStubError.unexpectedCommand
            }
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)

        await coordinator.resume("saved")

        XCTAssertEqual(store.state.transcript, original.transcript)
        XCTAssertEqual(store.state.activity, original.activity)
        XCTAssertEqual(store.state.session.activeSessionID, original.session.activeSessionID)
        XCTAssertEqual(store.state.session.error, "The backend returned invalid task data.")
    }

    func testResumeRejectsEmptyAdvancingTranscriptPageWithoutReplacingCurrentState() async throws {
        let store = RailgunAppStore()
        store.send(.session(.created(id: "current", model: nil)))
        let original = store.state
        let service = RailgunSessionService { command in
            switch command.type {
            case .sessionLoad:
                return try response(for: command.type, data: .object(["sessionId": .string("saved")]))
            case .getState:
                return try response(for: command.type, data: .object([
                    "sessionId": .string("saved"), "running": .bool(false), "todos": .array([]),
                ]))
            case .sessionTranscript:
                return try response(for: command.type, data: .object([
                    "sessionId": .string("saved"), "messages": .array([]), "nextCursor": .number(1),
                ]))
            default:
                throw ResumeStubError.unexpectedCommand
            }
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)

        await coordinator.resume("saved")

        XCTAssertEqual(store.state.transcript, original.transcript)
        XCTAssertEqual(store.state.session.activeSessionID, original.session.activeSessionID)
        XCTAssertEqual(store.state.session.error, "The backend returned invalid task data.")
    }

    func testResumeRejectsRoleIncompatibleTranscriptTimestampsWithoutReplacingCurrentState() async throws {
        let invalidEntries: [RailgunJSONValue] = [
            .object([
                "role": .string("assistant"), "text": .string("Invalid timing"), "startedAt": .number(1),
            ]),
            .object([
                "role": .string("user"), "text": .string("Invalid timing"), "completedAt": .number(1),
            ]),
        ]

        for invalidEntry in invalidEntries {
            let store = RailgunAppStore()
            store.send(.session(.created(id: "current", model: nil)))
            let original = store.state
            let service = RailgunSessionService { command in
                switch command.type {
                case .sessionLoad:
                    return try response(for: command.type, data: .object(["sessionId": .string("saved")]))
                case .getState:
                    return try response(for: command.type, data: .object([
                        "sessionId": .string("saved"), "running": .bool(false), "todos": .array([]),
                    ]))
                case .sessionTranscript:
                    return try response(for: command.type, data: .object([
                        "sessionId": .string("saved"), "messages": .array([invalidEntry]),
                    ]))
                default:
                    throw ResumeStubError.unexpectedCommand
                }
            }
            let coordinator = RailgunSessionCoordinator(store: store, service: service)

            await coordinator.resume("saved")

            XCTAssertEqual(store.state.transcript, original.transcript)
            XCTAssertEqual(store.state.session.activeSessionID, original.session.activeSessionID)
            XCTAssertEqual(store.state.session.error, "The backend returned invalid task data.")
        }
    }

    func testNewSessionResetsFeatureStateWithoutAddingAnUnsavedSessionToTheList() async throws {
        let store = RailgunAppStore()
        store.send(.transcript(.submit(id: "user", text: "Discard this", at: nil)))
        store.send(.activity(.toolStarted(id: "tool", name: "read_file", input: nil)))
        let service = RailgunSessionService { command in
            XCTAssertEqual(command.type, .sessionNew)
            XCTAssertEqual(command.fields["modelId"], .string("gpt-5-mini"))
            return try response(for: command.type, data: .object(["sessionId": .string("fresh")]))
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)

        await coordinator.create(modelID: "gpt-5-mini")

        XCTAssertEqual(store.state.session.activeSessionID, "fresh")
        XCTAssertEqual(store.state.session.selectedSession?.model, "gpt-5-mini")
        XCTAssertFalse(store.state.session.selectedSession?.isPersisted ?? true)
        XCTAssertTrue(store.state.session.sessions.isEmpty)
        XCTAssertEqual(store.state.transcript, .initial)
        XCTAssertEqual(store.state.activity, .initial)
    }

    func testSuccessfulSessionOperationClearsThePreviouslyPresentedError() async throws {
        let store = RailgunAppStore()
        let service = RailgunSessionService { command in
            XCTAssertEqual(command.type, .sessionNew)
            return try response(for: command.type, data: .object(["sessionId": .string("fresh")]))
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)
        store.send(.session(.failed(message: "The task request was rejected.")))

        await coordinator.create()

        XCTAssertNil(store.state.session.error)
    }

    func testArchiveAndRestoreRefreshBothSessionLists() async throws {
        let store = RailgunAppStore()
        let active = RailgunSessionSummary(
            id: "active", model: "gpt-5", startedAt: "Today", messageCount: 1, firstUserPreview: "Archive me"
        )
        store.send(.session(.loaded([active])))
        store.send(.session(.selected("active")))

        let repository = SessionRepositoryStub()
        let service = RailgunSessionService { command in
            try await repository.respond(to: command)
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)

        await coordinator.archive("active")
        XCTAssertEqual(store.state.session.activeSessionID, "fresh")
        XCTAssertTrue(store.state.session.sessions.isEmpty)
        XCTAssertEqual(store.state.session.archivedSessions.map(\.id), ["archived"])

        await coordinator.restore("archived")
        XCTAssertEqual(store.state.session.sessions.map(\.id), ["archived"])
        XCTAssertTrue(store.state.session.archivedSessions.isEmpty)
    }
}

private enum ResumeStubError: Error { case unexpectedCommand }

private func summary(id: String, preview: String) -> RailgunJSONValue {
    .object([
        "id": .string(id),
        "model": .string("gpt-5"),
        "startedAtLocal": .string("Today"),
        "messageCount": .number(2),
        "firstUserPreview": .string(preview),
    ])
}

private func response(for command: RailgunRPCCommandType, data: RailgunJSONValue) throws -> RailgunRPCResponse {
    try .init(data: JSONEncoder().encode(RailgunJSONValue.object([
        "type": .string("response"),
        "command": .string(command.rawValue),
        "success": .bool(true),
        "data": data,
    ])))
}

private actor SessionRepositoryStub {
    private var isArchived = false

    func respond(to command: RailgunRPCCommand) throws -> RailgunRPCResponse {
        switch command.type {
        case .sessionArchive:
            guard command.fields["sessionId"] == .string("active") else { throw StubError.unexpectedCommand }
            isArchived = true
            return try response(for: command.type, data: .object(["sessionId": .string("fresh")]))
        case .sessionUnarchive:
            guard command.fields["sessionId"] == .string("archived") else { throw StubError.unexpectedCommand }
            isArchived = false
            return try response(for: command.type, data: .object(["sessionId": .string("fresh")]))
        case .sessionList:
            let sessions: [RailgunJSONValue] = isArchived ? [] : [summary(id: "archived", preview: "Restored task")]
            return try response(for: command.type, data: .object(["sessions": .array(sessions)]))
        case .sessionListArchived:
            let sessions: [RailgunJSONValue] = isArchived ? [summary(id: "archived", preview: "Archived task")] : []
            return try response(for: command.type, data: .object(["sessions": .array(sessions)]))
        default:
            throw StubError.unexpectedCommand
        }
    }

    private enum StubError: Error { case unexpectedCommand }
}
