import Foundation
import RailgunTransport

/// Authentication operations supported by the bundled backend.
public enum RailgunAuthenticationAction: String, Sendable, Equatable {
    case login
    case logout
}

/// The state of the RPC backend after an authentication operation completes.
public enum RailgunAuthenticationOutcome: Sendable, Equatable {
    case ready
    case authenticationRequired(source: RailgunRPCCredentialSource)
}

/// Authentication failures safe to present or log.
///
/// In particular, helper stdout/stderr and launch diagnostics are never
/// retained here because they can contain OAuth or credential details.
public enum RailgunAuthenticationError: Error, Sendable, Equatable {
    case operationInProgress
    case helperFailedToStart
    case helperExited(status: Int32)
    case helperTerminated
    case backendRestartFailed
    case shuttingDown
}

/// Builds launches for the production backend staged in an app bundle.
///
/// Both backend modes run from the user's home directory so the backend never
/// treats the app bundle as a user workspace. The RPC process is explicitly
/// isolated with `RAILGUN_DESKTOP_RPC`; helpers intentionally remove it.
public struct RailgunBundledBackendLaunchFactory: Sendable {
    public let resourcesDirectory: URL
    public let homeDirectory: URL
    public let inheritedEnvironment: [String: String]

    public init(
        resourcesDirectory: URL,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        inheritedEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.resourcesDirectory = resourcesDirectory.standardizedFileURL
        self.homeDirectory = homeDirectory.standardizedFileURL
        self.inheritedEnvironment = inheritedEnvironment
    }

    public func desktopRPCLaunch() -> BackendProcessLaunch {
        var environment = inheritedEnvironment
        environment["RAILGUN_DESKTOP_RPC"] = "1"
        return BackendProcessLaunch(
            executableURL: nodeURL,
            arguments: [backendURL.path, "desktop"],
            currentDirectoryURL: homeDirectory,
            environment: environment
        )
    }

    public func authenticationHelperLaunch(
        for action: RailgunAuthenticationAction
    ) -> BackendProcessLaunch {
        var environment = inheritedEnvironment
        environment.removeValue(forKey: "RAILGUN_DESKTOP_RPC")
        return BackendProcessLaunch(
            executableURL: nodeURL,
            arguments: [backendURL.path, action.rawValue],
            currentDirectoryURL: homeDirectory,
            environment: environment
        )
    }

    private var nodeURL: URL {
        resourcesDirectory.appendingPathComponent("backend/node/bin/node")
    }

    private var backendURL: URL {
        resourcesDirectory.appendingPathComponent("backend/railgun/dist/backend.js")
    }
}

/// Serializes browser-backed login/logout helpers with coordinated RPC restart.
///
/// The running RPC backend remains available while a helper is active. Only a
/// zero-exit helper permits replacing it with a fresh RPC generation.
public actor RailgunAuthenticationService {
    private let rpcClient: RailgunRPCClient
    private let desktopRPCLaunch: BackendProcessLaunch
    private let helperLaunch: @Sendable (RailgunAuthenticationAction) -> BackendProcessLaunch

    private var activeHelper: BackendProcess?
    private var operationIsActive = false
    private var isShuttingDown = false

    public init(
        rpcClient: RailgunRPCClient,
        launchFactory: RailgunBundledBackendLaunchFactory
    ) {
        self.init(
            rpcClient: rpcClient,
            desktopRPCLaunch: launchFactory.desktopRPCLaunch(),
            helperLaunch: { action in launchFactory.authenticationHelperLaunch(for: action) }
        )
    }

    /// Dependency-injection initializer for controlled launch environments.
    public init(
        rpcClient: RailgunRPCClient,
        desktopRPCLaunch: BackendProcessLaunch,
        helperLaunch: @escaping @Sendable (RailgunAuthenticationAction) -> BackendProcessLaunch
    ) {
        self.rpcClient = rpcClient
        self.desktopRPCLaunch = desktopRPCLaunch
        self.helperLaunch = helperLaunch
    }

    public func authenticate(
        _ action: RailgunAuthenticationAction
    ) async throws -> RailgunAuthenticationOutcome {
        guard !isShuttingDown else { throw RailgunAuthenticationError.shuttingDown }
        guard !operationIsActive else { throw RailgunAuthenticationError.operationInProgress }
        operationIsActive = true
        defer { operationIsActive = false }

        try await runHelper(action)
        guard !isShuttingDown else { throw RailgunAuthenticationError.shuttingDown }

        do {
            _ = try await rpcClient.restart(desktopRPCLaunch)
            return .ready
        } catch let error as RailgunRPCError {
            if action == .logout,
               error == .authenticationRequired(source: .file) {
                return .authenticationRequired(source: .file)
            }
            throw RailgunAuthenticationError.backendRestartFailed
        } catch {
            throw RailgunAuthenticationError.backendRestartFailed
        }
    }

    public func login() async throws -> RailgunAuthenticationOutcome {
        try await authenticate(.login)
    }

    public func logout() async throws -> RailgunAuthenticationOutcome {
        try await authenticate(.logout)
    }

    /// Terminates an active helper and prevents a subsequent RPC restart.
    public func shutdown() async {
        isShuttingDown = true
        guard let activeHelper else { return }
        _ = await activeHelper.shutdown()
    }

    private func runHelper(_ action: RailgunAuthenticationAction) async throws {
        let helper = BackendProcess()
        activeHelper = helper
        defer {
            if activeHelper === helper {
                activeHelper = nil
            }
        }

        let pipes: BackendProcessPipes
        do {
            pipes = try await helper.start(helperLaunch(action))
        } catch {
            throw RailgunAuthenticationError.helperFailedToStart
        }

        // The helper may print OAuth URLs, browser-flow diagnostics, or
        // credential errors. Consume both streams without retaining data.
        let stdoutDrain = Task.detached { await Self.drain(pipes.standardOutput) }
        let stderrDrain = Task.detached { await Self.drain(pipes.standardError) }
        let termination = await helper.waitForTermination()
        _ = await stdoutDrain.value
        _ = await stderrDrain.value

        guard !isShuttingDown else { throw RailgunAuthenticationError.shuttingDown }
        guard let termination else { throw RailgunAuthenticationError.helperTerminated }
        guard termination.reason == .exit else { throw RailgunAuthenticationError.helperTerminated }
        guard termination.status == 0 else {
            throw RailgunAuthenticationError.helperExited(status: termination.status)
        }
    }

    nonisolated private static func drain(_ handle: FileHandle) async {
        do {
            for try await _ in handle.bytes {}
        } catch {
            // Child output is intentionally discarded, including read errors.
        }
    }
}
