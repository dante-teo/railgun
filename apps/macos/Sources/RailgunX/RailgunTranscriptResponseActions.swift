import AppKit
import SwiftUI

/// A narrow AppKit boundary for copying the transcript's stored Markdown source.
@MainActor
struct RailgunTranscriptResponsePasteboard {
    private let pasteboard: NSPasteboard

    init(pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
    }

    @discardableResult
    func copy(_ response: String) -> Bool {
        pasteboard.clearContents()
        return pasteboard.setString(response, forType: .string)
    }
}

/// Presents one native text system surface for selecting the complete response.
///
/// SwiftUI owns the response snapshot and presentation state. AppKit owns only
/// the scroll view and its single noneditable, selectable text view so native
/// selection, copy commands, text services, and VoiceOver remain available.
@MainActor
struct RailgunTranscriptResponseSelectionSurface: NSViewRepresentable {
    let text: String

    init(text: String) {
        self.text = text
    }

    init(response: String) {
        self.init(text: response)
    }

    func makeNSView(context _: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        let textView = RailgunTranscriptResponseTextView()

        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.documentView = textView

        textView.string = text
        textView.drawsBackground = true
        textView.backgroundColor = .textBackgroundColor
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = false
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = false
        textView.font = NSFont.preferredFont(forTextStyle: .body)
        textView.textColor = .labelColor
        textView.textContainerInset = NSSize(width: 16, height: 16)
        textView.setAccessibilityLabel("Response")

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context _: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        guard textView.string != text else { return }
        textView.string = text
    }
}

@MainActor
private final class RailgunTranscriptResponseTextView: NSTextView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }

        Task { @MainActor [weak self] in
            guard let self, let window = self.window else { return }
            window.makeFirstResponder(self)
        }
    }
}
