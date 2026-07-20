import AppKit
import CoreText
import SwiftUI

public enum RailgunFontWeight: Sendable {
    case regular
    case medium
    case semibold
    case bold
}

/// Typography shared by every native Railgun surface.
public enum RailgunFont {
    public static let interfaceFamilyName = "Barlow"
    public static let codeFamilyName = "Departure Mono Nerd Font"
    public static let bundledFontFileNames = [
        "Barlow-Regular.otf",
        "Barlow-Medium.otf",
        "Barlow-SemiBold.otf",
        "Barlow-Bold.otf",
        "DepartureMonoNerdFont-Regular.otf"
    ]

    /// Registers the packaged fonts before SwiftUI creates any app content.
    public static func registerBundledFonts(in bundle: Bundle = .main) {
        for fileName in bundledFontFileNames {
            let fileURL = URL(fileURLWithPath: fileName)
            guard let url = bundle.url(
                forResource: fileURL.deletingPathExtension().lastPathComponent,
                withExtension: fileURL.pathExtension
            ) else {
                assertionFailure("Missing bundled font: \(fileName)")
                continue
            }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    public static func interface(
        _ textStyle: Font.TextStyle = .body,
        weight: RailgunFontWeight = .regular
    ) -> Font {
        .custom(interfacePostScriptName(for: weight), size: pointSize(for: textStyle), relativeTo: textStyle)
    }

    public static func code(_ textStyle: Font.TextStyle = .body) -> Font {
        .custom("DepartureMonoNF-Regular", size: pointSize(for: textStyle), relativeTo: textStyle)
    }

    private static func interfacePostScriptName(for weight: RailgunFontWeight) -> String {
        switch weight {
        case .regular: "Barlow-Regular"
        case .medium: "Barlow-Medium"
        case .semibold: "Barlow-SemiBold"
        case .bold: "Barlow-Bold"
        }
    }

    private static func pointSize(for textStyle: Font.TextStyle) -> CGFloat {
        switch textStyle {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        @unknown default: 17
        }
    }
}

public enum RailgunMatchaAccent {
    public static let tokenName = "matchaAccent"
    public static let lightHex = "#5E722D"
    public static let darkHex = "#B9CC75"

    public static var color: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 185.0 / 255.0, green: 204.0 / 255.0, blue: 117.0 / 255.0, alpha: 1)
                : NSColor(srgbRed: 94.0 / 255.0, green: 114.0 / 255.0, blue: 45.0 / 255.0, alpha: 1)
        })
    }
}

public enum RailgunColorRole: String, CaseIterable, Sendable {
    case accent = "matchaAccent"
    case primaryText = "labelColor"
    case secondaryText = "secondaryLabelColor"
    case destructive = "systemRed"
    case separator = "separatorColor"
    case canvas = "windowBackgroundColor"
    case surface = "controlBackgroundColor"

    public var color: Color {
        switch self {
        case .accent:
            RailgunMatchaAccent.color
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

    public var tokenName: String { rawValue }
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
            RailgunFont.interface(.body)
        case .emphasizedBody:
            RailgunFont.interface(.body, weight: .semibold)
        case .secondary:
            RailgunFont.interface(.subheadline)
        case .title:
            RailgunFont.interface(.title, weight: .bold)
        case .sectionTitle:
            RailgunFont.interface(.headline, weight: .semibold)
        case .caption:
            RailgunFont.interface(.caption)
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
    case expanded = 32

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
