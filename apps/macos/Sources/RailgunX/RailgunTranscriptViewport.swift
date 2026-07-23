import RailgunUI
import SwiftUI

/// Decides transcript bottom-follow behavior independently from SwiftUI's
/// scrolling callbacks so the interaction remains deterministic to test.
struct RailgunTranscriptFollowState: Equatable {
    static let bottomTolerance: CGFloat = 4

    var isFollowingLatest: Bool
    var showsJumpToLatest: Bool

    static let initial = Self(isFollowingLatest: true, showsJumpToLatest: false)

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
    let visibleMaxY: CGFloat
    let bottomContentInset: CGFloat

    init(_ geometry: ScrollGeometry) {
        contentHeight = geometry.contentSize.height
        viewportWidth = geometry.containerSize.width
        viewportHeight = geometry.containerSize.height
        visibleMaxY = geometry.visibleRect.maxY
        bottomContentInset = geometry.contentInsets.bottom
    }

    init(
        contentHeight: CGFloat,
        viewportWidth: CGFloat,
        viewportHeight: CGFloat,
        visibleMaxY: CGFloat,
        bottomContentInset: CGFloat
    ) {
        self.contentHeight = contentHeight
        self.viewportWidth = viewportWidth
        self.viewportHeight = viewportHeight
        self.visibleMaxY = visibleMaxY
        self.bottomContentInset = bottomContentInset
    }

    var isAtBottom: Bool {
        visibleMaxY >= contentHeight + bottomContentInset - RailgunTranscriptFollowState.bottomTolerance
    }
}

private enum RailgunTranscriptScrollAnchor {
    static let bottom = "railgun-transcript-bottom"
}

struct RailgunTranscriptContentRevision: Equatable {
    let messages: [RailgunTranscriptMessage]
    let activityEntries: [RailgunActivityEntry]
}

/// Owns the transcript's single SwiftUI scrolling mechanism. Keeping the
/// reader, target, follow state, and geometry observation together prevents
/// parent overlays and unrelated task state from changing scroll identity.
struct RailgunTranscriptScrollView<Revision: Equatable, Content: View>: View {
    let sessionID: String?
    let contentRevision: Revision
    let contentLeadingMargin: CGFloat
    let hasScrollableContent: Bool
    private let content: Content

    @State private var followState = RailgunTranscriptFollowState.initial

