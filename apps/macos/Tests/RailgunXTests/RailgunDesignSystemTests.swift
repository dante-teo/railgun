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
}
