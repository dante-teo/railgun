import Foundation
import XCTest
import RailgunUI

final class RailgunDesignSystemTests: XCTestCase {
    func testSemanticColorsDescribeNativeSystemRoles() {
        XCTAssertEqual(RailgunColorRole.accent.systemColorName, "accentColor")
        XCTAssertEqual(RailgunColorRole.primaryText.systemColorName, "labelColor")
        XCTAssertEqual(RailgunColorRole.secondaryText.systemColorName, "secondaryLabelColor")
        XCTAssertEqual(RailgunColorRole.destructive.systemColorName, "systemRed")
        XCTAssertEqual(RailgunColorRole.separator.systemColorName, "separatorColor")
        XCTAssertEqual(RailgunColorRole.canvas.systemColorName, "windowBackgroundColor")
        XCTAssertEqual(RailgunColorRole.surface.systemColorName, "controlBackgroundColor")
    }

    func testTypographyUsesDynamicTextStyles() {
        XCTAssertEqual(RailgunTypographyRole.body.textStyleName, "body")
        XCTAssertEqual(RailgunTypographyRole.emphasizedBody.textStyleName, "body")
        XCTAssertEqual(RailgunTypographyRole.secondary.textStyleName, "subheadline")
        XCTAssertEqual(RailgunTypographyRole.title.textStyleName, "title")
        XCTAssertEqual(RailgunTypographyRole.sectionTitle.textStyleName, "headline")
        XCTAssertEqual(RailgunTypographyRole.caption.textStyleName, "caption")
    }

    func testSpacingScaleIsNamedAndOrdered() {
        XCTAssertEqual(RailgunSpacing.compact.points, 4)
        XCTAssertEqual(RailgunSpacing.standard.points, 8)
        XCTAssertEqual(RailgunSpacing.relaxed.points, 12)
        XCTAssertEqual(RailgunSpacing.section.points, 16)
        XCTAssertEqual(RailgunSpacing.layout.points, 24)
    }

    func testMaterialsRemainSystemMaterials() {
        XCTAssertEqual(RailgunMaterialRole.content.materialName, "regularMaterial")
        XCTAssertEqual(RailgunMaterialRole.sidebar.materialName, "bar")
        XCTAssertEqual(RailgunMaterialRole.overlay.materialName, "thinMaterial")
        XCTAssertEqual(RailgunMaterialRole.hud.materialName, "ultraThickMaterial")
    }

    func testFocusAndMotionPoliciesPreserveSystemAccessibilityBehavior() {
        XCTAssertTrue(RailgunFocusPolicy.usesSystemFocusEffect)
        XCTAssertEqual(RailgunMotion.standard.duration, 0.2)
        XCTAssertEqual(RailgunMotion.emphasized.duration, 0.35)
        XCTAssertNil(RailgunMotion.standard.animation(reduceMotion: true))
        XCTAssertNotNil(RailgunMotion.standard.animation(reduceMotion: false))
    }

    func testIconSystemDefinesTheProductionCanvasAndSafeArea() {
        XCTAssertEqual(RailgunIconSystem.production.canvasSize, 1_024)
        XCTAssertEqual(RailgunIconSystem.production.cornerRadius, 224)
        XCTAssertEqual(RailgunIconSystem.production.safeArea, 64)
        XCTAssertEqual(RailgunIconSystem.production.masterAssetName, "RailgunIconMaster")
        XCTAssertEqual(RailgunIconSystem.production.productionAssetName, "RailgunIcon-1024")
    }

    func testIconSystemUsesStableLightAndDarkLegiblePalette() {
        XCTAssertEqual(RailgunIconSystem.production.appearances, [.light, .dark])
        XCTAssertEqual(RailgunIconSystem.production.backgroundColorHex, "#0B1220")
        XCTAssertEqual(RailgunIconSystem.production.beamColorHex, "#22D3EE")
        XCTAssertEqual(RailgunIconSystem.production.signalColorHex, "#FBBF24")
        XCTAssertTrue(RailgunIconSystem.production.supportsMonochromeVariant)
    }

    func testMonochromeMasterPreservesProductionSilhouette() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let assetDirectory = repositoryRoot
            .appendingPathComponent("apps/macos/Resources/RailgunIcon")
        let production = try String(
            contentsOf: assetDirectory.appendingPathComponent("RailgunIcon-1024.svg"),
            encoding: .utf8
        )
        let monochrome = try String(
            contentsOf: assetDirectory.appendingPathComponent("RailgunIconMaster-Monochrome.svg"),
            encoding: .utf8
        )
        let sharedGeometry = [
            "d=\"M267 730A360 360 0 0 1 734 242\"",
            "d=\"M790 312A360 360 0 0 1 320 782\"",
            "d=\"M734 216L816 298L772 342L690 260Z\"",
            "d=\"M459 565L279 745L322 788L504 606L686 424L745 279L600 337L459 478Z\"",
            "d=\"M304 761L722 303L749 276L719 350L348 782Z\"",
            "d=\"M347 743L710 347L724 304L694 363L377 758Z\"",
            "cx=\"512\" cy=\"512\" r=\"84\"",
            "cx=\"512\" cy=\"512\" r=\"66\""
        ]

        sharedGeometry.forEach { geometry in
            XCTAssertTrue(production.contains(geometry), "Production source is missing \(geometry)")
            XCTAssertTrue(monochrome.contains(geometry), "Monochrome master is missing \(geometry)")
        }
    }
}
