import SwiftUI

/// A stable identifier for a reusable custom component.
public struct RailgunCustomComponentID: Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: StringLiteralType) {
        self.init(value)
    }
}

/// The checked-in `RailgunUI` source file that owns a reusable component.
public struct RailgunCustomComponentSourcePath: Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: StringLiteralType) {
        self.init(value)
    }
}

/// A named visual or semantic variant supported by a component.
public struct RailgunCustomComponentVariant: Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: StringLiteralType) {
        self.init(value)
    }
}

/// A component state intentionally supported by its public contract.
public enum RailgunCustomComponentState: String, CaseIterable, Hashable, Sendable {
    case normal
    case error
    case loading
    case disabled
}

/// A condition that every reusable custom component preview must exercise.
public enum RailgunCustomComponentPreviewCondition: String, CaseIterable, Hashable, Sendable {
    case lightAppearance
    case darkAppearance
    case increasedContrast
    case reducedTransparency
    case reducedMotion
    case longContent
    case error
    case loading
    case disabled
}

/// Representative widths used to verify layout behavior in previews.
public enum RailgunCustomComponentPreviewWidth: String, CaseIterable, Hashable, Sendable {
    case compact
    case regular
    case wide

    public var points: CGFloat {
        switch self {
        case .compact:
            280
        case .regular:
            480
        case .wide:
            760
        }
    }
}

/// Whether a component has user interaction that must preserve native behavior.
public enum RailgunCustomComponentInteractionClass: String, Hashable, Sendable {
    case nonInteractive
    case interactive
}

/// Accessibility requirements that are mandatory for an interactive component.
public enum RailgunCustomComponentAccessibilityRequirement: String, CaseIterable, Hashable, Sendable {
    case keyboardNavigation
    case focus
    case voiceOver
    case accessibleName
    case stateChanges
    case reducedMotion
}

/// The accessibility and interaction behavior documented for a component.
public struct RailgunCustomComponentAccessibilityRequirements: Equatable, Sendable {
    public let keyboardNavigation: Bool
    public let focus: Bool
    public let voiceOver: Bool
    public let accessibleName: Bool
    public let stateChanges: Bool
    public let reducedMotion: Bool

    public init(
        keyboardNavigation: Bool,
        focus: Bool,
        voiceOver: Bool,
        accessibleName: Bool,
        stateChanges: Bool,
        reducedMotion: Bool
    ) {
        self.keyboardNavigation = keyboardNavigation
        self.focus = focus
        self.voiceOver = voiceOver
        self.accessibleName = accessibleName
        self.stateChanges = stateChanges
        self.reducedMotion = reducedMotion
    }

    public static let interactive = Self(
        keyboardNavigation: true,
        focus: true,
        voiceOver: true,
        accessibleName: true,
        stateChanges: true,
        reducedMotion: true
    )

    public var missingInteractiveRequirements: [RailgunCustomComponentAccessibilityRequirement] {
        RailgunCustomComponentAccessibilityRequirement.allCases.filter { requirement in
            switch requirement {
            case .keyboardNavigation:
                !keyboardNavigation
            case .focus:
                !focus
            case .voiceOver:
                !voiceOver
            case .accessibleName:
                !accessibleName
            case .stateChanges:
                !stateChanges
            case .reducedMotion:
                !reducedMotion
            }
        }
    }
}

/// Why customization is necessary now and when it can be removed.
public struct RailgunCustomComponentRationale: Equatable, Sendable {
    public let customizationRationale: String
    public let macOS15NativeAPILimitation: String
    public let retirementTrigger: String

    public init(
        customizationRationale: String,
        macOS15NativeAPILimitation: String,
        retirementTrigger: String
    ) {
        self.customizationRationale = customizationRationale
        self.macOS15NativeAPILimitation = macOS15NativeAPILimitation
        self.retirementTrigger = retirementTrigger
    }
}

