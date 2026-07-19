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

    func testNativeTypographyBundlesTheElectronAppFontFamilies() throws {
        XCTAssertEqual(RailgunFont.interfaceFamilyName, "Barlow")
        XCTAssertEqual(RailgunFont.codeFamilyName, "Departure Mono Nerd Font")

        let fontDirectory = repositoryRoot.appendingPathComponent("apps/macos/Resources/Fonts")
        let fontFiles = [
            "Barlow-Regular.otf",
            "Barlow-Medium.otf",
            "Barlow-SemiBold.otf",
            "Barlow-Bold.otf",
            "DepartureMonoNerdFont-Regular.otf"
        ]
        XCTAssertEqual(RailgunFont.bundledFontFileNames, fontFiles)
        for fontFile in fontFiles {
            XCTAssertTrue(FileManager.default.fileExists(atPath: fontDirectory.appendingPathComponent(fontFile).path))
        }

        let project = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/project.yml"),
            encoding: .utf8
        )
        XCTAssertTrue(project.contains("- path: Resources/Fonts"))
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

    func testAppIconCatalogContainsEveryRequiredMacOSRepresentation() throws {
        let appIconDirectory = repositoryRoot
            .appendingPathComponent("apps/macos/Resources/Assets.xcassets/AppIcon.appiconset")
        let contents = try JSONSerialization.jsonObject(
            with: Data(contentsOf: appIconDirectory.appendingPathComponent("Contents.json"))
        ) as? [String: Any]
        let images = try XCTUnwrap(contents?["images"] as? [[String: String]])
        let expectedRepresentations = [
            (size: "16x16", scale: "1x", filename: "icon_16x16.png", pixels: 16),
            (size: "16x16", scale: "2x", filename: "icon_16x16@2x.png", pixels: 32),
            (size: "32x32", scale: "1x", filename: "icon_32x32.png", pixels: 32),
            (size: "32x32", scale: "2x", filename: "icon_32x32@2x.png", pixels: 64),
            (size: "128x128", scale: "1x", filename: "icon_128x128.png", pixels: 128),
            (size: "128x128", scale: "2x", filename: "icon_128x128@2x.png", pixels: 256),
            (size: "256x256", scale: "1x", filename: "icon_256x256.png", pixels: 256),
            (size: "256x256", scale: "2x", filename: "icon_256x256@2x.png", pixels: 512),
            (size: "512x512", scale: "1x", filename: "icon_512x512.png", pixels: 512),
            (size: "512x512", scale: "2x", filename: "icon_512x512@2x.png", pixels: 1024)
        ]

        XCTAssertEqual(images.count, expectedRepresentations.count)
        try expectedRepresentations.forEach { expected in
            let image = try XCTUnwrap(images.first { $0["filename"] == expected.filename })
            XCTAssertEqual(image["idiom"], "mac")
            XCTAssertEqual(image["size"], expected.size)
            XCTAssertEqual(image["scale"], expected.scale)
            let imageData = try Data(contentsOf: appIconDirectory.appendingPathComponent(expected.filename))
            XCTAssertEqual(
                pngDimensions(imageData),
                PNGDimensions(width: expected.pixels, height: expected.pixels)
            )
        }
    }

    func testProjectWiresTheAppIconForNativePresentationSurfaces() throws {
        let project = try String(
            contentsOf: repositoryRoot.appendingPathComponent("apps/macos/project.yml"),
            encoding: .utf8
        )

        XCTAssertTrue(project.contains("ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon"))
        XCTAssertTrue(project.contains("INFOPLIST_KEY_CFBundleIconName: AppIcon"))
    }

    func testNativePresentationSurfacesUseTheBundleAppIcon() {
        XCTAssertEqual(RailgunIconSystem.appIconAssetName, "AppIcon")
        XCTAssertEqual(
            RailgunIconSystem.nativePresentationSurfaces,
            Set(RailgunIconPresentationSurface.allCases)
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

    private struct PNGDimensions: Equatable {
        let width: Int
        let height: Int
    }

    private func pngDimensions(_ data: Data) -> PNGDimensions {
        guard data.count >= 24, Array(data.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10] else {
            return PNGDimensions(width: 0, height: 0)
        }

        let width = data[16..<20].reduce(0) { ($0 << 8) | Int($1) }
        let height = data[20..<24].reduce(0) { ($0 << 8) | Int($1) }
        return PNGDimensions(width: width, height: height)
    }
}
