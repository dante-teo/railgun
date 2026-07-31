import AppKit
import SwiftUI
import XCTest
@testable import RailgunUI
@testable import RailgunX

@MainActor
final class RailgunMarkdownMessageTests: XCTestCase {
    func testStreamSourceEmitsInitialAndOrderedFullSnapshots() async {
        let source = RailgunMarkdownStreamSource(markdown: "One", isComplete: false)
        var iterator = source.text.makeAsyncIterator()

        let initial = await iterator.next()
        XCTAssertEqual(initial, "One")

        source.update(markdown: "One two", isComplete: false)
        let second = await iterator.next()
        XCTAssertEqual(second, "One two")

        source.update(markdown: "One two three", isComplete: false)
        let third = await iterator.next()
        XCTAssertEqual(third, "One two three")
    }

    func testStreamSourceBuffersOnlyNewestPendingSnapshot() async {
        let source = RailgunMarkdownStreamSource(markdown: "One", isComplete: false)
        var iterator = source.text.makeAsyncIterator()
        let initial = await iterator.next()
        XCTAssertEqual(initial, "One")

        source.update(markdown: "One two", isComplete: false)
        source.update(markdown: "One two three", isComplete: false)

        let newest = await iterator.next()
        XCTAssertEqual(newest, "One two three")
    }

    func testStreamSourceDeduplicatesAndFinishes() async {
        let source = RailgunMarkdownStreamSource(markdown: "Final", isComplete: false)
        var iterator = source.text.makeAsyncIterator()
        let initial = await iterator.next()
        XCTAssertEqual(initial, "Final")

        source.update(markdown: "Final", isComplete: false)
        source.update(markdown: "Final", isComplete: true)

        let completion = await iterator.next()
        XCTAssertNil(completion)
    }

    func testCompletedStreamReplaysFinalSnapshotToLateSubscriber() async {
        let source = RailgunMarkdownStreamSource(markdown: "Partial", isComplete: false)
        source.update(markdown: "Complete", isComplete: true)

        var iterator = source.text.makeAsyncIterator()
        let replay = await iterator.next()
        XCTAssertEqual(replay, "Complete")
        let completion = await iterator.next()
        XCTAssertNil(completion)
    }

