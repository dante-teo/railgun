import AppKit
import Foundation
import Markdown
import SwiftStreamingMarkdown
import SwiftUI
import UniformTypeIdentifiers

/// A native action appended to the Markdown renderer's text context menu.
public struct RailgunMarkdownContextAction: Sendable {
    public let id: String
    public let title: String
    fileprivate let action: RailgunMarkdownAction

    @MainActor
    public init(id: String, title: String, perform: @escaping () -> Void) {
        self.id = id
        self.title = title
        action = RailgunMarkdownAction(perform: perform)
    }

    @MainActor
    fileprivate func perform() {
        action.perform()
    }
}

@MainActor
fileprivate final class RailgunMarkdownAction {
    private let closure: () -> Void

    init(perform: @escaping () -> Void) {
        closure = perform
    }

    func perform() {
        closure()
    }
}

/// The shared streaming and static Markdown presentation for Railgun surfaces.
///
/// The renderer receives complete source snapshots. A live assistant response
/// therefore stays Markdown-formatted while incomplete constructs are arriving,
/// and the same mounted view becomes the immutable completed presentation.
public struct RailgunMarkdownMessage: View {
    private let markdown: String
    private let isStreaming: Bool
    private let contextActions: [RailgunMarkdownContextAction]

    @StateObject private var source: RailgunMarkdownStreamSource
    @StateObject private var listener = RailgunMarkdownListener()

    public init(
        markdown: String,
        isStreaming: Bool = false,
        contextActions: [RailgunMarkdownContextAction] = []
    ) {
        self.markdown = markdown
        self.isStreaming = isStreaming
        self.contextActions = contextActions
        _source = StateObject(
            wrappedValue: RailgunMarkdownStreamSource(
                markdown: RailgunMarkdownStreamingSnapshot.prepare(
                    markdown,
                    isStreaming: isStreaming
                ),
                isComplete: !isStreaming
            )
        )
    }

    public var body: some View {
        StreamedMarkdownView(
            source: source,
            config: RailgunMarkdownTheme.configuration(
                isStreaming: isStreaming,
                contextActions: contextActions
            ),
            listener: listener
        )
        .environment(\.openURL, RailgunMarkdownDestination.openURLAction)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Markdown message")
        .task(id: updateID) {
            listener.replaceContextActions(contextActions)
            source.update(
                markdown: RailgunMarkdownStreamingSnapshot.prepare(
                    markdown,
                    isStreaming: isStreaming
                ),
                isComplete: !isStreaming
            )
        }
    }

    private var updateID: RailgunMarkdownUpdateID {
        RailgunMarkdownUpdateID(
            markdown: markdown,
            isStreaming: isStreaming,
            contextActionIDs: contextActions.map(\.id)
        )
    }
}

/// Completes the one inline construct that swift-markdown otherwise exposes
/// literally while its closing delimiter is still in flight.
///
/// SwiftStreamingMarkdown already tolerates unfinished blocks such as fenced
/// code, lists, and tables. Its public streamed view currently parses snapshots
/// without enabling the package's partial-strong rewriter, so an unmatched
/// trailing `**` needs a temporary closing delimiter until the real one arrives.
enum RailgunMarkdownStreamingSnapshot {
    static func prepare(_ markdown: String, isStreaming: Bool) -> String {
        let literalHTML = RailgunMarkdownLiteralHTML.escaping(in: markdown)
        guard isStreaming, hasUnclosedStrongDelimiter(in: literalHTML) else {
            return literalHTML
        }
        return literalHTML + "**"
    }

