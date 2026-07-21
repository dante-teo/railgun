import AppKit
import SwiftUI

/// A native macOS text composer whose value and focus remain owned by SwiftUI.
///
/// This component deliberately owns no prompt submission workflow. Its callbacks
/// report submitted drafts so the SwiftUI caller can decide how to route them.
@MainActor
public struct RailgunComposer: NSViewRepresentable {
    @Binding private var draft: String
    @Binding private var isFocused: Bool
    private let isEnabled: Bool
    private let placeholder: String?
    @Binding private var reportedHeight: CGFloat
    private let onSubmit: (String) -> Void
    private let onEnqueue: ((String) -> Void)?

    public init(
        draft: Binding<String>,
        isFocused: Binding<Bool>,
        isEnabled: Bool = true,
        placeholder: String? = nil,
        reportedHeight: Binding<CGFloat>,
        onSubmit: @escaping (String) -> Void,
        onEnqueue: ((String) -> Void)? = nil
    ) {
        _draft = draft
        _isFocused = isFocused
        self.isEnabled = isEnabled
        self.placeholder = placeholder
        _reportedHeight = reportedHeight
        self.onSubmit = onSubmit
        self.onEnqueue = onEnqueue
    }

    /// The height needed to display one line before the AppKit view has reported its layout.
    public static func minimumHeight() -> CGFloat {
        RailgunComposerLayout.minimumHeight(for: RailgunComposerTextView())
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    public func makeNSView(context: Context) -> NSScrollView {
        let scrollView = RailgunComposerScrollView()
        scrollView.composerTextView.delegate = context.coordinator
        scrollView.composerTextView.placeholder = placeholder
        context.coordinator.update(
            draft: $draft,
            isFocused: $isFocused,
            reportedHeight: $reportedHeight,
            onSubmit: onSubmit,
            onEnqueue: onEnqueue,
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
            onEnqueue: onEnqueue,
            scrollView: scrollView
        )
        scrollView.composerTextView.updateDraft(draft)
        scrollView.composerTextView.placeholder = placeholder
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
            let onEnqueue: ((String) -> Void)?
        }

        private var configuration: Configuration?
        private weak var scrollView: RailgunComposerScrollView?

        func update(
            draft: Binding<String>,
            isFocused: Binding<Bool>,
            reportedHeight: Binding<CGFloat>,
            onSubmit: @escaping (String) -> Void,
            onEnqueue: ((String) -> Void)?,
            scrollView: RailgunComposerScrollView
        ) {
            configuration = Configuration(
                draft: draft,
                isFocused: isFocused,
                reportedHeight: reportedHeight,
                onSubmit: onSubmit,
                onEnqueue: onEnqueue
            )
            self.scrollView = scrollView
            scrollView.composerTextView.onSubmit = { [weak self] draft in
                self?.configuration?.onSubmit(draft)
            }
            scrollView.composerTextView.onEnqueue = onEnqueue == nil ? nil : { [weak self] draft in
                self?.configuration?.onEnqueue?(draft)
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
    var onEnqueue: ((String) -> Void)?
    var placeholder: String? {
        didSet { needsDisplay = true }
    }

    var showsPlaceholder: Bool {
        string.isEmpty && placeholder?.isEmpty == false
    }

    var placeholderDrawingOrigin: NSPoint {
        textContainerOrigin
    }

    init(
        onSubmit: @escaping (String) -> Void = { _ in },
        onEnqueue: ((String) -> Void)? = nil
    ) {
        self.onSubmit = onSubmit
        self.onEnqueue = onEnqueue
        self.placeholder = nil
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

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        drawPlaceholder()
    }

    override func keyDown(with event: NSEvent) {
        guard isShiftReturn(event) else {
            super.keyDown(with: event)
            return
        }
        insertLineBreak()
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

    private func drawPlaceholder() {
        guard showsPlaceholder, let placeholder, let textContainer else { return }

        let placeholderStorage = NSTextStorage(
            string: placeholder,
            attributes: placeholderAttributes
        )
        let placeholderLayoutManager = NSLayoutManager()
        let placeholderContainer = NSTextContainer(
            size: textContainer.containerSize
        )
        placeholderContainer.lineFragmentPadding = textContainer.lineFragmentPadding
        placeholderLayoutManager.addTextContainer(placeholderContainer)
        placeholderStorage.addLayoutManager(placeholderLayoutManager)
        let glyphRange = placeholderLayoutManager.glyphRange(for: placeholderContainer)
        placeholderLayoutManager.drawGlyphs(forGlyphRange: glyphRange, at: placeholderDrawingOrigin)
    }

    private var placeholderAttributes: [NSAttributedString.Key: Any] {
        var attributes = typingAttributes
        attributes[.font] = font ?? NSFont.preferredFont(forTextStyle: .body)
        attributes[.foregroundColor] = NSColor.tertiaryLabelColor
        return attributes
    }

    private func isShiftReturn(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let isReturnKey = event.keyCode == 36 || event.keyCode == 76
        return isReturnKey
            && modifiers.contains(.shift)
            && !modifiers.contains(.command)
            && !modifiers.contains(.control)
            && !modifiers.contains(.option)
    }

    private func insertLineBreak() {
        guard isEditable else { return }
        insertText("\n", replacementRange: selectedRange())
    }

    /// Returns `true` only for the Return, line-break, and active-follow-up commands this component owns.
    func handleCommand(_ commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            guard isEditable else { return true }
            let draft = string
            if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                onSubmit(draft)
            }
            return true
        }
        if commandSelector == #selector(NSResponder.insertLineBreak(_:))
            || commandSelector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:))
        {
            insertLineBreak()
            return true
        }
        guard commandSelector == #selector(NSResponder.insertTab(_:)), isEditable,
              let onEnqueue
        else { return false }
        let draft = string
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        onEnqueue(draft)
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