    func testStreamingSnapshotTemporarilyCompletesPartialStrongMarkup() {
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "A **partial response",
                isStreaming: true
            ),
            "A **partial response**"
        )
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "A **complete response**",
                isStreaming: true
            ),
            "A **complete response**"
        )
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "`**literal code`",
                isStreaming: true
            ),
            "`**literal code`"
        )
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "\\**escaped delimiter",
                isStreaming: true
            ),
            "\\**escaped delimiter"
        )
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "```\n**literal code\n```",
                isStreaming: true
            ),
            "```\n**literal code\n```"
        )
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "A **stopped response",
                isStreaming: false
            ),
            "A **stopped response"
        )
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "Use **/*.swift",
                isStreaming: true
            ),
            "Use **/*.swift"
        )
        XCTAssertEqual(
            RailgunMarkdownStreamingSnapshot.prepare(
                "~~~swift\nlet glob = \"**/*.swift\"\n",
                isStreaming: true
            ),
            "~~~swift\nlet glob = \"**/*.swift\"\n"
        )
    }

    func testThemeAnimatesOnlyStreamingContentAndAllowsRemoteHTTPSImages() {
        let streaming = RailgunMarkdownTheme.configuration(
            isStreaming: true,
            contextActions: []
        )
        let completed = RailgunMarkdownTheme.configuration(
            isStreaming: false,
            contextActions: []
        )

        XCTAssertTrue(streaming.shouldAnimateText)
        XCTAssertFalse(completed.shouldAnimateText)
        XCTAssertFalse(streaming.citationConfig.isEnabled)
        XCTAssertTrue(streaming.textSelectionConfig.isEnabled)
        XCTAssertTrue(streaming.imageConfig.enabled)
        XCTAssertEqual(
            streaming.imageConfig.allowedImageTypes,
            [.remote(allowedDomains: [])]
        )
    }

    func testOnlyCredentialFreeAbsoluteHTTPSDestinationsAreAllowed() {
        XCTAssertEqual(
            RailgunMarkdownDestination.validatedURL("https://example.com/path"),
            URL(string: "https://example.com/path")
        )
        XCTAssertNil(RailgunMarkdownDestination.validatedURL("http://example.com"))
        XCTAssertNil(RailgunMarkdownDestination.validatedURL("/relative"))
        XCTAssertNil(RailgunMarkdownDestination.validatedURL("javascript:alert(1)"))
        XCTAssertNil(
            RailgunMarkdownDestination.validatedURL(
                "https://user:password@example.com"
            )
        )
    }

    func testContextActionListenerRoutesTheSelectedIdentifier() async {
        let listener = RailgunMarkdownListener()
        var selectedAction: String?
        listener.replaceContextActions([
            RailgunMarkdownContextAction(
                id: "branch",
                title: "Branch from this message"
            ) {
                selectedAction = "branch"
            }
        ])

        await listener.onContextMenuTap(id: "branch", selectedContent: "")

        XCTAssertEqual(selectedAction, "branch")
    }

    func testTableCopyListenerWritesMarkdownToThePasteboard() async {
        let listener = RailgunMarkdownListener()
        let markdown = "| Name | State |\n| --- | --- |\n| Railgun | Ready |"

        await listener.onTableCopyTap(content: markdown)

        XCTAssertEqual(
            NSPasteboard.general.string(forType: .string),
            markdown
        )
    }

    func testPartialEmphasisRendersAsSelectableRichTextWhileStreaming() async throws {
        let model = MarkdownStreamingHarnessModel(markdown: "**partial", isStreaming: true)
        let hostingView = NSHostingView(rootView: MarkdownStreamingHarness(model: model))
        hostingView.frame = NSRect(x: 0, y: 0, width: 480, height: 240)

        let window = NSWindow(
            contentRect: hostingView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = hostingView

        let partialTextView = try await waitForTextView(in: hostingView) {
            $0.string.contains("partial")
        }
        XCTAssertFalse(partialTextView.string.contains("**"))
        XCTAssertTrue(partialTextView.isSelectable)

        model.markdown = "**partial response**"
        model.isStreaming = false

        let completedTextView = try await waitForTextView(in: hostingView) {
            $0.string.contains("partial response")
        }
        XCTAssertFalse(completedTextView.string.contains("**"))
        XCTAssertTrue(completedTextView.isSelectable)
    }

    func testRawHTMLRemainsVisibleAsLiteralText() async throws {
        let model = MarkdownStreamingHarnessModel(
            markdown: "Use <path> safely.\n\n<details>Hidden details</details>",
            isStreaming: false
        )
        let hostingView = NSHostingView(rootView: MarkdownStreamingHarness(model: model))
        hostingView.frame = NSRect(x: 0, y: 0, width: 480, height: 240)

        let window = NSWindow(
            contentRect: hostingView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = hostingView

        _ = try await waitForTextView(in: hostingView) {
            $0.string.contains("Use <path> safely.")
        }
        _ = try await waitForTextView(in: hostingView) {
            $0.string.contains("<details>Hidden details</details>")
        }
    }

    func testHostedRendererAcceptsGrowingCodeListsAndTables() async throws {
        let model = MarkdownStreamingHarnessModel(
            markdown: "Preparing streamed blocks",
            isStreaming: true
        )
        let hostingView = NSHostingView(rootView: MarkdownStreamingHarness(model: model))
        hostingView.frame = NSRect(x: 0, y: 0, width: 560, height: 360)

        let window = NSWindow(
            contentRect: hostingView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = hostingView

        _ = try await waitForTextView(in: hostingView) {
            $0.string.contains("Preparing streamed blocks")
        }

        // Code blocks and ordinary table cells are native SwiftUI Text views,
        // unlike the renderer's selectable paragraph/list NSTextViews.
        model.markdown = "```swift\nlet streamedValue ="
        try await waitForTextViewsToDisappear(in: hostingView)
        XCTAssertGreaterThan(hostingView.fittingSize.height, 0)

        model.markdown = """
        ```swift
        let streamedValue = true
        ```

        - First item
        - **Second item
        """
        _ = try await waitForTextView(in: hostingView) {
            $0.string.contains("Second item")
        }

        model.markdown = """
        | Name | State |
        | --- | --- |
        | Railgun | Stream
        """
        try await waitForTextViewsToDisappear(in: hostingView)
        XCTAssertGreaterThan(hostingView.fittingSize.height, 0)

        model.markdown += "ing |\n\nRendered final table"
        model.isStreaming = false
        _ = try await waitForTextView(in: hostingView) {
            $0.string.contains("Rendered final table")
        }
    }

    func testEveryAssistantStatusUsesMarkdownWhileUserMessagesRemainLiteral() {
        let assistantStatuses: [RailgunMessageStatus] = [
            .streaming,
            .complete,
            .failed,
            .stopped,
        ]

        for status in assistantStatuses {
            XCTAssertTrue(
                RailgunTranscriptMessageRendering.usesMarkdown(
                    transcriptMessage(role: .assistant, status: status)
                )
            )
        }
        XCTAssertFalse(
            RailgunTranscriptMessageRendering.usesMarkdown(
                transcriptMessage(role: .user, status: .complete)
            )
        )
    }

    private func waitForTextView(
        in root: NSView,
        matching predicate: (NSTextView) -> Bool
    ) async throws -> NSTextView {
        for _ in 0..<80 {
            root.layoutSubtreeIfNeeded()
            if let match = textViews(in: root).first(where: predicate) {
                return match
            }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw MarkdownHarnessError.textViewNotFound(
            renderedText: textViews(in: root).map(\.string)
        )
    }

    private func textViews(in view: NSView) -> [NSTextView] {
        let current = (view as? NSTextView).map { [$0] } ?? []
        return current + view.subviews.flatMap(textViews(in:))
    }

    private func waitForTextViewsToDisappear(in root: NSView) async throws {
        for _ in 0..<80 {
            root.layoutSubtreeIfNeeded()
            if textViews(in: root).isEmpty {
                return
            }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw MarkdownHarnessError.textViewsStillPresent(
            renderedText: textViews(in: root).map(\.string)
        )
    }

    private func transcriptMessage(
        role: RailgunTranscriptMessage.Role,
        status: RailgunMessageStatus
    ) -> RailgunTranscriptMessage {
        RailgunTranscriptMessage(
            id: "\(role)-\(status)",
            role: role,
            text: "Message",
            status: status,
            order: 1,
            messageID: nil,
            branchable: false,
            startedAt: nil,
            completedAt: nil
        )
    }
}

@MainActor
private final class MarkdownStreamingHarnessModel: ObservableObject {
    @Published var markdown: String
    @Published var isStreaming: Bool

    init(markdown: String, isStreaming: Bool) {
        self.markdown = markdown
        self.isStreaming = isStreaming
    }
}

private struct MarkdownStreamingHarness: View {
    @ObservedObject var model: MarkdownStreamingHarnessModel

    var body: some View {
        RailgunMarkdownMessage(
            markdown: model.markdown,
            isStreaming: model.isStreaming
        )
    }
}

private enum MarkdownHarnessError: Error {
    case textViewNotFound(renderedText: [String])
    case textViewsStillPresent(renderedText: [String])
}