    private static func hasUnclosedStrongDelimiter(in markdown: String) -> Bool {
        var openDelimiterCount = 0
        var activeCodeSpanRun: Int?
        var activeFence: RailgunMarkdownFence?

        for line in markdown.split(
            separator: "\n",
            omittingEmptySubsequences: false
        ) {
            if let fence = activeFence {
                if isClosingFence(line, matching: fence) {
                    activeFence = nil
                }
                continue
            }

            if let fence = openingFence(in: line) {
                activeFence = fence
                continue
            }

            guard !isIndentedCodeLine(line) else { continue }

            var index = line.startIndex
            while index < line.endIndex {
                let character = line[index]

                if character == "\\" {
                    index = line.index(after: index)
                    if index < line.endIndex {
                        index = line.index(after: index)
                    }
                    continue
                }

                if character == "`" {
                    let runLength = repeatedCharacterCount(
                        in: line,
                        from: index,
                        character: "`"
                    )
                    if activeCodeSpanRun == nil {
                        activeCodeSpanRun = runLength
                    } else if activeCodeSpanRun == runLength {
                        activeCodeSpanRun = nil
                    }
                    index = line.index(index, offsetBy: runLength)
                    continue
                }

                guard character == "*", activeCodeSpanRun == nil else {
                    index = line.index(after: index)
                    continue
                }

                let runLength = repeatedCharacterCount(
                    in: line,
                    from: index,
                    character: "*"
                )
                if runLength == 2 {
                    let previous = index == line.startIndex
                        ? nil
                        : line[line.index(before: index)]
                    let nextIndex = line.index(index, offsetBy: runLength)
                    let next = nextIndex < line.endIndex ? line[nextIndex] : nil
                    let canOpen = isConservativeStrongOpener(next: next)
                    let canClose = isStrongCloser(
                        previous: previous,
                        next: next
                    )

                    if canClose, openDelimiterCount > 0 {
                        openDelimiterCount -= 1
                    } else if canOpen {
                        openDelimiterCount += 1
                    }
                }

                index = line.index(index, offsetBy: runLength)
            }
        }

        return openDelimiterCount > 0
    }

    private static func openingFence(in line: Substring) -> RailgunMarkdownFence? {
        let (content, indentation) = contentAfterIndentation(in: line)
        guard indentation <= 3,
              let marker = content.first,
              marker == "`" || marker == "~" else {
            return nil
        }

        let runLength = repeatedCharacterCount(
            in: content,
            from: content.startIndex,
            character: marker
        )
        guard runLength >= 3 else { return nil }
        return RailgunMarkdownFence(marker: marker, runLength: runLength)
    }

    private static func isClosingFence(
        _ line: Substring,
        matching fence: RailgunMarkdownFence
    ) -> Bool {
        let (content, indentation) = contentAfterIndentation(in: line)
        guard indentation <= 3, content.first == fence.marker else {
            return false
        }

        let runLength = repeatedCharacterCount(
            in: content,
            from: content.startIndex,
            character: fence.marker
        )
        guard runLength >= fence.runLength else { return false }
        let remainder = content.dropFirst(runLength)
        return remainder.allSatisfy(\.isWhitespace)
    }

    private static func isIndentedCodeLine(_ line: Substring) -> Bool {
        let (_, indentation) = contentAfterIndentation(in: line)
        return indentation >= 4 || line.first == "\t"
    }

    private static func contentAfterIndentation(
        in line: Substring
    ) -> (content: Substring, indentation: Int) {
        var indentation = 0
        var index = line.startIndex
        while index < line.endIndex, line[index] == " " {
            indentation += 1
            index = line.index(after: index)
        }
        return (line[index...], indentation)
    }

    private static func isConservativeStrongOpener(next: Character?) -> Bool {
        guard let next,
              !next.isWhitespace,
              !isPunctuation(next) else {
            return false
        }
        return true
    }

    private static func isStrongCloser(
        previous: Character?,
        next: Character?
    ) -> Bool {
        guard let previous, !previous.isWhitespace else { return false }
        return !isPunctuation(previous)
            || next == nil
            || next?.isWhitespace == true
            || next.map(isPunctuation) == true
    }

    private static func isPunctuation(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy {
            CharacterSet.punctuationCharacters.contains($0)
        }
    }

    private static func repeatedCharacterCount<T: StringProtocol>(
        in text: T,
        from start: T.Index,
        character: Character
    ) -> Int {
        var count = 0
        var index = start
        while index < text.endIndex, text[index] == character {
            count += 1
            index = text.index(after: index)
        }
        return count
    }
}

private struct RailgunMarkdownFence {
    let marker: Character
    let runLength: Int
}