    init(
        sessionID: String?,
        contentRevision: Revision,
        contentLeadingMargin: CGFloat,
        hasScrollableContent: Bool,
        @ViewBuilder content: () -> Content
    ) {
        self.sessionID = sessionID
        self.contentRevision = contentRevision
        self.contentLeadingMargin = contentLeadingMargin
        self.hasScrollableContent = hasScrollableContent
        self.content = content()
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    content

                    Color.clear
                        .frame(height: 1)
                        .id(RailgunTranscriptScrollAnchor.bottom)
                }
            }
            // Apple's unscoped form establishes the initial scroll offset.
            // The role-scoped `.alignment` form only aligns undersized content.
            .defaultScrollAnchor(.bottom)
            .contentMargins(.leading, contentLeadingMargin, for: .scrollContent)
            .onScrollGeometryChange(for: RailgunScrollGeometry.self) { geometry in
                RailgunScrollGeometry(geometry)
            } action: { previous, current in
                handleGeometryChange(from: previous, to: current, proxy: proxy)
            }
            .onChange(of: sessionID, initial: true) { _, _ in
                followState = .sessionDidChange()
                scrollToBottom(using: proxy)
            }
            .onChange(of: contentRevision) { _, _ in
                if followState.isFollowingLatest {
                    scrollToBottom(using: proxy)
                } else {
                    followState = .contentDidChange(followState)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if hasScrollableContent && followState.showsJumpToLatest {
                    Button("Jump to Latest", systemImage: "arrow.down") {
                        followState = .jumpToLatest()
                        scrollToBottom(using: proxy)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(RailgunSpacing.layout.points)
                    .accessibilityIdentifier("jump-to-latest")
                }
            }
            .accessibilityIdentifier("transcript-scroll-view")
        }
    }

    private func handleGeometryChange(
        from previous: RailgunScrollGeometry,
        to current: RailgunScrollGeometry,
        proxy: ScrollViewProxy
    ) {
        if RailgunTranscriptFollowState.shouldMaintainFollow(
            followState,
            previousContentHeight: previous.contentHeight,
            previousViewportHeight: previous.viewportHeight,
            contentHeight: current.contentHeight,
            viewportHeight: current.viewportHeight
        ) {
            scrollToBottom(using: proxy)
        } else {
            followState = .scrollPositionDidChange(
                followState,
                isAtBottom: current.isAtBottom
            )
        }
    }

    private func scrollToBottom(using proxy: ScrollViewProxy) {
        proxy.scrollTo(RailgunTranscriptScrollAnchor.bottom, anchor: .bottom)
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

/// Keeps the destructive branch action tied to persisted assistant turn
/// boundaries that actually have visible history to abandon.
enum RailgunBranchAffordance {
    static func isAvailable(
        for message: RailgunTranscriptMessage,
        in visibleMessages: [RailgunTranscriptMessage],
        session: RailgunSessionState,
        isRunActive: Bool,
        isTaskLocked: Bool,
        isBranchInFlight: Bool
    ) -> Bool {
        guard message.role == .assistant,
              message.status == .complete,
              message.branchable,
              let messageID = message.messageID,
              messageID > 0,
              session.selectedSession?.isPersisted == true,
              !session.isLoading,
              session.restoreInFlightSessionID == nil,
              !isRunActive,
              !isTaskLocked,
              !isBranchInFlight,
              let messageIndex = visibleMessages.firstIndex(where: { $0.id == message.id })
        else { return false }
        return visibleMessages.indices.contains(visibleMessages.index(after: messageIndex))
    }
}

enum RailgunTranscriptMessageRendering {
    /// Only immutable completed assistant history is safe to interpret as Markdown.
    static func usesMarkdown(role: RailgunTranscriptMessage.Role, status: RailgunMessageStatus) -> Bool {
        role == .assistant && status == .complete
    }
}

struct RailgunTranscriptActivityViewport: View {
    let messages: [RailgunTranscriptMessage]
    let activity: RailgunActivityState
    let isRunActive: Bool
    let isBranchAvailable: (RailgunTranscriptMessage) -> Bool
    let branch: (RailgunTranscriptMessage) -> Void

    var body: some View {
        ForEach(Array(presentation.enumerated()), id: \.offset) { _, item in
            switch item {
            case let .message(message):
                RailgunTranscriptMessageRow(
                    message: message,
                    branchAction: isBranchAvailable(message) ? { branch(message) } : nil
                )
                    .frame(maxWidth: 720)
            case let .activityRows(entries):
                RailgunActivityRows(entries: entries)
                    .frame(maxWidth: 720, alignment: .leading)
            case let .worked(entries):
                RailgunWorkedActivityDisclosure(entries: entries)
                    .frame(maxWidth: 720, alignment: .leading)
            }
        }
    }

    private var presentation: [RailgunTranscriptRenderItem] {
        let timeline = RailgunTranscriptActivityPresentation.timeline(
            messages: messages,
            activity: activity.entries
        )
        let hasActiveActivity = isRunActive || activity.entries.contains { $0.status == .running }
        return RailgunTranscriptActivityPresentation.renderItems(
            from: RailgunTranscriptActivityPresentation.collapseSettledTurnActivity(
                timeline,
                isActive: hasActiveActivity
            )
        )
    }
}

struct RailgunTranscriptMessageRow: View {
    let message: RailgunTranscriptMessage
    let branchAction: (() -> Void)?

    var body: some View {
        if let branchAction {
            messageContent.contextMenu {
                Button("Branch from this message") {
                    branchAction()
                }
            }
        } else {
            messageContent
        }
    }

    private var messageContent: some View {
        VStack(alignment: contentAlignment, spacing: RailgunSpacing.standard.points) {
            if message.role == .user {
                HStack {
                    Spacer(minLength: 40)
                    Text(message.text)
                        .textSelection(.enabled)
                        .padding(RailgunSpacing.relaxed.points)
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
