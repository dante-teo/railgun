import RailgunUI
import SwiftUI

/// Decides transcript bottom-follow behavior independently from SwiftUI's
/// scrolling callbacks so the interaction remains deterministic to test.
struct RailgunTranscriptFollowState: Equatable {
    static let bottomTolerance: CGFloat = 4

    var isFollowingLatest: Bool
    var showsJumpToLatest: Bool

    static let initial = Self(isFollowingLatest: true, showsJumpToLatest: false)

    static func isAtBottom(
        contentHeight: CGFloat,
        viewportHeight: CGFloat,
        contentOffsetY: CGFloat,
        tolerance: CGFloat = bottomTolerance
    ) -> Bool {
        contentOffsetY + viewportHeight >= contentHeight - tolerance
    }

    static func sessionDidChange() -> Self {
        .initial
    }

    static func scrollPositionDidChange(_ state: Self, isAtBottom: Bool) -> Self {
        guard !isAtBottom else { return .initial }
        return .init(isFollowingLatest: false, showsJumpToLatest: state.showsJumpToLatest)
    }

    static func contentDidChange(_ state: Self) -> Self {
        guard !state.isFollowingLatest else { return state }
        return .init(isFollowingLatest: false, showsJumpToLatest: true)
    }

    static func shouldMaintainFollow(
        _ state: Self,
        previousContentHeight: CGFloat?,
        previousViewportHeight: CGFloat?,
        contentHeight: CGFloat,
        viewportHeight: CGFloat
    ) -> Bool {
        guard state.isFollowingLatest else { return false }
        guard let previousContentHeight, let previousViewportHeight else { return true }
        return contentHeight != previousContentHeight || viewportHeight != previousViewportHeight
    }

    static func jumpToLatest() -> Self {
        .initial
    }
}

struct RailgunScrollGeometry: Equatable {
    let contentHeight: CGFloat
    let viewportWidth: CGFloat
    let viewportHeight: CGFloat
    let contentOffsetY: CGFloat

    init(_ geometry: ScrollGeometry) {
        contentHeight = geometry.contentSize.height
        viewportWidth = geometry.containerSize.width
        viewportHeight = geometry.containerSize.height
        contentOffsetY = geometry.contentOffset.y
    }

    var isAtBottom: Bool {
        RailgunTranscriptFollowState.isAtBottom(
            contentHeight: contentHeight,
            viewportHeight: viewportHeight,
            contentOffsetY: contentOffsetY
        )
    }
}

enum RailgunTranscriptStatusPresentation: Equatable {
    case streaming
    case failed
    case stopped

    init?(status: RailgunMessageStatus) {
        switch status {
        case .streaming:
            self = .streaming
        case .failed:
            self = .failed
        case .stopped:
            self = .stopped
        case .complete:
            return nil
        }
    }

    var title: String {
        switch self {
        case .streaming: "Streaming"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }

    var systemImage: String {
        switch self {
        case .streaming: "ellipsis.message"
        case .failed: "exclamationmark.triangle.fill"
        case .stopped: "stop.circle"
        }
    }
}

enum RailgunTranscriptOrdering {
    static func orderedMessages(in transcript: RailgunTranscriptState) -> [RailgunTranscriptMessage] {
        transcript.messages.enumerated()
            .sorted { lhs, rhs in
                lhs.element.order == rhs.element.order
                    ? lhs.offset < rhs.offset
                    : lhs.element.order < rhs.element.order
            }
            .map(\.element)
    }
}

enum RailgunTranscriptMessageRendering {
    /// Only immutable completed assistant history is safe to interpret as Markdown.
    static func usesMarkdown(role: RailgunTranscriptMessage.Role, status: RailgunMessageStatus) -> Bool {
        role == .assistant && status == .complete
    }
}

struct RailgunTranscriptMessageRow: View {
    let message: RailgunTranscriptMessage

    var body: some View {
        VStack(alignment: contentAlignment, spacing: 6) {
            if message.role == .user {
                HStack {
                    Spacer(minLength: 40)
                    Text(message.text)
                        .textSelection(.enabled)
                        .padding(12)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                }
            } else if RailgunTranscriptMessageRendering.usesMarkdown(
                role: message.role,
                status: message.status
            ) {
                RailgunMarkdownMessage(markdown: message.text)
            } else {
                Text(message.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let status = RailgunTranscriptStatusPresentation(status: message.status) {
                Label(status.title, systemImage: status.systemImage)
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(status == .failed ? .red : .secondary)
                    .accessibilityIdentifier("transcript-status-\(status.title.lowercased())")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("transcript-message-\(message.id)")
    }

    private var contentAlignment: HorizontalAlignment {
        message.role == .user ? .trailing : .leading
    }
}
