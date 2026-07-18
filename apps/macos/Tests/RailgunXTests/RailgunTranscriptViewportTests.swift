import XCTest
@testable import RailgunX

@MainActor
final class RailgunTranscriptViewportTests: XCTestCase {
    func testBottomDetectionUsesFourPointTolerance() {
        XCTAssertTrue(
            RailgunTranscriptFollowState.isAtBottom(
                contentHeight: 1_000,
                viewportHeight: 300,
                contentOffsetY: 696
            )
        )
        XCTAssertFalse(
            RailgunTranscriptFollowState.isAtBottom(
                contentHeight: 1_000,
                viewportHeight: 300,
                contentOffsetY: 695.9
            )
        )
    }

    func testInitialAndSessionResetFollowLatestWithoutShowingACue() {
        XCTAssertEqual(
            RailgunTranscriptFollowState.initial,
            .init(isFollowingLatest: true, showsJumpToLatest: false)
        )
        XCTAssertEqual(RailgunTranscriptFollowState.sessionDidChange(), .initial)
    }

    func testManualScrollPausesFollowingAndNewContentShowsJumpCue() {
        let paused = RailgunTranscriptFollowState.scrollPositionDidChange(.initial, isAtBottom: false)

        XCTAssertEqual(paused, .init(isFollowingLatest: false, showsJumpToLatest: false))
        XCTAssertEqual(
            RailgunTranscriptFollowState.contentDidChange(paused),
            .init(isFollowingLatest: false, showsJumpToLatest: true)
        )
    }

    func testContentUpdateKeepsFollowingStateWhenAlreadyAtBottom() {
        XCTAssertEqual(RailgunTranscriptFollowState.contentDidChange(.initial), .initial)
    }

    func testFollowMaintainsBottomForContentAndViewportSizeChanges() {
        XCTAssertTrue(
            RailgunTranscriptFollowState.shouldMaintainFollow(
                .initial,
                previousContentHeight: 500,
                previousViewportHeight: 300,
                contentHeight: 520,
                viewportHeight: 300
            )
        )
        XCTAssertTrue(
            RailgunTranscriptFollowState.shouldMaintainFollow(
                .initial,
                previousContentHeight: 500,
                previousViewportHeight: 300,
                contentHeight: 500,
                viewportHeight: 320
            )
        )
        XCTAssertTrue(
            RailgunTranscriptFollowState.shouldMaintainFollow(
                .initial,
                previousContentHeight: 500,
                previousViewportHeight: 300,
                contentHeight: 500,
                viewportHeight: 240
            )
        )
        XCTAssertFalse(
            RailgunTranscriptFollowState.shouldMaintainFollow(
                .initial,
                previousContentHeight: 500,
                previousViewportHeight: 300,
                contentHeight: 500,
                viewportHeight: 300
            )
        )
        XCTAssertFalse(
            RailgunTranscriptFollowState.shouldMaintainFollow(
                .scrollPositionDidChange(.initial, isAtBottom: false),
                previousContentHeight: 500,
                previousViewportHeight: 300,
                contentHeight: 520,
                viewportHeight: 320
            )
        )
    }

    func testUndersizedTranscriptsUseBottomAlignment() {
        XCTAssertEqual(RailgunTranscriptViewport.undersizedContentAlignment, .bottom)
    }

    func testScrollIndicatorUsesACompactLeftRailOnlyForScrollableContent() {
        XCTAssertEqual(
            RailgunTranscriptScrollIndicatorPresentation.make(
                contentHeight: 300,
                viewportHeight: 300,
                contentOffsetY: 0
            ),
            .initial
        )

        let indicator = RailgunTranscriptScrollIndicatorPresentation.make(
            contentHeight: 1_260,
            viewportHeight: 300,
            contentOffsetY: 480
        )

        XCTAssertEqual(indicator.dashCount, 14)
        XCTAssertEqual(indicator.progress, 0.5)
        XCTAssertEqual(indicator.activeDashIndexes, [5, 6, 7, 8])
    }

    func testScrollIndicatorCapsItsDensityAndTracksTheBottom() {
        let indicator = RailgunTranscriptScrollIndicatorPresentation.make(
            contentHeight: 10_000,
            viewportHeight: 300,
            contentOffsetY: 9_700
        )

        XCTAssertEqual(indicator.dashCount, RailgunTranscriptScrollIndicatorPresentation.maximumDashCount)
        XCTAssertEqual(indicator.activeDashIndexes, [20, 21, 22, 23])
    }

    func testJumpingOrManuallyReturningToBottomRefollowsAndClearsCue() {
        let pausedWithCue = RailgunTranscriptFollowState.contentDidChange(
            .scrollPositionDidChange(.initial, isAtBottom: false)
        )

        XCTAssertEqual(RailgunTranscriptFollowState.jumpToLatest(), .initial)
        XCTAssertEqual(
            RailgunTranscriptFollowState.scrollPositionDidChange(pausedWithCue, isAtBottom: true),
            .initial
        )
    }

    func testSelectedHydratedSessionSuppliesOrderedMessagesToTranscript() {
        let session = RailgunSessionSummary(
            id: "saved-session",
            model: "gpt-5",
            startedAt: "Today",
            messageCount: 2,
            firstUserPreview: "First request"
        )
        let sessionState = RailgunSessionState(
            activeSessionID: session.id,
            sessions: [session],
            archivedSessions: [],
            isLoading: false
        )
        let transcript = RailgunTranscriptReducer.hydrate([
            .message(role: .user, text: "First request", messageID: 1),
            .tool(id: "tool-1", name: "read_file", failed: false),
            .message(role: .assistant, text: "**Plain response**", messageID: 2),
        ], isRunning: false)

        XCTAssertEqual(RailgunTaskDetailPresentation(session: sessionState), .selected(session))
        XCTAssertEqual(
            RailgunTranscriptViewport.orderedMessages(in: transcript).map(\.text),
            ["First request", "**Plain response**"]
        )
        XCTAssertEqual(
            RailgunTranscriptViewport.orderedMessages(in: transcript).map(\.order),
            [1, 3]
        )
    }

    func testOrderedMessagesPreservesSourceOrderWhenOrdersMatch() {
        let first = message(id: "first", order: 2)
        let second = message(id: "second", order: 2)
        let transcript = RailgunTranscriptState(
            messages: [second, first],
            queue: [],
            isRunning: false,
            isStopping: false,
            submissionError: nil,
            activeRun: nil,
            failedRun: nil,
            nextOrder: 3
        )

        XCTAssertEqual(
            RailgunTranscriptViewport.orderedMessages(in: transcript).map(\.id),
            ["second", "first"]
        )
    }

    func testStatusVariantsHaveNativeLabelPresentations() {
        XCTAssertEqual(RailgunTranscriptStatusPresentation(status: .streaming)?.title, "Streaming")
        XCTAssertEqual(RailgunTranscriptStatusPresentation(status: .failed)?.title, "Failed")
        XCTAssertEqual(RailgunTranscriptStatusPresentation(status: .stopped)?.title, "Stopped")
        XCTAssertNil(RailgunTranscriptStatusPresentation(status: .complete))
    }

    private func message(id: String, order: Int) -> RailgunTranscriptMessage {
        .init(
            id: id,
            role: .assistant,
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
