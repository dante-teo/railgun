import AppKit
import SwiftUI

/// A native macOS text composer whose value and focus remain owned by SwiftUI.
///
/// This component deliberately owns no prompt submission workflow. Its callback
/// reports a submitted draft so a future feature can decide how to enqueue it.
@MainActor
public struct RailgunComposer: NSViewRepresentable {
    @Binding private var draft: String
    @Binding private var isFocused: Bool
    private let isEnabled: Bool
    @Binding private var reportedHeight: CGFloat
    private let onSubmit: (String) -> Void

    public init(
        draft: Binding<String>,
        isFocused: Binding<Bool>,
        isEnabled: Bool = true,
        reportedHeight: Binding<CGFloat>,
        onSubmit: @escaping (String) -> Void
    ) {
        _draft = draft
        _isFocused = isFocused
        self.isEnabled = isEnabled
        _reportedHeight = reportedHeight
        self.onSubmit = onSubmit
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    public func makeNSView(context: Context) -> NSScrollView {
        let scrollView = RailgunComposerScrollView()
        scrollView.composerTextView.delegate = context.coordinator
        context.coordinator.update(
            draft: $draft,
            isFocused: $isFocused,
            reportedHeight: $reportedHeight,
            onSubmit: onSubmit,
            scrollView: scrollView
        )
        return scrollView
    }

    public func updateNSView(_ view: NSScrollView, context: Context) {
        guard let scrollView = view as? RailgunComposerScrollView else { return }
        context.coordinator.update(
            draft: $draft,
            isFocused: $isFocused,
            reportedHeight: $reportedHeight,
            onSubmit: onSubmit,
            scrollView: scrollView
        )
        scrollView.composerTextView.updateDraft(draft)
        scrollView.updateEnabledState(isEnabled)
        context.coordinator.report(scrollView.updateLayout())
        scrollView.updateFocus(isFocused: isFocused)
    }

    @MainActor
    public final class Coordinator: NSObject, NSTextViewDelegate {
        private struct Configuration {
            let draft: Binding<String>
            let isFocused: Binding<Bool>
            let reportedHeight: Binding<CGFloat>
            let onSubmit: (String) -> Void
        }

        private var configuration: Configuration?
        private weak var scrollView: RailgunComposerScrollView?

        func update(
            draft: Binding<String>,
            isFocused: Binding<Bool>,
            reportedHeight: Binding<CGFloat>,
            onSubmit: @escaping (String) -> Void,
            scrollView: RailgunComposerScrollView
        ) {
            configuration = Configuration(
                draft: draft,
                isFocused: isFocused,
                reportedHeight: reportedHeight,
                onSubmit: onSubmit
            )
            self.scrollView = scrollView
            scrollView.composerTextView.onSubmit = { [weak self] draft in
                self?.configuration?.onSubmit(draft)
            }
        }

        public func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            if configuration?.draft.wrappedValue != textView.string {
                configuration?.draft.wrappedValue = textView.string
            }
            report(scrollView?.updateLayout())
        }

        public func textDidBeginEditing(_ notification: Notification) {
            configuration?.isFocused.wrappedValue = true
        }

        public func textDidEndEditing(_ notification: Notification) {
            configuration?.isFocused.wrappedValue = false
        }

        public func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            (textView as? RailgunComposerTextView)?.handleCommand(commandSelector) ?? false
        }

        fileprivate func report(_ height: CGFloat?) {
            guard let height, configuration?.reportedHeight.wrappedValue != height else { return }
            configuration?.reportedHeight.wrappedValue = height
        }
    }
}

@MainActor
final class RailgunComposerScrollView: NSScrollView {
    let composerTextView = RailgunComposerTextView()
    private var lastReportedHeight: CGFloat?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        borderType = .noBorder
        drawsBackground = false
        hasHorizontalScroller = false
        hasVerticalScroller = false
        autohidesScrollers = true
        verticalScrollElasticity = .automatic
        horizontalScrollElasticity = .none
        documentView = composerTextView
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        _ = updateLayout()
    }

    @discardableResult
    func updateLayout() -> CGFloat? {
        let contentWidth = contentView.bounds.width > 0
            ? contentView.bounds.width
            : RailgunComposerLayout.measurementWidth
        composerTextView.updateTextContainerWidth(contentWidth)

        let unclampedHeight = RailgunComposerLayout.unclampedHeight(for: composerTextView)
        let height = RailgunComposerLayout.clampedHeight(for: composerTextView, contentHeight: unclampedHeight)
        let isOverflowing = unclampedHeight > RailgunComposerLayout.maximumHeight(for: composerTextView)

        hasVerticalScroller = isOverflowing
        composerTextView.frame = NSRect(x: 0, y: 0, width: contentWidth, height: unclampedHeight)

        guard lastReportedHeight != height else { return nil }
        lastReportedHeight = height
        return height
    }

    func updateEnabledState(_ isEnabled: Bool) {
        composerTextView.isEditable = isEnabled
    }

    @discardableResult
    func updateFocus(isFocused: Bool) -> Bool {
        guard let window else { return true }
        let isFirstResponder = window.firstResponder === composerTextView

        if isFocused && !isFirstResponder {
            return window.makeFirstResponder(composerTextView)
        }
        if !isFocused && isFirstResponder {
            return window.makeFirstResponder(nil)
        }
        return true
    }
}

