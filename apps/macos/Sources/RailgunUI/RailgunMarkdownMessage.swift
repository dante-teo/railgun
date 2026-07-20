import Markdown
import SwiftUI

/// A safe, native SwiftUI rendering of an immutable CommonMark/GFM message.
///
/// The component intentionally accepts only completed Markdown strings. Callers
/// keep mutable or incomplete text in a plain selectable `Text` view so a
/// stream never changes meaning while it is still arriving.
public struct RailgunMarkdownMessage: View {
    private let presentation: RailgunMarkdownPresentation

    public init(markdown: String) {
        presentation = RailgunMarkdownPresentation(markdown: markdown)
    }

    public var body: some View {
        RailgunMarkdownBlocks(blocks: presentation.blocks)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Markdown message")
    }
}

// MARK: - Presentation model

/// The testable, value-semantic form consumed by the SwiftUI renderer.
struct RailgunMarkdownPresentation: Equatable {
    let blocks: [RailgunMarkdownBlock]

    init(markdown: String) {
        blocks = RailgunMarkdownParser.blocks(from: Document(parsing: markdown))
    }
}

enum RailgunMarkdownBlock: Equatable {
    case heading(level: Int, inlines: [RailgunMarkdownInline])
    case paragraph([RailgunMarkdownInline])
    case unorderedList([RailgunMarkdownListItem])
    case orderedList(start: Int, items: [RailgunMarkdownListItem])
    case quote([RailgunMarkdownBlock])
    case rule
    case code(language: String?, code: String)
    case table(header: [[RailgunMarkdownInline]], rows: [[[RailgunMarkdownInline]]], alignments: [RailgunMarkdownTableAlignment?])
    case image(url: URL?, altText: String)
}

struct RailgunMarkdownListItem: Equatable {
    let taskState: RailgunMarkdownTaskState?
    let blocks: [RailgunMarkdownBlock]
}

enum RailgunMarkdownTaskState: Equatable {
    case checked
    case unchecked
}

enum RailgunMarkdownTableAlignment: Equatable {
    case leading
    case center
    case trailing

    var textAlignment: TextAlignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    var frameAlignment: Alignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

indirect enum RailgunMarkdownInline: Equatable {
    case text(String)
    case emphasis([RailgunMarkdownInline])
    case strong([RailgunMarkdownInline])
    case strikethrough([RailgunMarkdownInline])
    case inlineCode(String)
    case link(label: [RailgunMarkdownInline], destination: URL?)
    case image(url: URL?, altText: String)
}

enum RailgunMarkdownDestination {
    /// Only credential-free absolute HTTPS URLs can navigate or be fetched.
    static func validatedURL(_ value: String?) -> URL? {
        guard let value,
              let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              let url = components.url,
              url.isFileURL == false else {
            return nil
        }
        return url
    }
}

enum RailgunMarkdownImagePresentation {
    static func loadingLabel(altText: String) -> String { "Loading image: \(altText)" }
    static func failureLabel(altText: String) -> String { "Unable to load image: \(altText)" }
    static func invalidLabel(altText: String) -> String { "Image: \(altText)" }
}

private enum RailgunMarkdownParser {
    static func blocks(from document: Document) -> [RailgunMarkdownBlock] {
        document.children.flatMap(block)
    }

