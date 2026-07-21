import AppKit
import SwiftUI
import XCTest
@testable import RailgunUI

@MainActor
final class RailgunComposerTests: XCTestCase {
    private final class ComposerBindingState {
        var draft = ""
        var isFocused = false
        var reportedHeight: CGFloat = 0
    }

    func testHeightClampsFromOneToTenLines() {
        let textView = RailgunComposerTextView()
        let oneLineHeight = RailgunComposerLayout.height(for: textView)

        textView.string = Array(repeating: "line", count: 10).joined(separator: "\n")
        let tenLineHeight = RailgunComposerLayout.height(for: textView)

        textView.string = Array(repeating: "line", count: 11).joined(separator: "\n")
        let overflowHeight = RailgunComposerLayout.height(for: textView)

        XCTAssertEqual(oneLineHeight, RailgunComposerLayout.minimumHeight(for: textView), accuracy: 0.001)
        XCTAssertEqual(tenLineHeight, RailgunComposerLayout.maximumHeight(for: textView), accuracy: 0.001)
        XCTAssertEqual(overflowHeight, tenLineHeight, accuracy: 0.001)
    }

    func testOverflowEnablesVerticalScrollingAndHeightReportingOnlyChangesWhenNeeded() {
        let scrollView = RailgunComposerScrollView()
        let textView = scrollView.composerTextView
        textView.string = "one line"

        let initial = scrollView.updateLayout()
        let unchanged = scrollView.updateLayout()
        let usesScrollerForOneLine = scrollView.hasVerticalScroller

        textView.string = Array(repeating: "line", count: 11).joined(separator: "\n")
        let overflow = scrollView.updateLayout()

        XCTAssertFalse(usesScrollerForOneLine)
        XCTAssertNil(unchanged)
        XCTAssertNotNil(initial)
        XCTAssertEqual(overflow ?? 0, RailgunComposerLayout.maximumHeight(for: textView), accuracy: 0.001)
        XCTAssertTrue(scrollView.hasVerticalScroller)
        XCTAssertGreaterThan(textView.frame.height, RailgunComposerLayout.maximumHeight(for: textView))
        XCTAssertEqual(
            textView.frame.height,
            RailgunComposerLayout.unclampedHeight(for: textView),
            accuracy: 0.001
        )
    }

