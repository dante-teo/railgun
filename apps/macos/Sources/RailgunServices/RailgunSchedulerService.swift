import Foundation
import RailgunTransport

/// Owns the private backend scheduler for the lifetime of the desktop app.
///
/// The scheduler does not use the desktop RPC protocol, but its output must
/// still be drained so diagnostic logging cannot block scheduled execution.
public actor RailgunSchedulerService {
    private let launch: BackendProcessLaunch
    private let process = BackendProcess()
    private var outputDrains: [Task<Void, Never>] = []

    public init(launch: BackendProcessLaunch) {
        self.launch = launch
    }

    public func isRunning() async -> Bool {
        guard case .running = await process.state else { return false }
        return true
    }

    /// Starts the processor once. A healthy existing process is retained
    /// across desktop RPC restarts.
    public func start() async throws {
        if await isRunning() { return }

        let pipes = try await process.start(launch)
        outputDrains = [
            Task.detached { await Self.drain(pipes.standardOutput) },
            Task.detached { await Self.drain(pipes.standardError) },
        ]
    }

    public func shutdown() async {
        outputDrains.forEach { $0.cancel() }
        outputDrains.removeAll()
        _ = await process.shutdown()
    }

    nonisolated private static func drain(_ handle: FileHandle) async {
        do {
            for try await _ in handle.bytes {}
        } catch {
            // Scheduler diagnostics are intentionally not surfaced in the UI.
        }
    }
}
