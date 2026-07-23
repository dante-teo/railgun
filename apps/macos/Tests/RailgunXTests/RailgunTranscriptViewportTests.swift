import AppKit
import SwiftUI
import XCTest
@testable import RailgunX

@MainActor
final class RailgunTranscriptViewportTests: XCTestCase {
    func testScrollGeometryIncludesTheBottomContentInset() {
        XCTAssertTrue(
            RailgunScrollGeometry(
                contentHeight: 1_000,
                viewportWidth: 600,
                viewportHeight: 300,
                visibleMaxY: 1_016,
                bottomContentInset: 20
            ).isAtBottom
        )
        XCTAssertFalse(
            RailgunScrollGeometry(
                contentHeight: 1_000,
                viewportWidth: 600,
                viewportHeight: 300,
                visibleMaxY: 1_015.9,
                bottomContentInset: 20
            ).isAtBottom
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

    func testStreamingGrowthReanchorsEvenWhenWithinBottomTolerance() {
        let contentHeight = CGFloat(1_002)
        let viewportHeight = CGFloat(300)
        let offsetWithResidualGap = CGFloat(698)

        XCTAssertTrue(RailgunScrollGeometry(
            contentHeight: contentHeight,
            viewportWidth: 600,
            viewportHeight: viewportHeight,
            visibleMaxY: offsetWithResidualGap + viewportHeight,
            bottomContentInset: 0
        ).isAtBottom)
        XCTAssertTrue(
            RailgunTranscriptFollowState.shouldMaintainFollow(
                .initial,
                previousContentHeight: 1_000,
                previousViewportHeight: viewportHeight,
                contentHeight: contentHeight,
                viewportHeight: viewportHeight
            )
        )
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

    func testHostedTranscriptStartsAndStaysAtTheNativeBottomAsContentGrows() async throws {
        let model = TranscriptScrollHarnessModel()
        let hostingView = NSHostingView(rootView: TranscriptScrollHarness(model: model))
        hostingView.frame = NSRect(x: 0, y: 0, width: 480, height: 240)

        let window = NSWindow(
            contentRect: hostingView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = hostingView

        try await settle(hostingView)
        let scrollView = try XCTUnwrap(firstScrollView(in: hostingView))
        XCTAssertTrue(isAtNativeBottom(scrollView), "The initial transcript must render at the bottom.")

        model.rowCount += 20
        try await settle(hostingView)
        XCTAssertTrue(isAtNativeBottom(scrollView), "A followed transcript must stay at the bottom after growth.")
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
            RailgunTranscriptOrdering.orderedMessages(in: transcript).map(\.text),
            ["First request", "**Plain response**"]
        )
        XCTAssertEqual(
            RailgunTranscriptOrdering.orderedMessages(in: transcript).map(\.order),
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
            RailgunTranscriptOrdering.orderedMessages(in: transcript).map(\.id),
            ["second", "first"]
        )
    }

    func testStatusVariantsHaveNativeLabelPresentations() {
        XCTAssertEqual(RailgunTranscriptStatusPresentation(status: .streaming)?.title, "Streaming")
        XCTAssertEqual(RailgunTranscriptStatusPresentation(status: .failed)?.title, "Failed")
        XCTAssertEqual(RailgunTranscriptStatusPresentation(status: .stopped)?.title, "Stopped")
        XCTAssertNil(RailgunTranscriptStatusPresentation(status: .complete))
    }

    func testBranchAffordanceRequiresAPersistedIdleTaskAndLaterVisibleContent() {
        let candidate = RailgunTranscriptMessage(
            id: "candidate", role: .assistant, text: "Boundary", status: .complete,
            order: 2, messageID: 12, branchable: true, startedAt: nil, completedAt: nil
        )
        let later = RailgunTranscriptMessage(
            id: "later", role: .user, text: "Later", status: .complete,
            order: 3, messageID: 13, branchable: false, startedAt: nil, completedAt: nil
        )
        let persisted = RailgunSessionSummary(
            id: "saved", model: "gpt-5", startedAt: "Today", messageCount: 3, firstUserPreview: "Task"
        )
        let session = RailgunSessionState(
            activeSessionID: "saved", sessions: [persisted], archivedSessions: [], isLoading: false
        )

        XCTAssertTrue(RailgunBranchAffordance.isAvailable(
            for: candidate, in: [candidate, later], session: session,
            isRunActive: false, isTaskLocked: false, isBranchInFlight: false
        ))
        XCTAssertFalse(RailgunBranchAffordance.isAvailable(
            for: candidate, in: [candidate], session: session,
            isRunActive: false, isTaskLocked: false, isBranchInFlight: false
        ))
        XCTAssertFalse(RailgunBranchAffordance.isAvailable(
            for: candidate, in: [candidate, later], session: session,
            isRunActive: true, isTaskLocked: false, isBranchInFlight: false
        ))
        XCTAssertFalse(RailgunBranchAffordance.isAvailable(
            for: candidate, in: [candidate, later], session: session,
            isRunActive: false, isTaskLocked: true, isBranchInFlight: false
        ))
        XCTAssertFalse(RailgunBranchAffordance.isAvailable(
            for: candidate, in: [candidate, later], session: session,
            isRunActive: false, isTaskLocked: false, isBranchInFlight: true
        ))

        let unsaved = RailgunSessionState(
            activeSessionID: "saved",
            sessions: [],
            archivedSessions: [],
            isLoading: false,
            activeSession: .init(id: "saved", model: "gpt-5", startedAt: "Now", messageCount: 3, firstUserPreview: "Task", isPersisted: false)
        )
        XCTAssertFalse(RailgunBranchAffordance.isAvailable(
            for: candidate, in: [candidate, later], session: unsaved,
            isRunActive: false, isTaskLocked: false, isBranchInFlight: false
        ))
        XCTAssertFalse(RailgunBranchAffordance.isAvailable(
            for: .init(id: "not-branchable", role: .assistant, text: "No", status: .complete, order: 2, messageID: 12, branchable: false, startedAt: nil, completedAt: nil),
            in: [candidate, later], session: session,
            isRunActive: false, isTaskLocked: false, isBranchInFlight: false
        ))
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

    private func settle(_ view: NSView) async throws {
        for _ in 0..<4 {
            view.layoutSubtreeIfNeeded()
            await Task.yield()
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    private func firstScrollView(in view: NSView) -> NSScrollView? {
        if let scrollView = view as? NSScrollView { return scrollView }
        return view.subviews.lazy.compactMap(firstScrollView(in:)).first
    }

    private func isAtNativeBottom(_ scrollView: NSScrollView, tolerance: CGFloat = 4) -> Bool {
        guard let documentView = scrollView.documentView else { return false }
        let visible = scrollView.documentVisibleRect
        let document = documentView.bounds
        let distance = documentView.isFlipped
            ? document.maxY - visible.maxY
            : visible.minY - document.minY
        return abs(distance) <= tolerance
    }
}

@MainActor
private final class TranscriptScrollHarnessModel: ObservableObject {
    @Published var rowCount = 80
}

private struct TranscriptScrollHarness: View {
    @ObservedObject var model: TranscriptScrollHarnessModel

    var body: some View {
        RailgunTranscriptScrollView(
            sessionID: "test-session",
            contentRevision: model.rowCount,
            contentLeadingMargin: 0,
            hasScrollableContent: true
        ) {
            LazyVStack(spacing: 0) {
                ForEach(0..<model.rowCount, id: \.self) { row in
                    Text("Transcript row \(row)")
                        .frame(maxWidth: .infinity, minHeight: 24)
                }
            }
        }
    }
}
