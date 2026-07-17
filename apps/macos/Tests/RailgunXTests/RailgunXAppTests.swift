import CryptoKit
import XCTest
import RailgunCore
import RailgunServices
import RailgunTestSupport
import RailgunTransport
import RailgunUI
@testable import RailgunX

@MainActor
final class RailgunXAppTests: XCTestCase {
    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    func testModuleBoundariesCompile() {}

    func testPlaceholderWindowUsesProductName() {
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration.primaryWindowTitle, "RailgunX")
    }

    func testAppUsesThePrimaryLifecycleConfiguration() {
        XCTAssertEqual(RailgunXApp.lifecycleConfiguration, .primary)
    }

    func testPrimaryWindowLifecycleConfiguration() {
        let configuration = AppLifecycleConfiguration.primary

        XCTAssertEqual(configuration.primaryWindowTitle, "RailgunX")
        XCTAssertEqual(configuration.primaryWindowRestorationIdentifier, "primary")
        XCTAssertEqual(configuration.primaryWindowDefaultSize, CGSize(width: 1_024, height: 700))
        XCTAssertEqual(configuration.primaryWindowMinimumSize, CGSize(width: 760, height: 520))
        XCTAssertEqual(configuration.primaryWindowResizability, .contentMinimumSize)
    }

    func testMockBackendModeIsSelectedFromEnvironment() {
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "mock"]), .mock)
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "mock"]).placeholderText, "RailgunX Mock Backend")
    }

    func testUnknownBackendModeUsesTheRealBackend() {
        XCTAssertEqual(BackendMode(environment: ["RAILGUNX_BACKEND_MODE": "unexpected"]), .real)
    }

    func testMockBackendModeCanBeSelectedFromLaunchArguments() {
        XCTAssertEqual(
            BackendMode(environment: [:], arguments: ["RailgunX", "--railgunx-backend-mode=mock"]),
            .mock
        )
    }

    func testRunScriptLaunchesTheAppBundleThroughLaunchServices() throws {
        let runScript = try String(
            contentsOf: repositoryRoot.appendingPathComponent("scripts/run.sh"),
            encoding: .utf8
        )

        XCTAssertTrue(runScript.contains("open -n -W \"$app_bundle\""))
        XCTAssertTrue(runScript.contains("--railgunx-backend-mode=mock"))
        XCTAssertFalse(runScript.contains("launch_arguments"))
    }

    func testNativeBackendStagingContractUsesTheTargetArchitectureAndAtomicPayload() throws {
        let stagingScriptURL = repositoryRoot.appendingPathComponent("apps/macos/scripts/stage-backend.sh")
        let validationScriptURL = repositoryRoot.appendingPathComponent("apps/macos/scripts/validate-backend.sh")
        let projectURL = repositoryRoot.appendingPathComponent("apps/macos/project.yml")
        let stagingScript = try String(contentsOf: stagingScriptURL, encoding: .utf8)
        let validationScript = try String(contentsOf: validationScriptURL, encoding: .utf8)
        let project = try String(contentsOf: projectURL, encoding: .utf8)

        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: stagingScriptURL.path))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: validationScriptURL.path))
        XCTAssertTrue(stagingScript.contains("\"$staged_node\" \"$pnpm_cli\" --dir \"$repository_root\""))
        XCTAssertTrue(stagingScript.contains("node_gyp_script=\"$repository_root/node_modules/node-gyp/bin/node-gyp.js\""))
        XCTAssertTrue(stagingScript.contains("npm_config_build_from_source=true"))
        XCTAssertTrue(stagingScript.contains("--nodedir=\"$staged_node_root\""))
        XCTAssertTrue(stagingScript.contains("optional native dependencies are"))
        XCTAssertTrue(stagingScript.contains("sqlite-vec-darwin-$darwin_arch/vec0.dylib"))
        XCTAssertTrue(stagingScript.contains("mv \"$staging_backend\" \"$output/backend\""))
        XCTAssertTrue(validationScript.contains("for architecture in arm64 x86_64"))
        XCTAssertTrue(validationScript.contains("better-sqlite3"))
        XCTAssertTrue(validationScript.contains("sqliteVec.load(database)"))
        XCTAssertTrue(project.contains("preBuildScripts:"))
        XCTAssertTrue(project.contains("architecture=\"${CURRENT_ARCH:-}\""))
        XCTAssertTrue(project.contains("--architecture \"$architecture\""))
        XCTAssertTrue(project.contains("UNLOCALIZED_RESOURCES_FOLDER_PATH"))
    }

    func testLegalNoticesAreBundledWithTheApplication() throws {
        XCTAssertNotNil(LegalNotices.noticesURL)
        XCTAssertNotNil(LegalNotices.manifestURL)

        let manifest = try LegalNotices.loadManifest()
        XCTAssertFalse(manifest.components.isEmpty)
    }

    func testLegalNoticeManifestRecordsLockedSwiftPackagesAndRequiredFirstPartyMaterial() throws {
        let manifest = try LegalNotices.loadManifest()
        let records = Dictionary(uniqueKeysWithValues: manifest.components.map { ($0.identifier, $0) })

        XCTAssertEqual(records["swift-markdown"]?.version, "0.8.0")
        XCTAssertEqual(records["swift-markdown"]?.revision, "3c6f9523da3a1ec2fd829673e472d95b8097a3b8")
        XCTAssertEqual(records["swift-cmark"]?.version, "0.8.0")
        XCTAssertEqual(records["swift-cmark"]?.revision, "924936d0427cb25a61169739a7660230bffa6ea6")
        XCTAssertEqual(records["sparkle"]?.version, "2.9.4")
        XCTAssertEqual(records["sparkle"]?.revision, "b6496a74a087257ef5e6da1c5b29a447a60f5bd7")

        XCTAssertEqual(records["nodejs-24-lts"]?.version, "24.18.0")
        XCTAssertEqual(
            records["nodejs-24-lts"]?.archive,
            "node-v24.18.0-darwin-arm64.tar.xz; node-v24.18.0-darwin-x64.tar.xz"
        )
        XCTAssertEqual(records["railgun-icon-artwork"]?.copyright, "© 2026 Dante Teo")
        XCTAssertEqual(records["railgun"]?.license, "MIT")
    }

    func testLegalNoticeManifestContainsOnlyProductionBackendClosureWithBothMacOSNativeVariants() throws {
        let manifest = try LegalNotices.loadManifest()
        let backendRecords = manifest.components.filter { $0.kind == .backendProductionPackage }
        let backendNames = Set(backendRecords.map(\.name))

        XCTAssertFalse(backendRecords.isEmpty)
        XCTAssertFalse(backendNames.contains("tsx"))
        XCTAssertFalse(backendNames.contains("typescript"))
        XCTAssertFalse(backendNames.contains("vitest"))
        XCTAssertFalse(backendNames.contains("@types/better-sqlite3"))
        XCTAssertTrue(backendNames.contains("sqlite-vec-darwin-arm64"))
        XCTAssertTrue(backendNames.contains("sqlite-vec-darwin-x64"))
        XCTAssertTrue(backendRecords.allSatisfy { !$0.noticeContentSHA256.isEmpty })
    }

    func testLegalNoticeManifestTracksTheCheckedInBackendLockfileAndIncludesFullLGPLTerms() throws {
        let manifest = try LegalNotices.loadManifest()
        let lockfile = try Data(contentsOf: repositoryRoot.appendingPathComponent("pnpm-lock.yaml"))
        let notices = try String(contentsOf: try XCTUnwrap(LegalNotices.noticesURL), encoding: .utf8)

        XCTAssertEqual(manifest.backendLockfileSHA256, SHA256.hash(data: lockfile).hexString)
        XCTAssertTrue(notices.contains("GNU LESSER GENERAL PUBLIC LICENSE"))
    }

    func testLegalNoticeValidatorAcceptsTheCheckedInCatalogWithoutInstalledPackages() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "node",
            "apps/macos/scripts/generate-legal-notices.mjs",
            "--check"
        ]
        process.currentDirectoryURL = repositoryRoot
        let inheritedEnvironment = ProcessInfo.processInfo.environment
        let nodeSearchPath = [
            inheritedEnvironment["PATH"],
            "/opt/homebrew/bin",
            "/usr/local/bin"
        ]
        .compactMap { $0 }
        .joined(separator: ":")
        process.environment = inheritedEnvironment.merging(
            [
                "PATH": nodeSearchPath,
                "RAILGUN_LEGAL_SKIP_INSTALLED_PACKAGES": "1"
            ],
            uniquingKeysWith: { _, replacement in replacement }
        )

        try process.run()
        process.waitUntilExit()

        XCTAssertEqual(process.terminationStatus, 0)
    }
}

private extension Digest {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