/// The complete, typed contract for one reusable custom `RailgunUI` component.
public struct RailgunCustomComponentSpecification: Equatable, Sendable {
    public let id: RailgunCustomComponentID
    public let sourcePath: RailgunCustomComponentSourcePath
    public let variants: [RailgunCustomComponentVariant]
    public let supportedStates: [RailgunCustomComponentState]
    public let previewConditions: [RailgunCustomComponentPreviewCondition]
    public let previewWidths: [RailgunCustomComponentPreviewWidth]
    public let interactionClass: RailgunCustomComponentInteractionClass
    public let accessibilityRequirements: RailgunCustomComponentAccessibilityRequirements
    public let rationale: RailgunCustomComponentRationale

    public init(
        id: RailgunCustomComponentID,
        sourcePath: RailgunCustomComponentSourcePath,
        variants: [RailgunCustomComponentVariant],
        supportedStates: [RailgunCustomComponentState],
        previewConditions: [RailgunCustomComponentPreviewCondition],
        previewWidths: [RailgunCustomComponentPreviewWidth],
        interactionClass: RailgunCustomComponentInteractionClass,
        accessibilityRequirements: RailgunCustomComponentAccessibilityRequirements,
        rationale: RailgunCustomComponentRationale
    ) {
        self.id = id
        self.sourcePath = sourcePath
        self.variants = variants
        self.supportedStates = supportedStates
        self.previewConditions = previewConditions
        self.previewWidths = previewWidths
        self.interactionClass = interactionClass
        self.accessibilityRequirements = accessibilityRequirements
        self.rationale = rationale
    }
}

/// The single source of truth for reusable custom components.
///
public enum RailgunCustomComponentRegistry {
    public static let components: [RailgunCustomComponentSpecification] = [
        RailgunCustomComponentSpecification(
            id: "markdown-message",
            sourcePath: "Sources/RailgunUI/RailgunMarkdownMessage.swift",
            variants: ["message"],
            supportedStates: [.normal, .error, .loading, .disabled],
            previewConditions: RailgunCustomComponentPreviewCondition.allCases,
            previewWidths: [.compact, .regular, .wide],
            interactionClass: .interactive,
            accessibilityRequirements: .interactive,
            rationale: RailgunCustomComponentRationale(
                customizationRationale: "Completed assistant messages need one reusable presentation for CommonMark/GFM blocks, safe external links and images, selectable code, and horizontally scrollable tables.",
                macOS15NativeAPILimitation: "macOS 15 SwiftUI has no single native Markdown view that supplies safe destination filtering while preserving selectable rich text, native code wrapping, table scrolling, and asynchronous image accessibility states.",
                retirementTrigger: "Replace this component when SwiftUI provides a native Markdown renderer with these security, selection, image, code, and table capabilities."
            )
        ),
        RailgunCustomComponentSpecification(
            id: "native-composer",
            sourcePath: "Sources/RailgunUI/RailgunComposer.swift",
            variants: ["task-composer"],
            supportedStates: [.normal, .disabled],
            previewConditions: RailgunCustomComponentPreviewCondition.allCases,
            previewWidths: [.compact, .regular, .wide],
            interactionClass: .interactive,
            accessibilityRequirements: .interactive,
            rationale: RailgunCustomComponentRationale(
                customizationRationale: "Task composition requires native multiline selection, paste, undo, text services, Return submission, Shift-Return line breaks, and height reporting from one shared control.",
                macOS15NativeAPILimitation: "macOS 15 SwiftUI has no text editor that provides this complete native text-system behavior together with bounded dynamic height, imperative first-responder synchronization, and Return command interception.",
                retirementTrigger: "Replace this component when SwiftUI provides a native multiline editor with equivalent sizing, command routing, focus, selection, paste, undo, text-services, and VoiceOver behavior."
            )
        )
    ]
}

