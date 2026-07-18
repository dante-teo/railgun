import AppKit
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
    let viewportHeight: CGFloat
    let contentOffsetY: CGFloat

    init(_ geometry: ScrollGeometry) {
        contentHeight = geometry.contentSize.height
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

struct RailgunTranscriptScrollIndicatorPresentation: Equatable {
    static let maximumDashCount = 24
    static let activeDashCount = 4
    static let dashGrowthPoints: CGFloat = 96
    static let dashWidth: CGFloat = 6
    static let dashHeight: CGFloat = 3
    static let dashSpacing: CGFloat = 20
    static let maximumHeight: CGFloat = 480

    let progress: CGFloat
    let dashCount: Int

    static let initial = Self(progress: 0, dashCount: 0)

    static func make(
        contentHeight: CGFloat,
        viewportHeight: CGFloat,
        contentOffsetY: CGFloat
    ) -> Self {
        let scrollableHeight = contentHeight - viewportHeight
        guard scrollableHeight > 0 else { return .initial }
        let progress = min(1, max(0, contentOffsetY / scrollableHeight))
        let dashCount = min(
            maximumDashCount,
            activeDashCount + Int(scrollableHeight / dashGrowthPoints)
        )
        return .init(progress: progress, dashCount: dashCount)
    }

    var activeDashIndexes: [Int] {
        let count = min(Self.activeDashCount, dashCount)
        guard count > 0 else { return [] }
        let start = Int((progress * CGFloat(dashCount - count)).rounded())
        return Array(start ..< start + count)
    }

    var height: CGFloat {
        min(Self.maximumHeight, CGFloat(dashCount) * Self.dashSpacing)
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

struct RailgunTranscriptViewport: View {
    let sessionID: String
    let transcript: RailgunTranscriptState

    static let undersizedContentAlignment = UnitPoint.bottom

    @State private var followState = RailgunTranscriptFollowState.initial
    @State private var previousGeometry: RailgunScrollGeometry?
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @State private var scrollIndicator = RailgunTranscriptScrollIndicatorPresentation.initial

    static func orderedMessages(in transcript: RailgunTranscriptState) -> [RailgunTranscriptMessage] {
        transcript.messages.enumerated()
            .sorted { lhs, rhs in
                lhs.element.order == rhs.element.order
                    ? lhs.offset < rhs.offset
                    : lhs.element.order < rhs.element.order
            }
            .map(\.element)
    }

    private var messages: [RailgunTranscriptMessage] {
        Self.orderedMessages(in: transcript)
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if messages.isEmpty {
                ContentUnavailableView(
                    "No Messages Yet",
                    systemImage: "text.bubble",
                    description: Text("Messages for this task will appear here.")
                )
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(messages) { message in
                            RailgunTranscriptMessageRow(message: message)
                        }
                    }
                    .padding(.vertical, 20)
                    .padding(.leading, 44)
                    .padding(.trailing, 20)
                    .scrollTargetLayout()
                    .background(RailgunSystemScrollIndicatorSuppressor())
                }
                .defaultScrollAnchor(Self.undersizedContentAlignment, for: .alignment)
                .scrollPosition($scrollPosition)
                .scrollIndicators(.hidden)
                .onScrollGeometryChange(for: RailgunScrollGeometry.self) { geometry in
                    RailgunScrollGeometry(geometry)
                } action: { _, geometry in
                    handleGeometryChange(geometry)
                }
                .accessibilityIdentifier("transcript-scroll-view")
            }

            if followState.showsJumpToLatest {
                Button("Jump to Latest", systemImage: "arrow.down") {
                    followState = .jumpToLatest()
                    scrollToBottom()
                }
                .buttonStyle(.borderedProminent)
                .padding(20)
                .accessibilityIdentifier("jump-to-latest")
            }
        }
        .overlay(alignment: .leading) {
            RailgunScrollIndicator(presentation: scrollIndicator)
                .padding(.leading, 8)
                .allowsHitTesting(false)
        }
        .onChange(of: sessionID, initial: true) { _, _ in
            followState = .sessionDidChange()
            previousGeometry = nil
            scrollIndicator = .initial
            scrollToBottom()
        }
        .onChange(of: transcript.messages) { _, _ in
            if followState.isFollowingLatest {
                scrollToBottom()
            } else {
                followState = .contentDidChange(followState)
            }
        }
    }

    private func handleGeometryChange(_ geometry: RailgunScrollGeometry) {
        defer { previousGeometry = geometry }
        scrollIndicator = .make(
            contentHeight: geometry.contentHeight,
            viewportHeight: geometry.viewportHeight,
            contentOffsetY: geometry.contentOffsetY
        )

        if geometry.isAtBottom {
            followState = .initial
            return
        }

        if RailgunTranscriptFollowState.shouldMaintainFollow(
            followState,
            previousContentHeight: previousGeometry?.contentHeight,
            previousViewportHeight: previousGeometry?.viewportHeight,
            contentHeight: geometry.contentHeight,
            viewportHeight: geometry.viewportHeight
        ) {
            scrollToBottom()
        } else {
            followState = .scrollPositionDidChange(followState, isAtBottom: false)
        }
    }

    private func scrollToBottom() {
        scrollPosition.scrollTo(edge: .bottom)
    }
}

private struct RailgunSystemScrollIndicatorSuppressor: NSViewRepresentable {
    func makeNSView(context: Context) -> RailgunScrollerSuppressingView {
        RailgunScrollerSuppressingView()
    }

    func updateNSView(_ nsView: RailgunScrollerSuppressingView, context: Context) {
        nsView.suppressEnclosingScroller()
    }
}

private final class RailgunScrollerSuppressingView: NSView {
    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        suppressEnclosingScroller()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        suppressEnclosingScroller()
    }

    func suppressEnclosingScroller() {
        DispatchQueue.main.async { [weak self] in
            guard let scrollView = self?.enclosingScrollView else { return }
            scrollView.hasVerticalScroller = false
            scrollView.verticalScroller?.isHidden = true
        }
    }
}

struct RailgunScrollIndicator: View {
    let presentation: RailgunTranscriptScrollIndicatorPresentation

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0 ..< presentation.dashCount, id: \.self) { index in
                Rectangle()
                    .fill(presentation.activeDashIndexes.contains(index) ? Color.primary.opacity(0.78) : Color.secondary.opacity(0.24))
                    .frame(width: RailgunTranscriptScrollIndicatorPresentation.dashWidth, height: RailgunTranscriptScrollIndicatorPresentation.dashHeight)

                if index < presentation.dashCount - 1 {
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(width: RailgunTranscriptScrollIndicatorPresentation.dashWidth, height: presentation.height)
        .accessibilityHidden(true)
    }
}

private struct RailgunTranscriptMessageRow: View {
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
            } else {
                Text(message.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let status = RailgunTranscriptStatusPresentation(status: message.status) {
                Label(status.title, systemImage: status.systemImage)
                    .font(.caption)
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
