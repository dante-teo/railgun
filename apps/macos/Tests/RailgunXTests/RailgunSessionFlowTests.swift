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

    func testResumeLoadsTheSelectedSessionBeforeHydratingAnEmptyTranscript() async throws {
        let store = RailgunAppStore()
        let selected = RailgunSessionSummary(
            id: "saved", model: "gpt-5", startedAt: "Today", messageCount: 2, firstUserPreview: "Resume me"
        )
        store.send(.session(.loaded([selected])))
        let service = RailgunSessionService { command in
            XCTAssertEqual(command.type, .sessionLoad)
            XCTAssertEqual(command.fields["sessionId"], .string("saved"))
            XCTAssertEqual(command.fields["includeMessages"], .bool(false))
            return try response(for: command.type, data: .object(["sessionId": .string("saved")]))
        }
        let coordinator = RailgunSessionCoordinator(store: store, service: service)

        await coordinator.resume("saved")

        XCTAssertEqual(store.state.session.activeSessionID, "saved")
        XCTAssertEqual(store.state.transcript, .initial)
        XCTAssertNil(store.state.session.error)
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