@MainActor
final class RailgunComposerTextView: NSTextView {
    var onSubmit: (String) -> Void

    init(onSubmit: @escaping (String) -> Void = { _ in }) {
        self.onSubmit = onSubmit
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let textContainer = NSTextContainer(
            size: CGSize(width: RailgunComposerLayout.measurementWidth, height: CGFloat.greatestFiniteMagnitude)
        )
        textContainer.widthTracksTextView = true
        textContainer.heightTracksTextView = false
        layoutManager.addTextContainer(textContainer)
        textStorage.addLayoutManager(layoutManager)
        super.init(frame: .zero, textContainer: textContainer)

        drawsBackground = false
        isEditable = true
        isSelectable = true
        isRichText = false
        importsGraphics = false
        allowsUndo = true
        isHorizontallyResizable = false
        isVerticallyResizable = true
        maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textContainerInset = NSSize(width: 0, height: RailgunComposerLayout.verticalInset)
        font = NSFont.preferredFont(forTextStyle: .body)
        textColor = .labelColor
        setAccessibilityLabel("Message")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func updateDraft(_ draft: String) {
        guard string != draft else { return }
        let selectedRange = selectedRange()
        string = draft
        let draftLength = (draft as NSString).length
        let location = min(selectedRange.location, draftLength)
        let length = min(selectedRange.length, draftLength - location)
        setSelectedRange(NSRange(location: location, length: length))
    }

    func updateTextContainerWidth(_ width: CGFloat) {
        textContainer?.containerSize = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
    }

    /// Returns `true` only for the Return command that this component owns.
    func handleCommand(_ commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
        guard isEditable else { return true }
        let draft = string
        if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            onSubmit(draft)
        }
        return true
    }
}

@MainActor
enum RailgunComposerLayout {
    static let minimumLineCount = 1
    static let maximumLineCount = 10
    static let measurementWidth: CGFloat = 480
    static let verticalInset: CGFloat = 4

    static func minimumHeight(for textView: NSTextView) -> CGFloat {
        height(forLineCount: minimumLineCount, textView: textView)
    }

    static func maximumHeight(for textView: NSTextView) -> CGFloat {
        height(forLineCount: maximumLineCount, textView: textView)
    }

    static func height(for textView: NSTextView) -> CGFloat {
        clampedHeight(for: textView, contentHeight: unclampedHeight(for: textView))
    }

    static func unclampedHeight(for textView: NSTextView) -> CGFloat {
        guard let layoutManager = textView.layoutManager, let textContainer = textView.textContainer else {
            return minimumHeight(for: textView)
        }
        layoutManager.ensureLayout(for: textContainer)
        let contentHeight = max(layoutManager.usedRect(for: textContainer).height, lineHeight(for: textView))
        return contentHeight + textView.textContainerInset.height * 2
    }

    static func clampedHeight(for textView: NSTextView, contentHeight: CGFloat) -> CGFloat {
        min(max(contentHeight, minimumHeight(for: textView)), maximumHeight(for: textView))
    }

    private static func height(forLineCount lineCount: Int, textView: NSTextView) -> CGFloat {
        CGFloat(lineCount) * lineHeight(for: textView) + textView.textContainerInset.height * 2
    }

    private static func lineHeight(for textView: NSTextView) -> CGFloat {
        let font = textView.font ?? NSFont.preferredFont(forTextStyle: .body)
        return textView.layoutManager?.defaultLineHeight(for: font) ??
            font.ascender - font.descender + font.leading
    }
}

private struct RailgunComposerPreview: View {
    var body: some View {
        let specification = RailgunCustomComponentRegistry.components.first { $0.id.rawValue == "native-composer" }!
        RailgunCustomComponentPreviewMatrixView(specification: specification) { configuration in
            RailgunComposer(
                draft: .constant(configuration.isLongContent ? String(repeating: "A long native composer draft. ", count: 12) : "Draft a task…"),
                isFocused: .constant(false),
                isEnabled: !configuration.isDisabled,
                reportedHeight: .constant(0),
                onSubmit: { _ in }
            )
            .frame(height: RailgunComposerLayout.maximumHeight(for: RailgunComposerTextView()))
            .opacity(configuration.isDisabled ? 0.55 : 1)
        }
    }
}

#Preview("Native composer matrix") {
    RailgunComposerPreview()
}