private enum RailgunMarkdownLiteralHTML {
    private struct SourceReplacement {
        let lowerUTF8Offset: Int
        let upperUTF8Offset: Int
    }

    static func escaping(in markdown: String) -> String {
        guard markdown.contains("<") else { return markdown }

        let document = Document(parsing: markdown)
        let lineStartOffsets = utf8LineStartOffsets(in: markdown)
        var replacements: [SourceReplacement] = []
        collectHTMLRanges(
            in: document,
            lineStartOffsets: lineStartOffsets,
            utf8Count: markdown.utf8.count,
            into: &replacements
        )
        guard !replacements.isEmpty else { return markdown }

        var escaped = markdown
        for replacement in replacements.sorted(
            by: { $0.lowerUTF8Offset > $1.lowerUTF8Offset }
        ) {
            let utf8 = escaped.utf8
            let lowerUTF8 = utf8.index(
                utf8.startIndex,
                offsetBy: replacement.lowerUTF8Offset
            )
            let upperUTF8 = utf8.index(
                utf8.startIndex,
                offsetBy: replacement.upperUTF8Offset
            )
            guard let lower = String.Index(lowerUTF8, within: escaped),
                  let upper = String.Index(upperUTF8, within: escaped) else {
                continue
            }
            let replacementText = escapeMarkdownSyntax(in: escaped[lower..<upper])
            escaped.replaceSubrange(
                lower..<upper,
                with: replacementText
            )
        }
        return escaped
    }

    private static func collectHTMLRanges(
        in markup: Markup,
        lineStartOffsets: [Int],
        utf8Count: Int,
        into replacements: inout [SourceReplacement]
    ) {
        if markup is HTMLBlock || markup is InlineHTML,
           let range = markup.range,
           let replacement = sourceReplacement(
               for: range,
               lineStartOffsets: lineStartOffsets,
               utf8Count: utf8Count
           ) {
            replacements.append(replacement)
            return
        }

        for child in markup.children {
            collectHTMLRanges(
                in: child,
                lineStartOffsets: lineStartOffsets,
                utf8Count: utf8Count,
                into: &replacements
            )
        }
    }

    private static func sourceReplacement(
        for range: SourceRange,
        lineStartOffsets: [Int],
        utf8Count: Int
    ) -> SourceReplacement? {
        guard lineStartOffsets.indices.contains(range.lowerBound.line - 1),
              lineStartOffsets.indices.contains(range.upperBound.line - 1) else {
            return nil
        }

        let lower = lineStartOffsets[range.lowerBound.line - 1]
            + range.lowerBound.column - 1
        let upper = lineStartOffsets[range.upperBound.line - 1]
            + range.upperBound.column - 1
        guard lower >= 0, lower <= upper, upper <= utf8Count else {
            return nil
        }
        return SourceReplacement(lowerUTF8Offset: lower, upperUTF8Offset: upper)
    }

    private static func utf8LineStartOffsets(in text: String) -> [Int] {
        var offsets = [0]
        for (offset, byte) in text.utf8.enumerated() where byte == 0x0A {
            offsets.append(offset + 1)
        }
        return offsets
    }

    private static func escapeMarkdownSyntax(in source: Substring) -> String {
        source.reduce(into: "") { escaped, character in
            let replacement = switch character {
            case "&": "&amp;"
            case "<": "&lt;"
            case ">": "&gt;"
            case "\\": "&#92;"
            case "`": "&#96;"
            case "*": "&#42;"
            case "_": "&#95;"
            case "{": "&#123;"
            case "}": "&#125;"
            case "[": "&#91;"
            case "]": "&#93;"
            case "(": "&#40;"
            case ")": "&#41;"
            case "#": "&#35;"
            case "+": "&#43;"
            case "-": "&#45;"
            case ".": "&#46;"
            case "!": "&#33;"
            case "|": "&#124;"
            case "~": "&#126;"
            case "$": "&#36;"
            default: String(character)
            }
            escaped += replacement
        }
    }
}

private struct RailgunMarkdownUpdateID: Hashable {
    let markdown: String
    let isStreaming: Bool
    let contextActionIDs: [String]
}

