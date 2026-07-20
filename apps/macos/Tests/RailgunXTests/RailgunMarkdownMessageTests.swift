import XCTest
@testable import RailgunUI
@testable import RailgunX

final class RailgunMarkdownMessageTests: XCTestCase {
    func testRichHistoryPresentationSupportsCoreBlocksAndInlineForms() {
        let presentation = RailgunMarkdownPresentation(markdown: """
        # Desktop QA plan

        I’ll exercise *emphasis*, **strong**, ~~removed~~, `inline`, and [Docs](https://example.com/docs).

        - [x] Restore the session
        - [ ] Verify the transcript

        > Keep restored history in order.

        ---

        ```swift
        let completed = true
        ```
        """)

        XCTAssertEqual(presentation.blocks.count, 6)
        XCTAssertEqual(presentation.blocks[0], .heading(level: 1, inlines: [.text("Desktop QA plan")]))
        XCTAssertEqual(presentation.blocks[2], .unorderedList([
            RailgunMarkdownListItem(taskState: .checked, blocks: [.paragraph([.text("Restore the session")])]),
            RailgunMarkdownListItem(taskState: .unchecked, blocks: [.paragraph([.text("Verify the transcript")])])
        ]))
        XCTAssertEqual(presentation.blocks[4], .rule)
        XCTAssertEqual(presentation.blocks[5], .code(language: "swift", code: "let completed = true\n"))

        guard case let .paragraph(inlines) = presentation.blocks[1] else {
            return XCTFail("Expected the rich inline paragraph")
        }
        XCTAssertTrue(inlines.contains(.emphasis([.text("emphasis")])))
        XCTAssertTrue(inlines.contains(.strong([.text("strong")])))
        XCTAssertTrue(inlines.contains(.strikethrough([.text("removed")])))
        XCTAssertTrue(inlines.contains(.inlineCode("inline")))
        XCTAssertTrue(inlines.contains(.link(label: [.text("Docs")], destination: URL(string: "https://example.com/docs"))))
    }

    func testTablesRetainHeadersRowsAndColumnAlignment() {
        let presentation = RailgunMarkdownPresentation(markdown: """
        | Name | Count | State |
        | :--- | ---: | :---: |
        | Renderer | 2 | Ready |
        """)

        XCTAssertEqual(
            presentation.blocks,
            [.table(
                header: [[.text("Name")], [.text("Count")], [.text("State")]],
                rows: [[[.text("Renderer")], [.text("2")], [.text("Ready")]]],
                alignments: [.leading, .trailing, .center]
            )]
        )
    }

    func testOrderedListsPreserveTheirStartingNumber() {
        let presentation = RailgunMarkdownPresentation(markdown: "3. Third\n4. Fourth")

        XCTAssertEqual(
            presentation.blocks,
            [.orderedList(start: 3, items: [
                RailgunMarkdownListItem(taskState: nil, blocks: [.paragraph([.text("Third")])]),
                RailgunMarkdownListItem(taskState: nil, blocks: [.paragraph([.text("Fourth")])])
            ])]
        )
    }

    func testImagesBecomeSeparateBlocksAndInvalidSourcesUseAltText() {
        let presentation = RailgunMarkdownPresentation(markdown: "Before ![diagram](https://example.com/diagram.png) after ![secret](file:///tmp/secret.png)")

        XCTAssertEqual(
            presentation.blocks,
            [
                .paragraph([.text("Before ")]),
                .image(url: URL(string: "https://example.com/diagram.png"), altText: "diagram"),
                .paragraph([.text(" after ")]),
                .image(url: nil, altText: "secret")
            ]
        )
    }

    func testOnlyCredentialFreeAbsoluteHTTPSDestinationsAreAllowed() {
        XCTAssertEqual(RailgunMarkdownDestination.validatedURL("https://example.com/path"), URL(string: "https://example.com/path"))
        XCTAssertNil(RailgunMarkdownDestination.validatedURL("http://example.com"))
        XCTAssertNil(RailgunMarkdownDestination.validatedURL("/relative"))
        XCTAssertNil(RailgunMarkdownDestination.validatedURL("javascript:alert(1)"))
        XCTAssertNil(RailgunMarkdownDestination.validatedURL("https://user:password@example.com"))

        let presentation = RailgunMarkdownPresentation(markdown: "[unsafe](javascript:alert(1))")
        XCTAssertEqual(presentation.blocks, [.paragraph([.link(label: [.text("unsafe")], destination: nil)])])
    }

    func testRawHTMLIsLiteralWhileFencedHTMLIsCode() {
        let raw = RailgunMarkdownPresentation(markdown: "<script>alert(1)</script>")
        let fenced = RailgunMarkdownPresentation(markdown: "```html\n<div>literal</div>\n```")

        XCTAssertEqual(raw.blocks, [.paragraph([.text("<script>alert(1)</script>\n")])])
        XCTAssertEqual(fenced.blocks, [.code(language: "html", code: "<div>literal</div>\n")])
    }

    func testImageStatusLabelsKeepAltTextAvailableDuringLoadingAndFailure() {
        XCTAssertEqual(RailgunMarkdownImagePresentation.loadingLabel(altText: "Architecture diagram"), "Loading image: Architecture diagram")
        XCTAssertEqual(RailgunMarkdownImagePresentation.failureLabel(altText: "Architecture diagram"), "Unable to load image: Architecture diagram")
        XCTAssertEqual(RailgunMarkdownImagePresentation.invalidLabel(altText: "Architecture diagram"), "Image: Architecture diagram")
    }

    func testOnlyCompletedAssistantMessagesUseMarkdown() {
        XCTAssertTrue(RailgunTranscriptMessageRendering.usesMarkdown(role: .assistant, status: .complete))
        XCTAssertFalse(RailgunTranscriptMessageRendering.usesMarkdown(role: .user, status: .complete))
        XCTAssertFalse(RailgunTranscriptMessageRendering.usesMarkdown(role: .assistant, status: .streaming))
        XCTAssertFalse(RailgunTranscriptMessageRendering.usesMarkdown(role: .assistant, status: .failed))
        XCTAssertFalse(RailgunTranscriptMessageRendering.usesMarkdown(role: .assistant, status: .stopped))
    }
}
