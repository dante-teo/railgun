import Foundation
import Sparkle

@MainActor
final class RailgunUpdater {
    private let controller: SPUStandardUpdaterController

    private init() {
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }

    static func makeIfConfigured(bundle: Bundle = .main) -> RailgunUpdater? {
        isConfigured(infoDictionary: bundle.infoDictionary ?? [:]) ? RailgunUpdater() : nil
    }

    static func isConfigured(infoDictionary: [String: Any]) -> Bool {
        guard let feedURL = infoDictionary["SUFeedURL"] as? String,
              URL(string: feedURL)?.scheme?.lowercased() == "https",
              let publicKey = infoDictionary["SUPublicEDKey"] as? String else {
            return false
        }
        return !publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}