/// Replays the latest full Markdown snapshot to every new renderer subscriber.
///
/// `StreamedMarkdownView` may be remounted as a lazy transcript row moves in
/// and out of the viewport. Completed sources therefore replay their final
/// value and immediately finish instead of depending on an earlier subscription.
@MainActor
final class RailgunMarkdownStreamSource: ObservableObject, StreamedMarkdownSource {
    private var latestMarkdown: String
    private var isComplete: Bool
    private var continuations: [UUID: AsyncStream<String>.Continuation] = [:]

    init(markdown: String, isComplete: Bool) {
        latestMarkdown = markdown
        self.isComplete = isComplete
    }

    nonisolated var text: AsyncStream<String> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { [weak self] continuation in
            Task { @MainActor [weak self] in
                self?.addSubscriber(continuation)
            }
        }
    }

    func update(markdown: String, isComplete: Bool) {
        if markdown != latestMarkdown {
            latestMarkdown = markdown
            for continuation in continuations.values {
                continuation.yield(markdown)
            }
        }

        guard isComplete, !self.isComplete else { return }
        self.isComplete = true
        finishSubscribers()
    }

    private func addSubscriber(_ continuation: AsyncStream<String>.Continuation) {
        continuation.yield(latestMarkdown)

        guard !isComplete else {
            continuation.finish()
            return
        }

        let id = UUID()
        continuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.continuations[id] = nil
            }
        }
    }

    private func finishSubscribers() {
        let activeContinuations = Array(continuations.values)
        continuations.removeAll()
        for continuation in activeContinuations {
            continuation.finish()
        }
    }
}

@MainActor
enum RailgunMarkdownDestination {
    /// Only credential-free absolute HTTPS URLs may leave the app.
    static func validatedURL(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value) else { return nil }
        return validatedURL(url)
    }

    static func validatedURL(_ url: URL) -> URL? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              url.isFileURL == false else {
            return nil
        }
        return url
    }

    static let openURLAction = OpenURLAction { url in
        validatedURL(url) == nil ? .discarded : .systemAction
    }
}

enum RailgunMarkdownTheme {
    static func configuration(
        isStreaming: Bool,
        contextActions: [RailgunMarkdownContextAction]
    ) -> MarkdownRenderConfig {
        let body = textFonts(.body)
        let emphasizedBody = textFonts(.body, weight: .semibold)
        let code = codeFonts(.body)
        let caption = textFonts(.caption1)

        return MarkdownRenderConfig(
            shouldAnimateText: isStreaming,
            blockQuoteStyle: .init(
                textFonts: body,
                textColor: RailgunColorRole.secondaryText.color
            ),
            headingStyle: .init(
                h1Font: textFonts(.title2, weight: .bold),
                h2Font: textFonts(.title3, weight: .bold),
                h3Font: textFonts(.headline, weight: .semibold),
                h4Font: emphasizedBody,
                h5Font: emphasizedBody,
                h6Font: emphasizedBody,
                textColor: RailgunColorRole.primaryText.color
            ),
            orderedListStyle: .init(
                textFonts: body,
                textColor: RailgunColorRole.primaryText.color
            ),
            paragraphStyle: .init(
                textFonts: body,
                textColor: RailgunColorRole.primaryText.color
            ),
            tableStyle: .init(
                textFonts: body,
                headerTextColor: RailgunColorRole.primaryText.color,
                regularTextColor: RailgunColorRole.primaryText.color,
                headerBackgroundColor: Color.primary.opacity(0.08),
                borderColor: RailgunColorRole.separator.color,
                actionButtonColor: RailgunColorRole.accent.color
            ),
            inlineStyle: .init(
                boldTextColor: RailgunColorRole.primaryText.color,
                linkTextFont: body.normal,
                linkTextColor: RailgunColorRole.accent.color,
                codeTextFont: code.normal,
                codeTextColor: RailgunColorRole.primaryText.color,
                codeBackgroundColor: Color.primary.opacity(0.08),
                codeUnderlineColor: .clear
            ),
            textContextMenu: contextMenu(contextActions),
            citationConfig: .init(
                isEnabled: false,
                font: caption.normal,
                textColor: RailgunColorRole.secondaryText.color,
                backgroundColor: .clear
            ),
            codeBlockConfig: .init(
                theme: .xcode,
                backgroundColor: RailgunColorRole.surface.color,
                foregroundColor: RailgunColorRole.secondaryText.color
            ),
            blockSpacing: RailgunSpacing.relaxed.points,
            textSelectionConfig: .init(
                isEnabled: true,
                backgroundColor: RailgunColorRole.canvas.color
            ),
            thematicBreakColor: RailgunColorRole.separator.color,
            imageConfig: .init(
                enabled: true,
                allowedImageTypes: [.remote(allowedDomains: [])]
            )
        )
    }