    private static func block(_ markup: Markup) -> [RailgunMarkdownBlock] {
        switch markup {
        case let heading as Heading:
            return [.heading(level: heading.level, inlines: inlines(from: heading))]
        case let paragraph as Paragraph:
            return promoteImages(in: inlines(from: paragraph))
        case let list as UnorderedList:
            return [.unorderedList(list.listItems.map(listItem))]
        case let list as OrderedList:
            return [.orderedList(start: Int(list.startIndex), items: list.listItems.map(listItem))]
        case let quote as BlockQuote:
            return [.quote(quote.children.flatMap(block))]
        case _ as ThematicBreak:
            return [.rule]
        case let code as CodeBlock:
            return [.code(language: code.language, code: code.code)]
        case let table as Markdown.Table:
            return [.table(
                header: table.head.cells.map { inlines(from: $0) },
                rows: table.body.rows.map { row in row.cells.map { inlines(from: $0) } },
                alignments: table.columnAlignments.map(tableAlignment)
            )]
        case let image as Markdown.Image:
            return [.image(url: RailgunMarkdownDestination.validatedURL(image.source), altText: plainText(inlines(from: image)))]
        case let html as HTMLBlock:
            // HTML is deliberately inert: show its source rather than parsing it.
            return [.paragraph([.text(html.rawHTML)])]
        default:
            return []
        }
    }

    private static func listItem(_ item: ListItem) -> RailgunMarkdownListItem {
        let taskState: RailgunMarkdownTaskState?
        switch item.checkbox {
        case .checked:
            taskState = .checked
        case .unchecked:
            taskState = .unchecked
        case nil:
            taskState = nil
        }
        return RailgunMarkdownListItem(taskState: taskState, blocks: item.children.flatMap(block))
    }

    private static func inlines(from markup: Markup) -> [RailgunMarkdownInline] {
        markup.children.flatMap(inline)
    }

    private static func inline(_ markup: Markup) -> [RailgunMarkdownInline] {
        switch markup {
        case let text as Markdown.Text:
            return [.text(text.string)]
        case let emphasis as Emphasis:
            return [.emphasis(inlines(from: emphasis))]
        case let strong as Strong:
            return [.strong(inlines(from: strong))]
        case let strikethrough as Strikethrough:
            return [.strikethrough(inlines(from: strikethrough))]
        case let code as InlineCode:
            return [.inlineCode(code.code)]
        case let link as Markdown.Link:
            return [.link(label: inlines(from: link), destination: RailgunMarkdownDestination.validatedURL(link.destination))]
        case let image as Markdown.Image:
            return [.image(url: RailgunMarkdownDestination.validatedURL(image.source), altText: plainText(inlines(from: image)))]
        case let html as InlineHTML:
            return [.text(html.rawHTML)]
        case _ as SoftBreak:
            return [.text(" ")]
        case _ as LineBreak:
            return [.text("\n")]
        default:
            return []
        }
    }

    private static func promoteImages(in inlines: [RailgunMarkdownInline]) -> [RailgunMarkdownBlock] {
        var blocks: [RailgunMarkdownBlock] = []
        var paragraph: [RailgunMarkdownInline] = []

        func appendParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph))
            paragraph.removeAll(keepingCapacity: true)
        }

        for inline in inlines {
            if case let .image(url, altText) = inline {
                appendParagraph()
                blocks.append(.image(url: url, altText: altText))
            } else {
                paragraph.append(inline)
            }
        }
        appendParagraph()
        return blocks
    }

    private static func tableAlignment(_ alignment: Markdown.Table.ColumnAlignment?) -> RailgunMarkdownTableAlignment? {
        switch alignment {
        case .left: .leading
        case .center: .center
        case .right: .trailing
        case nil: nil
        }
    }

    static func plainText(_ inlines: [RailgunMarkdownInline]) -> String {
        inlines.map { inline in
            switch inline {
            case let .text(value), let .inlineCode(value):
                value
            case let .emphasis(children), let .strong(children), let .strikethrough(children):
                plainText(children)
            case let .link(label, _):
                plainText(label)
            case let .image(_, altText):
                altText
            }
        }.joined()
    }
}

// MARK: - Native SwiftUI views

private struct RailgunMarkdownBlocks: View {
    let blocks: [RailgunMarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.relaxed.points) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                RailgunMarkdownBlockView(block: block)
            }
        }
    }
}

private struct RailgunMarkdownBlockView: View {
    let block: RailgunMarkdownBlock

