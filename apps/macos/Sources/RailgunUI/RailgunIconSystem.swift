import Foundation

public enum RailgunIconAppearance: String, CaseIterable, Sendable {
    case light
    case dark
}

public enum RailgunIconPresentationSurface: String, CaseIterable, Sendable {
    case dock
    case finder
    case about
    case notification
}

public struct RailgunIconDesign: Equatable, Sendable {
    public let canvasSize: Int
    public let cornerRadius: Int
    public let safeArea: Int
    public let masterAssetName: String
    public let productionAssetName: String
    public let appearances: [RailgunIconAppearance]
    public let backgroundColorHex: String
    public let beamColorHex: String
    public let signalColorHex: String
    public let supportsMonochromeVariant: Bool

    public init(
        canvasSize: Int,
        cornerRadius: Int,
        safeArea: Int,
        masterAssetName: String,
        productionAssetName: String,
        appearances: [RailgunIconAppearance],
        backgroundColorHex: String,
        beamColorHex: String,
        signalColorHex: String,
        supportsMonochromeVariant: Bool
    ) {
        self.canvasSize = canvasSize
        self.cornerRadius = cornerRadius
        self.safeArea = safeArea
        self.masterAssetName = masterAssetName
        self.productionAssetName = productionAssetName
        self.appearances = appearances
        self.backgroundColorHex = backgroundColorHex
        self.beamColorHex = beamColorHex
        self.signalColorHex = signalColorHex
        self.supportsMonochromeVariant = supportsMonochromeVariant
    }
}

public enum RailgunIconSystem {
    public static let appIconAssetName = "AppIcon"
    public static let nativePresentationSurfaces = Set(RailgunIconPresentationSurface.allCases)

    public static let production = RailgunIconDesign(
        canvasSize: 1_024,
        cornerRadius: 224,
        safeArea: 64,
        masterAssetName: "RailgunIconMaster",
        productionAssetName: "RailgunIcon-1024",
        appearances: RailgunIconAppearance.allCases,
        backgroundColorHex: "#0B1220",
        beamColorHex: "#22D3EE",
        signalColorHex: "#FBBF24",
        supportsMonochromeVariant: true
    )
}