    private static func contextMenu(
        _ actions: [RailgunMarkdownContextAction]
    ) -> TextContextMenu? {
        guard !actions.isEmpty else { return nil }
        return TextContextMenu(menuGroups: [
            TextContextMenuGroup(
                title: nil,
                image: nil,
                displayInline: true,
                items: actions.map {
                    TextContextMenuItem(id: $0.id, title: $0.title)
                }
            )
        ])
    }

    private static func textFonts(
        _ textStyle: NSFont.TextStyle,
        weight: NSFont.Weight = .regular
    ) -> TextFonts {
        let size = NSFont.preferredFont(forTextStyle: textStyle).pointSize
        let normal = NSFont.systemFont(ofSize: size, weight: weight)
        let bold = NSFont.systemFont(ofSize: size, weight: .bold)
        let italic = NSFontManager.shared.convert(normal, toHaveTrait: .italicFontMask)
        let boldItalic = NSFontManager.shared.convert(bold, toHaveTrait: .italicFontMask)
        return TextFonts(
            normal: normal,
            italic: italic,
            bold: bold,
            boldItalic: boldItalic,
            preferredLetterSpacing: nil,
            preferredLineHeight: nil
        )
    }

    private static func codeFonts(_ textStyle: NSFont.TextStyle) -> TextFonts {
        let size = NSFont.preferredFont(forTextStyle: textStyle).pointSize
        return TextFonts(
            normal: .monospacedSystemFont(ofSize: size, weight: .regular),
            italic: .monospacedSystemFont(ofSize: size, weight: .regular),
            bold: .monospacedSystemFont(ofSize: size, weight: .bold),
            boldItalic: .monospacedSystemFont(ofSize: size, weight: .bold),
            preferredLetterSpacing: nil,
            preferredLineHeight: nil
        )
    }
}

final class RailgunMarkdownListener: ObservableObject, MarkdownListener {
    private let lock = NSLock()
    private var contextActions: [String: RailgunMarkdownContextAction] = [:]

    func replaceContextActions(_ actions: [RailgunMarkdownContextAction]) {
        lock.withLock {
            contextActions = Dictionary(uniqueKeysWithValues: actions.map { ($0.id, $0) })
        }
    }

    func onRender(markdown _: RenderableDocument) async {}

    func onTableCopyTap(content: String) async {
        await MainActor.run {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(content, forType: .string)
        }
    }

    func onTableDownloadTap(content: String) async {
        await MainActor.run {
            let panel = NSSavePanel()
            panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
            panel.nameFieldStringValue = "table.md"
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try? content.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    func onContextMenuAppear(id _: String, selectedContent _: String) async {}

    func onContextMenuTap(id: String, selectedContent _: String) async {
        let action = lock.withLock { contextActions[id] }
        await action?.perform()
    }

    func onImageTap(image _: MarkdownImage) async {}
}

#Preview("Markdown message matrix") {
    ScrollView {
        RailgunMarkdownMessage(
            markdown: """
            # Streaming Markdown

            **Rich text** remains formatted while tables and code grow.

            | State | Result |
            | :--- | ---: |
            | Stream | Ready |

            ```swift
            let completed = true
            ```
            """,
            isStreaming: true
        )
        .padding()
    }
    .frame(width: 640, height: 520)
}