    @ViewBuilder
    var body: some View {
        switch block {
        case let .heading(level, inlines):
            RailgunMarkdownInlineText(inlines: inlines)
                .font(headingFont(level: level))
                .textSelection(.enabled)
        case let .paragraph(inlines):
            RailgunMarkdownInlineText(inlines: inlines)
                .textSelection(.enabled)
        case let .unorderedList(items):
            RailgunMarkdownList(items: items, orderedStart: nil)
        case let .orderedList(start, items):
            RailgunMarkdownList(items: items, orderedStart: start)
        case let .quote(blocks):
            RailgunMarkdownBlocks(blocks: blocks)
                .padding(.leading, RailgunSpacing.standard.points)
                .overlay(alignment: .leading) { Rectangle().fill(.tertiary).frame(width: 3) }
                .foregroundStyle(.secondary)
        case .rule:
            Divider()
        case let .code(language, code):
            RailgunMarkdownCodeBlock(language: language, code: code)
        case let .table(header, rows, alignments):
            RailgunMarkdownTable(header: header, rows: rows, alignments: alignments)
        case let .image(url, altText):
            RailgunMarkdownImage(url: url, altText: altText)
        }
    }

    private func headingFont(level: Int) -> Font {
        switch level {
        case 1: RailgunFont.interface(.title2, weight: .bold)
        case 2: RailgunFont.interface(.title3, weight: .bold)
        case 3: RailgunFont.interface(.headline, weight: .semibold)
        default: RailgunFont.interface(.body, weight: .semibold)
        }
    }
}

private struct RailgunMarkdownInlineText: View {
    let inlines: [RailgunMarkdownInline]

    var body: some View {
        renderedText(inlines)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func renderedText(_ inlines: [RailgunMarkdownInline]) -> SwiftUI.Text {
        inlines.reduce(SwiftUI.Text("")) { partial, inline in partial + renderedText(inline) }
    }

    private func renderedText(_ inline: RailgunMarkdownInline) -> SwiftUI.Text {
        switch inline {
        case let .text(value):
            return SwiftUI.Text(value)
        case let .emphasis(children):
            return renderedText(children).italic()
        case let .strong(children):
            return renderedText(children).bold()
        case let .strikethrough(children):
            return renderedText(children).strikethrough()
        case let .inlineCode(value):
            return SwiftUI.Text(value).font(RailgunFont.code())
        case let .link(label, destination):
            guard let destination else { return renderedText(label) }
            var attributed = AttributedString(RailgunMarkdownParser.plainText(label))
            attributed.link = destination
            return SwiftUI.Text(attributed).foregroundColor(RailgunColorRole.accent.color).underline()
        case let .image(_, altText):
            return SwiftUI.Text(altText)
        }
    }
}

private struct RailgunMarkdownList: View {
    let items: [RailgunMarkdownListItem]
    let orderedStart: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: RailgunSpacing.standard.points) {
                    marker(for: item, index: index)
                        .frame(minWidth: 18, alignment: .trailing)
                    RailgunMarkdownBlocks(blocks: item.blocks)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(for item: RailgunMarkdownListItem, index: Int) -> some View {
        switch item.taskState {
        case .checked:
            SwiftUI.Image(systemName: "checkmark.square.fill").accessibilityLabel("Completed")
        case .unchecked:
            SwiftUI.Image(systemName: "square").accessibilityLabel("Not completed")
        case nil:
            if let orderedStart {
                SwiftUI.Text("\(orderedStart + index).")
            } else {
                SwiftUI.Text("•")
            }
        }
    }
}

private struct RailgunMarkdownCodeBlock: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
            if let language, !language.isEmpty {
                SwiftUI.Text(language.uppercased())
                    .font(RailgunFont.interface(.caption, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Code language \(language)")
            }
            SwiftUI.Text(code)
                .font(RailgunFont.code())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(RailgunSpacing.standard.points)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(language.map { "\($0) code block" } ?? "Code block")
    }
}

private struct RailgunMarkdownTable: View {
    let header: [[RailgunMarkdownInline]]
    let rows: [[[RailgunMarkdownInline]]]
    let alignments: [RailgunMarkdownTableAlignment?]

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(header, isHeader: true)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    tableRow(row, isHeader: false)
                }
            }
            // Fill the message width for compact tables; row cell minimums
            // still expand this content and activate native horizontal scroll.
            .containerRelativeFrame(.horizontal, alignment: .leading) { length, _ in length }
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
        }
        .scrollIndicators(.automatic)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Markdown table")
    }

    private func tableRow(_ cells: [[RailgunMarkdownInline]], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                RailgunMarkdownInlineText(inlines: cell)
                    .font(
                        isHeader
                            ? RailgunFont.interface(.body, weight: .semibold)
                            : RailgunFont.interface(.body)
                    )
                    .textSelection(.enabled)
                    .multilineTextAlignment(alignment(for: index).textAlignment)
                    .frame(minWidth: 120, alignment: alignment(for: index).frameAlignment)
                    .padding(.horizontal, RailgunSpacing.standard.points)
                    .padding(.vertical, RailgunSpacing.compact.points)
                    .background(isHeader ? Color.primary.opacity(0.08) : .clear)
                    .overlay(alignment: .trailing) { Rectangle().fill(.quaternary).frame(width: 1) }
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(.quaternary).frame(height: 1) }
    }

    private func alignment(for index: Int) -> RailgunMarkdownTableAlignment {
        guard let columnAlignment = alignments[safe: index] else { return .leading }
        return columnAlignment ?? .leading
    }
}

