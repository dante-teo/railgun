import Foundation
import XCTest
import RailgunServices
import RailgunTransport

@MainActor
final class RailgunAuthenticationServiceTests: XCTestCase {
    func testBundledLaunchFactoryUsesStagedNodeAndIsolatesDesktopRPCMode() {
        let resources = URL(fileURLWithPath: "/private/tmp/RailgunX.app/Contents/Resources")
        let home = URL(fileURLWithPath: "/private/tmp/railgun-home")
        let factory = RailgunBundledBackendLaunchFactory(
            resourcesDirectory: resources,
            homeDirectory: home,
            inheritedEnvironment: [
                "DEVIN_TOKEN": "environment-managed-token",
                "RAILGUN_DESKTOP_RPC": "unexpected-inherited-value",
            ]
        )

        let desktop = factory.desktopRPCLaunch()
        XCTAssertEqual(desktop.executableURL.path, resources.appendingPathComponent("backend/node/bin/node").path)
        XCTAssertEqual(desktop.arguments, [resources.appendingPathComponent("backend/railgun/dist/backend.js").path, "desktop"])
        XCTAssertEqual(desktop.currentDirectoryURL, home)
        XCTAssertEqual(desktop.environment?["RAILGUN_DESKTOP_RPC"], "1")
        XCTAssertEqual(desktop.environment?["DEVIN_TOKEN"], "environment-managed-token")

        let helper = factory.authenticationHelperLaunch(for: .logout)
        XCTAssertEqual(helper.executableURL, desktop.executableURL)
        XCTAssertEqual(helper.arguments, [resources.appendingPathComponent("backend/railgun/dist/backend.js").path, "logout"])
        XCTAssertEqual(helper.currentDirectoryURL, home)
        XCTAssertNil(helper.environment?["RAILGUN_DESKTOP_RPC"])
        XCTAssertEqual(helper.environment?["DEVIN_TOKEN"], "environment-managed-token")
    }