/// A deterministic validation result for a component contract.
public enum RailgunCustomComponentValidationFailure: Equatable, Sendable {
    case missingComponentID
    case duplicateComponentID(String)
    case sourcePathOutsideRailgunUI(String)
    case missingCustomizationRationale(String)
    case missingMacOS15NativeAPILimitation(String)
    case missingRetirementTrigger(String)
    case missingVariants(String)
    case duplicateVariants(String, [String])
    case missingSupportedStates(String)
    case duplicateSupportedStates(String, [RailgunCustomComponentState])
    case duplicatePreviewConditions(String, [RailgunCustomComponentPreviewCondition])
    case missingPreviewConditions(String, [RailgunCustomComponentPreviewCondition])
    case missingPreviewWidths(String)
    case duplicatePreviewWidths(String, [RailgunCustomComponentPreviewWidth])
    case missingInteractiveAccessibilityRequirements(
        String,
        [RailgunCustomComponentAccessibilityRequirement]
    )
}

/// Validates registry entries without side effects so XCTest can assert its output.
public enum RailgunCustomComponentValidator {
    public static func validate(
        _ components: [RailgunCustomComponentSpecification]
    ) -> [RailgunCustomComponentValidationFailure] {
        var failures: [RailgunCustomComponentValidationFailure] = []
        var componentIDs = Set<String>()

        for component in components {
            let id = component.id.rawValue
            if id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                failures.append(.missingComponentID)
            } else if !componentIDs.insert(id).inserted {
                failures.append(.duplicateComponentID(id))
            }

            if !isRailgunUISourcePath(component.sourcePath.rawValue) {
                failures.append(.sourcePathOutsideRailgunUI(component.sourcePath.rawValue))
            }

            if isBlank(component.rationale.customizationRationale) {
                failures.append(.missingCustomizationRationale(id))
            }
            if isBlank(component.rationale.macOS15NativeAPILimitation) {
                failures.append(.missingMacOS15NativeAPILimitation(id))
            }
            if isBlank(component.rationale.retirementTrigger) {
                failures.append(.missingRetirementTrigger(id))
            }

            let variantNames = component.variants.map(\.rawValue)
            if variantNames.isEmpty {
                failures.append(.missingVariants(id))
            } else {
                let duplicateVariants = duplicates(in: variantNames)
                if !duplicateVariants.isEmpty {
                    failures.append(.duplicateVariants(id, duplicateVariants))
                }
            }

            if component.supportedStates.isEmpty {
                failures.append(.missingSupportedStates(id))
            } else {
                let duplicateStates = duplicates(in: component.supportedStates)
                if !duplicateStates.isEmpty {
                    failures.append(.duplicateSupportedStates(id, duplicateStates))
                }
            }

            let declaredConditions = Set(component.previewConditions)
            let duplicateConditions = duplicates(in: component.previewConditions)
            if !duplicateConditions.isEmpty {
                failures.append(.duplicatePreviewConditions(id, duplicateConditions))
            }
            let missingConditions = RailgunCustomComponentPreviewCondition.allCases.filter {
                !declaredConditions.contains($0)
            }
            if !missingConditions.isEmpty {
                failures.append(.missingPreviewConditions(id, missingConditions))
            }
            if component.previewWidths.isEmpty {
                failures.append(.missingPreviewWidths(id))
            } else {
                let duplicateWidths = duplicates(in: component.previewWidths)
                if !duplicateWidths.isEmpty {
                    failures.append(.duplicatePreviewWidths(id, duplicateWidths))
                }
            }

            if component.interactionClass == .interactive {
                let missingRequirements = component.accessibilityRequirements.missingInteractiveRequirements
                if !missingRequirements.isEmpty {
                    failures.append(.missingInteractiveAccessibilityRequirements(id, missingRequirements))
                }
            }
        }

