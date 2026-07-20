import RailgunTransport
import XCTest
@testable import RailgunX

@MainActor
final class RailgunActivityPresentationTests: XCTestCase {
    func testKnownToolUsesStatusAwareActionAndBasenameTarget() {
        XCTAssertEqual(
            RailgunActivityPresentation.tool(
                name: "write_file",
                input: #"{"path":"apps/macos/Sources/RailgunX/RailgunXApp.swift"}"#,
                status: .success
            ),
            .init(action: "Edited", target: "RailgunXApp.swift", symbol: .fileEdit)
        )
        XCTAssertEqual(
            RailgunActivityPresentation.tool(
                name: "read_file",
                input: #"{"path":"README.md"}"#,
                status: .running
            ).action,
            "Reading"
        )
    }

    func testUnknownToolIsHumanizedWithoutSurfacingRawJSON() {
        XCTAssertEqual(
            RailgunActivityPresentation.tool(
                name: "custom-tool",
                input: #"{"private":"payload"}"#,
                status: .error
            ),
            .init(action: "Failed to run custom tool", target: nil, symbol: .tool)
        )
        XCTAssertNil(
            RailgunActivityPresentation.tool(
                name: "custom-tool",
                input: #"["private payload"]"#,
                status: .success
            ).target
        )
    }

    func testRestoredSafeTargetIsPreserved() {
        XCTAssertEqual(
            RailgunActivityPresentation.tool(
                name: "read_file",
                input: "notes.md",
                status: .success
            ).target,
            "notes.md"
        )
    }

    func testGroupingOnlyCombinesAdjacentSettledUsesOfTheSameTool() {
        let first = tool("one", "write_file", .success, order: 1)
        let second = tool("two", "write_file", .error, order: 2)
        let reference = RailgunActivityEntry.moaReference(
            id: "reference",
            index: 0,
            count: 1,
            model: "ref",
            status: .success,
            order: 3,
            preview: nil
        )
        let third = tool("three", "write_file", .running, order: 4)
        let fourth = tool("four", "write_file", .interrupted, order: 5)

        XCTAssertEqual(
            RailgunActivityGrouping.rows(for: [first, second, reference, third, fourth]),
            [
                .toolGroup(name: "write_file", status: .error, entries: [first, second]),
                .entry(reference),
                .entry(third),
                .entry(fourth),
            ]
        )
        XCTAssertEqual(RailgunActivityGrouping.status(for: [first, second, third, fourth]), .running)
    }

    func testGroupingKeepsConcurrentToolCallsAsIndividualLiveRows() {
        let first = tool("one", "read_file", .running, order: 1)
        let second = tool("two", "read_file", .running, order: 2)

        XCTAssertEqual(
            RailgunActivityGrouping.rows(for: [first, second]),
            [.entry(first), .entry(second)]
        )
    }

    func testTimelineMergesMessagesAndActivityByStoreOrder() {
        let user = message("user", .user, order: 1)
        let assistant = message("assistant", .assistant, order: 3)
        let activity = tool("tool", "read_file", .success, order: 2)

        XCTAssertEqual(
            RailgunTranscriptActivityPresentation.timeline(messages: [assistant, user], activity: [activity]),
            [.message(user), .activity(activity), .message(assistant)]
        )
    }

    func testSettledTurnActivityCollapsesToWorkedButActiveActivityStaysExpanded() {
        let user = message("user", .user, order: 1)
        let activity = tool("tool", "read_file", .success, order: 2)
        let assistant = message("assistant", .assistant, order: 3)
        let timeline: [RailgunTranscriptTimelineItem] = [.message(user), .activity(activity), .message(assistant)]

        XCTAssertEqual(
            RailgunTranscriptActivityPresentation.collapseSettledTurnActivity(timeline, isActive: false),
            [.entry(.message(user)), .worked([activity]), .entry(.message(assistant))]
        )
        XCTAssertEqual(
            RailgunTranscriptActivityPresentation.collapseSettledTurnActivity(timeline, isActive: true),
            [.entry(.message(user)), .entry(.activity(activity)), .entry(.message(assistant))]
        )
    }

    func testTranscriptRenderKeepsAdjacentActivityTogetherForToolGrouping() {
        let first = tool("first", "read_file", .success, order: 1)
        let second = tool("second", "read_file", .success, order: 2)

        XCTAssertEqual(
            RailgunTranscriptActivityPresentation.renderItems(
                from: [.entry(.activity(first)), .entry(.activity(second))]
            ),
            [.activityRows([first, second])]
        )
    }

    func testActivityIsWithheldWhenTheTaskDetailIsNotSelected() {
        let activity = RailgunActivityState(
            entries: [tool("tool", "read_file", .success, order: 1)],
            todos: [],
            isLoadingTodos: false,
            subagents: [],
            advisorNotes: []
        )

        XCTAssertEqual(
            RailgunTranscriptActivityPresentation.activity(for: .empty, from: activity),
            .initial
        )
        let selected = RailgunSessionSummary(
            id: "selected",
            model: "gpt-5",
            startedAt: "Today",
            messageCount: 1,
            firstUserPreview: "Inspect activity"
        )
        XCTAssertEqual(
            RailgunTranscriptActivityPresentation.activity(for: .selected(selected), from: activity),
            activity
        )
    }

    func testDashboardVisibilityAndSectionsFollowAdvisorTodosSubagentsOrder() {
        let state = RailgunActivityState(
            entries: [],
            todos: [.init(id: "done", content: "Ship", status: .completed), .init(id: "next", content: "Verify", status: .inProgress)],
            isLoadingTodos: false,
            subagents: [.init(index: 0, count: 1, goal: "Inspect", status: .completed, result: "Done")],
            advisorNotes: [.init(severity: .concern, text: "Check details", order: 1)]
        )
        let presentation = RailgunActivityDashboardPresentation(activity: state)

        XCTAssertTrue(presentation.isVisible)
        XCTAssertEqual(presentation.sections, [.advisor, .todos, .subagents])
        XCTAssertEqual(presentation.todoProgress, "1 of 2 complete")
    }

    func testDashboardShowsTodoLoadingWithoutTodosAndHidesWhenAllDataIsAbsent() {
        let loading = RailgunActivityDashboardPresentation(activity: .init(
            entries: [], todos: [], isLoadingTodos: true, subagents: [], advisorNotes: []
        ))
        XCTAssertTrue(loading.isVisible)
        XCTAssertEqual(loading.sections, [.todos])
        XCTAssertEqual(loading.todoProgress, "Updating todos…")
        XCTAssertFalse(RailgunActivityDashboardPresentation(activity: .initial).isVisible)
    }

    private func tool(_ id: String, _ name: String, _ status: RailgunActivityStatus, order: Int) -> RailgunActivityEntry {
        .tool(id: id, name: name, status: status, order: order, input: nil, output: nil)
    }

    private func message(_ id: String, _ role: RailgunTranscriptMessage.Role, order: Int) -> RailgunTranscriptMessage {
        .init(
            id: id,
            role: role,
            text: id,
            status: .complete,
            order: order,
            messageID: nil,
            branchable: false,
            startedAt: nil,
            completedAt: nil
        )
    }
}