    func testReturnSubmitsNonblankDraftWhileShiftReturnInsertsANewline() {
        var submitted: [String] = []
        let textView = RailgunComposerTextView(onSubmit: { submitted.append($0) })
        textView.string = "Ship it"

        XCTAssertTrue(textView.handleCommand(#selector(NSResponder.insertNewline(_:))))
        XCTAssertEqual(submitted, ["Ship it"])
        XCTAssertTrue(textView.handleCommand(#selector(NSResponder.insertLineBreak(_:))))
        XCTAssertEqual(textView.string, "Ship it\n")
        XCTAssertEqual(submitted, ["Ship it"])

        XCTAssertTrue(textView.handleCommand(#selector(NSResponder.insertNewlineIgnoringFieldEditor(_:))))
        XCTAssertEqual(textView.string, "Ship it\n\n")
        XCTAssertEqual(submitted, ["Ship it"])
    }

    func testRawShiftReturnInsertsANewlineWithoutSubmitting() throws {
        var submitted: [String] = []
        let textView = RailgunComposerTextView(onSubmit: { submitted.append($0) })
        textView.string = "Ship it"

        let event = try XCTUnwrap(makeKeyEvent(keyCode: 36, modifiers: .shift))
        textView.keyDown(with: event)

        XCTAssertEqual(textView.string, "Ship it\n")
        XCTAssertTrue(submitted.isEmpty)
    }

    func testReturnSuppressesBlankDraftSubmission() {
        var submissions = 0
        let textView = RailgunComposerTextView(onSubmit: { _ in submissions += 1 })
        textView.string = " \n\t "

        XCTAssertTrue(textView.handleCommand(#selector(NSResponder.insertNewline(_:))))
        XCTAssertEqual(submissions, 0)
    }

    func testReturnSuppressesSubmissionWhenEditingIsDisabled() {
        var submissions = 0
        let textView = RailgunComposerTextView(onSubmit: { _ in submissions += 1 })
        textView.string = "Keep this draft"
        textView.isEditable = false

        XCTAssertTrue(textView.handleCommand(#selector(NSResponder.insertNewline(_:))))
        XCTAssertEqual(submissions, 0)
    }

    func testTabEnqueuesANonblankEditableDraftWithoutSubmitting() {
        var enqueued: [String] = []
        let textView = RailgunComposerTextView(onEnqueue: { enqueued.append($0) })
        textView.string = "Follow this up"

        XCTAssertTrue(textView.handleCommand(#selector(NSResponder.insertTab(_:))))
        XCTAssertEqual(enqueued, ["Follow this up"])
        XCTAssertTrue(textView.handleCommand(#selector(NSResponder.insertLineBreak(_:))))
        XCTAssertEqual(textView.string, "Follow this up\n")
        XCTAssertEqual(enqueued, ["Follow this up"])
    }

    func testBlankOrInactiveTabRetainsNativeFocusBehavior() {
        var enqueued = 0
        let activeTextView = RailgunComposerTextView(onEnqueue: { _ in enqueued += 1 })
        activeTextView.string = " \n\t "

        XCTAssertFalse(activeTextView.handleCommand(#selector(NSResponder.insertTab(_:))))
        XCTAssertEqual(enqueued, 0)

        let inactiveTextView = RailgunComposerTextView()
        inactiveTextView.string = "Keep native Tab"
        XCTAssertFalse(inactiveTextView.handleCommand(#selector(NSResponder.insertTab(_:))))
    }

    func testTabDoesNotEnqueueWhenEditingIsDisabled() {
        var enqueued = 0
        let textView = RailgunComposerTextView(onEnqueue: { _ in enqueued += 1 })
        textView.string = "Keep this draft"
        textView.isEditable = false

        XCTAssertFalse(textView.handleCommand(#selector(NSResponder.insertTab(_:))))
        XCTAssertEqual(enqueued, 0)
    }

    func testMultilinePasteAndExternalDraftSynchronizationPreserveSelection() {
        let textView = RailgunComposerTextView()
        textView.string = "hello"
        textView.setSelectedRange(NSRange(location: 5, length: 0))
        textView.insertText("\nworld", replacementRange: textView.selectedRange())

        XCTAssertEqual(textView.string, "hello\nworld")
        XCTAssertEqual(textView.selectedRange(), NSRange(location: 11, length: 0))

        textView.setSelectedRange(NSRange(location: 1, length: 3))
        textView.updateDraft("hello world")
        XCTAssertEqual(textView.selectedRange(), NSRange(location: 1, length: 3))
    }

    func testNativeTextViewConfigurationRetainsEditingSelectionAndAccessibility() {
        let textView = RailgunComposerTextView()

        XCTAssertTrue(textView.isEditable)
        XCTAssertTrue(textView.isSelectable)
        XCTAssertFalse(textView.isRichText)
        XCTAssertTrue(textView.allowsUndo)
        XCTAssertEqual(textView.accessibilityLabel(), "Message")
    }

    func testPlaceholderUsesNativeTextContainerGeometryAndTracksDraftVisibility() {
        let textView = RailgunComposerTextView()
        textView.placeholder = "Message Railgun…"

        XCTAssertTrue(textView.showsPlaceholder)
        XCTAssertEqual(textView.placeholderDrawingOrigin, textView.textContainerOrigin)

        textView.string = "Draft"
        XCTAssertFalse(textView.showsPlaceholder)
    }

    private func makeKeyEvent(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> NSEvent? {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\r",
            charactersIgnoringModifiers: "\r",
            isARepeat: false,
            keyCode: keyCode
        )
    }

    func testDelegateSynchronizesNativeDraftFocusAndHeightBackToSwiftUI() {
        let state = ComposerBindingState()
        let coordinator = RailgunComposer.Coordinator()
        let scrollView = RailgunComposerScrollView()
        let textView = scrollView.composerTextView
        coordinator.update(
            draft: Binding(get: { state.draft }, set: { state.draft = $0 }),
            isFocused: Binding(get: { state.isFocused }, set: { state.isFocused = $0 }),
            reportedHeight: Binding(
                get: { state.reportedHeight },
                set: { state.reportedHeight = $0 }
            ),
            onSubmit: { _ in },
            onEnqueue: nil,
            scrollView: scrollView
        )

        textView.string = "Native draft"
        coordinator.textDidChange(Notification(name: Notification.Name("draft-changed"), object: textView))
        coordinator.textDidBeginEditing(Notification(name: Notification.Name("focus-began")))
        coordinator.textDidEndEditing(Notification(name: Notification.Name("focus-ended")))

        XCTAssertEqual(state.draft, "Native draft")
        XCTAssertEqual(state.reportedHeight, RailgunComposerLayout.minimumHeight(for: textView), accuracy: 0.001)
        XCTAssertFalse(state.isFocused)
    }

    func testEnabledStateAndFocusHandoffSynchronizeToNativeTextView() {
        let scrollView = RailgunComposerScrollView()
        let textView = scrollView.composerTextView
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 120),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        let contentView = NSView(frame: window.contentView?.bounds ?? .zero)
        scrollView.frame = contentView.bounds
        contentView.addSubview(scrollView)
        window.contentView = contentView

        scrollView.updateEnabledState(false)
        XCTAssertFalse(textView.isEditable)
        XCTAssertTrue(textView.isSelectable)

        scrollView.updateEnabledState(true)
        XCTAssertTrue(textView.isEditable)
        XCTAssertTrue(window.makeFirstResponder(textView))
        XCTAssertTrue(scrollView.updateFocus(isFocused: false))
        XCTAssertFalse(window.firstResponder === textView)
        XCTAssertTrue(scrollView.updateFocus(isFocused: true))
        XCTAssertTrue(window.firstResponder === textView)
    }
}