    func testSuccessfulHelperRestartsTheRPCBackendAndDiscardsHelperOutput() async throws {
        let rpc = RailgunRPCClient()
        let desktopLaunch = perlLaunch(script: responsiveBackendScript)
        _ = try await rpc.start(desktopLaunch)
        let helperLaunch = shellLaunch(
            "printf 'OAuth bearer secret' >&1; printf 'credential warning' >&2; exit 0"
        )
        let service = authenticationService(
            rpc: rpc,
            desktopLaunch: desktopLaunch,
            helperLaunch: helperLaunch
        )

        XCTAssertEqual(try await service.login(), .ready)
        let response = try await rpc.request(Data(#"{"type":"list_sessions"}"#.utf8), timeout: .seconds(1))
        XCTAssertEqual(try responseObject(response)["id"] as? String, "request-2-1")
        await rpc.shutdown()
    }

    func testHelperFailureDoesNotRestartTheCurrentRPCBackendAndRemainsRedacted() async throws {
        let rpc = RailgunRPCClient()
        let desktopLaunch = perlLaunch(script: responsiveBackendScript)
        _ = try await rpc.start(desktopLaunch)
        let service = authenticationService(
            rpc: rpc,
            desktopLaunch: desktopLaunch,
            helperLaunch: shellLaunch("printf 'Bearer oauth-secret' >&2; exit 7")
        )

        do {
            _ = try await service.login()
            XCTFail("Expected the helper failure")
        } catch let error as RailgunAuthenticationError {
            XCTAssertEqual(error, .helperExited(status: 7))
            XCTAssertFalse(String(describing: error).contains("oauth-secret"))
        }

        let response = try await rpc.request(Data(#"{"type":"list_sessions"}"#.utf8), timeout: .seconds(1))
        XCTAssertEqual(try responseObject(response)["id"] as? String, "request-1-1")
        await rpc.shutdown()
    }

    func testAuthenticationOperationsAreSingleFlightAndShutdownTerminatesTheActiveHelper() async throws {
        let rpc = RailgunRPCClient()
        let service = authenticationService(
            rpc: rpc,
            desktopLaunch: perlLaunch(script: responsiveBackendScript),
            helperLaunch: perlLaunch(script: "$SIG{TERM} = sub { exit 0 }; sleep 10;")
        )
        let login = Task { () -> RailgunAuthenticationError? in
            do {
                _ = try await service.login()
                return nil
            } catch {
                return error as? RailgunAuthenticationError
            }
        }
        try await Task.sleep(for: .milliseconds(50))

        do {
            _ = try await service.logout()
            XCTFail("Expected the concurrent operation to be rejected")
        } catch let error as RailgunAuthenticationError {
            XCTAssertEqual(error, .operationInProgress)
        }

        await service.shutdown()
        XCTAssertEqual(await login.value, .shuttingDown)
    }

    func testLogoutAcceptsAFileAuthenticationRequiredRestartButLoginRequiresReady() async throws {
        let fileAuthenticationRequiredLaunch = perlLaunch(
            script: startupAuthenticationRequiredScript(source: .file)
        )

        let logoutRPC = RailgunRPCClient()
        _ = try await logoutRPC.start(perlLaunch(script: responsiveBackendScript))
        let logoutService = authenticationService(
            rpc: logoutRPC,
            desktopLaunch: fileAuthenticationRequiredLaunch,
            helperLaunch: BackendProcessLaunch(executableURL: URL(fileURLWithPath: "/usr/bin/true"))
        )
        XCTAssertEqual(
            try await logoutService.logout(),
            .authenticationRequired(source: .file)
        )

        let loginRPC = RailgunRPCClient()
        _ = try await loginRPC.start(perlLaunch(script: responsiveBackendScript))
        let loginService = authenticationService(
            rpc: loginRPC,
            desktopLaunch: fileAuthenticationRequiredLaunch,
            helperLaunch: BackendProcessLaunch(executableURL: URL(fileURLWithPath: "/usr/bin/true"))
        )
        do {
            _ = try await loginService.login()
            XCTFail("Login must require a ready backend")
        } catch let error as RailgunAuthenticationError {
            XCTAssertEqual(error, .backendRestartFailed)
        }

        let environmentRPC = RailgunRPCClient()
        _ = try await environmentRPC.start(perlLaunch(script: responsiveBackendScript))
        let environmentLogoutService = authenticationService(
            rpc: environmentRPC,
            desktopLaunch: perlLaunch(script: startupAuthenticationRequiredScript(source: .environment)),
            helperLaunch: BackendProcessLaunch(executableURL: URL(fileURLWithPath: "/usr/bin/true"))
        )
        do {
            _ = try await environmentLogoutService.logout()
            XCTFail("Environment-managed credentials must not be treated as a successful logout")
        } catch let error as RailgunAuthenticationError {
            XCTAssertEqual(error, .backendRestartFailed)
        }
    }

    private func authenticationService(
        rpc: RailgunRPCClient,
        desktopLaunch: BackendProcessLaunch,
        helperLaunch: BackendProcessLaunch
    ) -> RailgunAuthenticationService {
        RailgunAuthenticationService(
            rpcClient: rpc,
            desktopRPCLaunch: desktopLaunch,
            helperLaunch: { _ in helperLaunch }
        )
    }

    private func perlLaunch(script: String) -> BackendProcessLaunch {
        BackendProcessLaunch(
            executableURL: URL(fileURLWithPath: "/usr/bin/perl"),
            arguments: ["-e", script]
        )
    }

    private func shellLaunch(_ command: String) -> BackendProcessLaunch {
        BackendProcessLaunch(
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", command]
        )
    }

    private func responseObject(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func startupAuthenticationRequiredScript(source: RailgunRPCCredentialSource) -> String {
        #"""
    $| = 1;
    print "{\"type\":\"startup_status\",\"status\":\"authentication_required\",\"credential_source\":\"\#(source.rawValue)\"}\n";
    sleep 1;
    """
    }

    private let responsiveBackendScript = #"""
    $| = 1;
    while (<STDIN>) {
      my ($id) = /"id"\s*:\s*"([^"]+)"/;
      my ($type) = /"type"\s*:\s*"([^"]+)"/;
      if ($type eq "initialize") {
        print "{\"type\":\"response\",\"id\":\"$id\",\"command\":\"initialize\",\"success\":true,\"data\":{\"version\":1,\"capabilities\":[\"sessions\",\"interaction.approval\",\"interaction.clarification\"]}}\n";
      } elsif ($type eq "get_state") {
        print "{\"type\":\"response\",\"id\":\"$id\",\"command\":\"get_state\",\"success\":true,\"data\":{\"running\":false}}\n";
      } else {
        print "{\"type\":\"response\",\"id\":\"$id\",\"command\":\"$type\",\"success\":true,\"data\":{}}\n";
      }
    }
    """
}
