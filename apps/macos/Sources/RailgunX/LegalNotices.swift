import Foundation

enum LegalNoticeKind: String, Codable {
    case swiftPackage = "swift-package"
    case font
    case nodeRuntime = "node-runtime"
    case firstPartyArtwork = "first-party-artwork"
    case firstPartySoftware = "first-party-software"
    case backendProductionPackage = "backend-production-package"
}

struct LegalNoticeRecord: Codable, Equatable {
    let identifier: String
    let kind: LegalNoticeKind
    let name: String
    let version: String
    let revision: String?
    let archive: String?
    let copyright: String?
    let license: String
    let sourceLocation: String
    let licenseSource: String
    let noticeContentSHA256: String
}

struct LegalNoticeManifest: Codable, Equatable {
    let schemaVersion: Int
    let backendLockfileSHA256: String
    let components: [LegalNoticeRecord]
}

enum LegalNotices {
    private static let bundle = Bundle(identifier: "io.anvia.railgun") ?? .main

    static let noticesURL = bundle.url(forResource: "ThirdPartyNotices", withExtension: "md")
    static let manifestURL = bundle.url(forResource: "LegalNoticeManifest", withExtension: "json")

    static func loadManifest() throws -> LegalNoticeManifest {
        guard let manifestURL else {
            throw CocoaError(.fileNoSuchFile)
        }

        return try JSONDecoder().decode(
            LegalNoticeManifest.self,
            from: Data(contentsOf: manifestURL)
        )
    }
}