        return failures
    }

    private static func isBlank(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func isRailgunUISourcePath(_ path: String) -> Bool {
        path.hasPrefix("Sources/RailgunUI/") &&
            path.hasSuffix(".swift") &&
            !path.split(separator: "/").contains("..")
    }

    private static func duplicates<Value: Hashable>(in values: [Value]) -> [Value] {
        var seen = Set<Value>()
        var duplicates: [Value] = []

        for value in values where !seen.insert(value).inserted && !duplicates.contains(value) {
            duplicates.append(value)
        }

        return duplicates
    }
}

/// One rendering of a component preview in the required matrix.
public struct RailgunCustomComponentPreviewConfiguration: Identifiable, Hashable, Sendable {
    public let variant: RailgunCustomComponentVariant
    public let state: RailgunCustomComponentState
    public let condition: RailgunCustomComponentPreviewCondition
    public let width: RailgunCustomComponentPreviewWidth

    public init(
        variant: RailgunCustomComponentVariant,
        state: RailgunCustomComponentState,
        condition: RailgunCustomComponentPreviewCondition,
        width: RailgunCustomComponentPreviewWidth
    ) {
        self.variant = variant
        self.state = state
        self.condition = condition
        self.width = width
    }

    public var id: String {
        "\(variant.rawValue)-\(state.rawValue)-\(condition.rawValue)-\(width.rawValue)"
    }

    public var isLongContent: Bool {
        condition == .longContent
    }

    public var isError: Bool {
        state == .error || condition == .error
    }

    public var isLoading: Bool {
        state == .loading || condition == .loading
    }

    public var isDisabled: Bool {
        state == .disabled || condition == .disabled
    }

    public var isIncreasedContrast: Bool {
        condition == .increasedContrast
    }

    public var isReducedTransparency: Bool {
        condition == .reducedTransparency
    }

    public var isReducedMotion: Bool {
        condition == .reducedMotion
    }

    var colorScheme: ColorScheme {
        condition == .darkAppearance ? .dark : .light
    }
}

/// Builds the complete cartesian preview matrix declared by a component contract.
public enum RailgunCustomComponentPreviewMatrix {
    public static func configurations(
        for specification: RailgunCustomComponentSpecification
    ) -> [RailgunCustomComponentPreviewConfiguration] {
        specification.variants.flatMap { variant in
            specification.supportedStates.flatMap { state in
                specification.previewConditions.flatMap { condition in
                    specification.previewWidths.map { width in
                        RailgunCustomComponentPreviewConfiguration(
                            variant: variant,
                            state: state,
                            condition: condition,
                            width: width
                        )
                    }
                }
            }
        }
    }
}

/// A reusable SwiftUI wrapper for showing every declared component preview.
///
/// The content closure receives the configuration so the component can supply
/// its declared variant, state, and long/error/loading content. SwiftUI's
/// contrast and reduced-accessibility settings are read-only environment
/// values, so content uses the corresponding configuration booleans to render
/// those deterministic preview states.
public struct RailgunCustomComponentPreviewMatrixView<Content: View>: View {
    private let configurations: [RailgunCustomComponentPreviewConfiguration]
    private let content: (RailgunCustomComponentPreviewConfiguration) -> Content

    public init(
        specification: RailgunCustomComponentSpecification,
        @ViewBuilder content: @escaping (RailgunCustomComponentPreviewConfiguration) -> Content
    ) {
        configurations = RailgunCustomComponentPreviewMatrix.configurations(for: specification)
        self.content = content
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RailgunSpacing.layout.points) {
                ForEach(configurations, id: \.id) { configuration in
                    preview(for: configuration)
                }
            }
            .padding(RailgunSpacing.layout.points)
        }
    }

    private func preview(
        for configuration: RailgunCustomComponentPreviewConfiguration
    ) -> some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.standard.points) {
            Text(configuration.id)
                .font(RailgunTypographyRole.caption.font)
                .foregroundStyle(RailgunColorRole.secondaryText.color)

            content(configuration)
                .frame(width: configuration.width.points, alignment: .leading)
                .disabled(configuration.isDisabled)
                .preferredColorScheme(configuration.colorScheme)
        }
    }
}
