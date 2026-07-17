import SwiftUI

public enum RailgunColorRole: String, CaseIterable, Sendable {
    case accent = "accentColor"
    case primaryText = "labelColor"
    case secondaryText = "secondaryLabelColor"
    case destructive = "systemRed"
    case separator = "separatorColor"
    case canvas = "windowBackgroundColor"
    case surface = "controlBackgroundColor"

    public var color: Color {
        switch self {
        case .accent:
            .accentColor
        case .primaryText:
            Color(nsColor: .labelColor)
        case .secondaryText:
            Color(nsColor: .secondaryLabelColor)
        case .destructive:
            Color(nsColor: .systemRed)
        case .separator:
            Color(nsColor: .separatorColor)
        case .canvas:
            Color(nsColor: .windowBackgroundColor)
        case .surface:
            Color(nsColor: .controlBackgroundColor)
        }
    }

    public var systemColorName: String { rawValue }
}

public enum RailgunTypographyRole: CaseIterable, Sendable {
    case body
    case emphasizedBody
    case secondary
    case title
    case sectionTitle
    case caption

    public var font: Font {
        switch self {
        case .body:
            .body
        case .emphasizedBody:
            .body.weight(.semibold)
        case .secondary:
            .subheadline
        case .title:
            .title
        case .sectionTitle:
            .headline
        case .caption:
            .caption
        }
    }

    public var textStyleName: String {
        switch self {
        case .body, .emphasizedBody:
            "body"
        case .secondary:
            "subheadline"
        case .title:
            "title"
        case .sectionTitle:
            "headline"
        case .caption:
            "caption"
        }
    }
}

public enum RailgunSpacing: CGFloat, CaseIterable, Sendable {
    case compact = 4
    case standard = 8
    case relaxed = 12
    case section = 16
    case layout = 24

    public var points: CGFloat { rawValue }
}

public enum RailgunMaterialRole: String, CaseIterable, Sendable {
    case content = "regularMaterial"
    case sidebar = "bar"
    case overlay = "thinMaterial"
    case hud = "ultraThickMaterial"

    public var material: Material {
        switch self {
        case .content:
            .regularMaterial
        case .sidebar:
            .bar
        case .overlay:
            .thinMaterial
        case .hud:
            .ultraThickMaterial
        }
    }

    public var materialName: String { rawValue }
}

public enum RailgunFocusPolicy {
    /// Native controls retain SwiftUI's standard keyboard-focus treatment.
    public static let usesSystemFocusEffect = true
}

public enum RailgunMotion: CaseIterable, Sendable {
    case standard
    case emphasized

    public var duration: TimeInterval {
        switch self {
        case .standard:
            0.2
        case .emphasized:
            0.35
        }
    }

    /// Callers pass SwiftUI's `accessibilityReduceMotion` environment value.
    public func animation(reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }

        return switch self {
        case .standard:
            Animation.easeInOut(duration: duration)
        case .emphasized:
            Animation.spring(duration: duration)
        }
    }
}