private struct RailgunMarkdownImage: View {
    let url: URL?
    let altText: String

    @ViewBuilder
    var body: some View {
        if let url {
            AsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 480, alignment: .leading)
                        .accessibilityLabel(altText)
                case .empty:
                    imageStatus(RailgunMarkdownImagePresentation.loadingLabel(altText: altText))
                case .failure:
                    imageStatus(RailgunMarkdownImagePresentation.failureLabel(altText: altText))
                @unknown default:
                    imageStatus(RailgunMarkdownImagePresentation.invalidLabel(altText: altText))
                }
            }
        } else {
            imageStatus(RailgunMarkdownImagePresentation.invalidLabel(altText: altText))
        }
    }

    private func imageStatus(_ label: String) -> some View {
        SwiftUI.Text(label)
            .foregroundStyle(.secondary)
            .accessibilityLabel(label)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

#Preview("Markdown message matrix") {
    let specification = RailgunCustomComponentRegistry.components[0]
    ScrollView {
        RailgunCustomComponentPreviewMatrixView(specification: specification) { configuration in
            RailgunMarkdownMessage(markdown: previewMarkdown(for: configuration))
                .frame(width: configuration.width.points)
                .padding(RailgunSpacing.section.points)
                .background(configuration.isError ? Color.red.opacity(0.08) : .clear)
                .opacity(configuration.isDisabled ? 0.55 : 1)
                .allowsHitTesting(!configuration.isDisabled)
                .environment(\.colorScheme, configuration.colorScheme)
        }
    }
}

private func previewMarkdown(for configuration: RailgunCustomComponentPreviewConfiguration) -> String {
    if configuration.isLoading {
        return "# Image loading\n\n![Architecture diagram](https://example.invalid/architecture.png)"
    }
    if configuration.isError {
        return "# Image unavailable\n\n![Architecture diagram](file:///not-allowed.png)"
    }
    if configuration.isLongContent {
        return "# Long completed response\n\nThis is intentionally long content that verifies wrapping at every preview width. **Rich text** remains selectable, and [a safe link](https://example.com) keeps native external-link behavior.\n\n```swift\nlet complete = true\n```\n\n| Name | Status |\n| --- | ---: |\n| Renderer | Complete |"
    }
    return "# Completed response\n\n**Markdown** with `code` and [Docs](https://example.com)."
}
