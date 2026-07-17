import Foundation
import XCTest
import RailgunUI

final class RailgunCustomComponentFoundationTests: XCTestCase {
    func testEmptyRegistryIsValid() {
        XCTAssertEqual(RailgunCustomComponentRegistry.components, [])
        XCTAssertEqual(
            RailgunCustomComponentValidator.validate(RailgunCustomComponentRegistry.components),
            []
        )
    }

    func testValidSpecificationPassesValidation() {
        XCTAssertEqual(RailgunCustomComponentValidator.validate([validSpecification]), [])
    }

    func testValidatorRejectsDuplicateIDs() {
        let duplicate = specification(id: "connection-status")

        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([duplicate, duplicate]),
            [.duplicateComponentID("connection-status")]
        )
    }

    func testValidatorRejectsSourcePathsOutsideRailgunUI() {
        let invalid = specification(sourcePath: "Sources/RailgunX/ConnectionStatus.swift")
        let escaping = specification(sourcePath: "Sources/RailgunUI/../RailgunX/ConnectionStatus.swift")

        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([invalid]),
            [.sourcePathOutsideRailgunUI("Sources/RailgunX/ConnectionStatus.swift")]
        )
        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([escaping]),
            [.sourcePathOutsideRailgunUI("Sources/RailgunUI/../RailgunX/ConnectionStatus.swift")]
        )
    }

    func testValidatorRejectsIncompleteRationaleAndRetirementMetadata() {
        let invalid = specification(
            rationale: RailgunCustomComponentRationale(
                customizationRationale: " ",
                macOS15NativeAPILimitation: "",
                retirementTrigger: "\n"
            )
        )

        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([invalid]),
            [
                .missingCustomizationRationale("connection-status"),
                .missingMacOS15NativeAPILimitation("connection-status"),
                .missingRetirementTrigger("connection-status")
            ]
        )
    }

    func testValidatorRejectsMissingAndDuplicateVariantsAndStates() {
        let missing = specification(variants: [], supportedStates: [])
        let duplicates = specification(
            variants: ["compact", "compact"],
            supportedStates: [.normal, .normal]
        )

        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([missing]),
            [.missingVariants("connection-status"), .missingSupportedStates("connection-status")]
        )
        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([duplicates]),
            [.duplicateVariants("connection-status", ["compact"]), .duplicateSupportedStates("connection-status", [.normal])]
        )
    }

    func testValidatorRejectsIncompletePreviewCoverage() {
        let invalid = specification(
            previewConditions: [.lightAppearance, .darkAppearance],
            previewWidths: []
        )

        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([invalid]),
            [
                .missingPreviewConditions(
                    "connection-status",
                    [.increasedContrast, .reducedTransparency, .reducedMotion, .longContent, .error, .loading, .disabled]
                ),
                .missingPreviewWidths("connection-status")
            ]
        )
    }

    func testValidatorRejectsDuplicatePreviewConditionsAndWidths() {
        let invalid = specification(
            previewConditions: RailgunCustomComponentPreviewCondition.allCases + [.lightAppearance],
            previewWidths: [.compact, .regular, .compact]
        )

        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([invalid]),
            [
                .duplicatePreviewConditions("connection-status", [.lightAppearance]),
                .duplicatePreviewWidths("connection-status", [.compact])
            ]
        )
    }

    func testValidatorRejectsIncompleteInteractiveAccessibilityRequirements() {
        let invalid = specification(
            accessibilityRequirements: RailgunCustomComponentAccessibilityRequirements(
                keyboardNavigation: true,
                focus: false,
                voiceOver: false,
                accessibleName: true,
                stateChanges: false,
                reducedMotion: false
            )
        )

        XCTAssertEqual(
            RailgunCustomComponentValidator.validate([invalid]),
            [
                .missingInteractiveAccessibilityRequirements(
                    "connection-status",
                    [.focus, .voiceOver, .stateChanges, .reducedMotion]
                )
            ]
        )
    }

    func testValidatorAllowsNonInteractiveComponentsWithoutInteractiveAccessibilityRequirements() {
        let nonInteractive = specification(
            interactionClass: .nonInteractive,
            accessibilityRequirements: RailgunCustomComponentAccessibilityRequirements(
                keyboardNavigation: false,
                focus: false,
                voiceOver: false,
                accessibleName: false,
                stateChanges: false,
                reducedMotion: false
            )
        )

        XCTAssertEqual(RailgunCustomComponentValidator.validate([nonInteractive]), [])
    }

    func testPreviewMatrixExpandsEveryDeclaredAxis() {
        let specification = specification(
            variants: ["regular", "compact"],
            supportedStates: [.normal, .disabled],
            previewConditions: [.lightAppearance, .darkAppearance],
            previewWidths: [.compact, .wide]
        )

        let configurations = RailgunCustomComponentPreviewMatrix.configurations(for: specification)

        XCTAssertEqual(configurations.count, 16)
        XCTAssertEqual(Set(configurations.map(\.variant)), Set(specification.variants))
        XCTAssertEqual(Set(configurations.map(\.state)), Set(specification.supportedStates))
        XCTAssertEqual(Set(configurations.map(\.condition)), Set(specification.previewConditions))
        XCTAssertEqual(Set(configurations.map(\.width)), Set(specification.previewWidths))
    }

    func testCustomComponentContractsAreOwnedByRailgunUI() throws {
        let sourceRoot = repositoryRoot.appendingPathComponent("apps/macos/Sources")
        let railgunUISourceRoot = sourceRoot.appendingPathComponent("RailgunUI").standardizedFileURL.path
        let sourceFiles = FileManager.default.enumerator(
            at: sourceRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )?
        .compactMap { $0 as? URL }
        .filter { $0.pathExtension == "swift" } ?? []

        let contractDeclaration = try NSRegularExpression(
            pattern: #"\b(?:struct|enum|class|actor|protocol|extension|typealias)\s+Railgun(?:CustomComponent|CustomComponentPreview)"#
        )

        for sourceFile in sourceFiles where sourceFile.standardizedFileURL.path != railgunUISourceRoot &&
            !sourceFile.standardizedFileURL.path.hasPrefix("\(railgunUISourceRoot)/") {
            let source = try String(contentsOf: sourceFile, encoding: .utf8)
            let range = NSRange(source.startIndex..., in: source)
            XCTAssertEqual(
                contractDeclaration.numberOfMatches(in: source, range: range),
                0,
                "Custom-component contracts must be owned by RailgunUI: \(sourceFile.path)"
            )
        }
    }

    private var validSpecification: RailgunCustomComponentSpecification {
        specification()
    }

    private func specification(
        id: String = "connection-status",
        sourcePath: String = "Sources/RailgunUI/ConnectionStatus.swift",
        variants: [RailgunCustomComponentVariant] = ["regular", "compact"],
        supportedStates: [RailgunCustomComponentState] = [.normal, .error, .loading, .disabled],
        previewConditions: [RailgunCustomComponentPreviewCondition] = RailgunCustomComponentPreviewCondition.allCases,
        previewWidths: [RailgunCustomComponentPreviewWidth] = [.compact, .regular, .wide],
        interactionClass: RailgunCustomComponentInteractionClass = .interactive,
        accessibilityRequirements: RailgunCustomComponentAccessibilityRequirements = .interactive,
        rationale: RailgunCustomComponentRationale = RailgunCustomComponentRationale(
            customizationRationale: "A compact connection indicator is required in several features.",
            macOS15NativeAPILimitation: "macOS 15 SwiftUI has no equivalent component with the required states.",
            retirementTrigger: "Replace it when a native SwiftUI connection-status control supports the required states."
        )
    ) -> RailgunCustomComponentSpecification {
        RailgunCustomComponentSpecification(
            id: RailgunCustomComponentID(id),
            sourcePath: RailgunCustomComponentSourcePath(sourcePath),
            variants: variants,
            supportedStates: supportedStates,
            previewConditions: previewConditions,
            previewWidths: previewWidths,
            interactionClass: interactionClass,
            accessibilityRequirements: accessibilityRequirements,
            rationale: rationale
        )
    }

    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}
