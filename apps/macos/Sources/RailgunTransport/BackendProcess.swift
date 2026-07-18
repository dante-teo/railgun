import Darwin
import Foundation

public struct BackendProcessLaunch: Sendable {
    public let executableURL: URL
    public let arguments: [String]
    public let currentDirectoryURL: URL?
    public let environment: [String: String]?

    public init(
        executableURL: URL,
        arguments: [String] = [],
        currentDirectoryURL: URL? = nil,
        environment: [String: String]? = nil
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.currentDirectoryURL = currentDirectoryURL
        self.environment = environment
    }
}

/// The three standard streams for one backend generation.
///
/// `FileHandle` is reference based, so callers must assign one reader to each
/// output pipe and one writer to the input pipe. The lifecycle actor remains
/// the sole owner of the child process itself.
public struct BackendProcessPipes: Sendable {
    public let standardInput: FileHandle
    public let standardOutput: FileHandle
    public let standardError: FileHandle

    init(input: FileHandle, output: FileHandle, error: FileHandle) {
        standardInput = input
        standardOutput = output
        standardError = error
    }
}

public enum BackendProcessExitReason: Sendable, Equatable {
    case exit
    case uncaughtSignal
}

public struct BackendProcessTermination: Sendable, Equatable {
    public let processIdentifier: Int32
    public let reason: BackendProcessExitReason
    public let status: Int32

    init(processIdentifier: Int32, reason: BackendProcessExitReason, status: Int32) {
        self.processIdentifier = processIdentifier
        self.reason = reason
        self.status = status
    }
}

public enum BackendProcessState: Sendable, Equatable {
    case idle
    case running(processIdentifier: Int32)
    case exited(BackendProcessTermination)
}

public enum BackendProcessError: Error, Sendable, Equatable {
    case alreadyRunning
    case launchFailed(String)
}

/// Owns exactly one backend child process and its stdio pipes at a time.
///
/// Framing and RPC ownership deliberately live above this actor. This layer
/// starts the backend, provides its raw pipes, and guarantees that shutdown
/// escalates from `SIGTERM` to `SIGKILL` after the supplied grace period.
public actor BackendProcess {
    private struct ActiveProcess {
        let process: Process
        let processIdentifier: Int32
        let standardInput: FileHandle
    }

    private var activeProcess: ActiveProcess?
    private var lastTermination: BackendProcessTermination?
    private var terminationWaiters: [CheckedContinuation<BackendProcessTermination?, Never>] = []
    private var forcedTerminationTask: Task<Void, Never>?

    public init() {}

    public var state: BackendProcessState {
        if let activeProcess {
            return .running(processIdentifier: activeProcess.processIdentifier)
        }
        if let lastTermination {
            return .exited(lastTermination)
        }
        return .idle
    }

    @discardableResult
    public func start(_ launch: BackendProcessLaunch) throws -> BackendProcessPipes {
        guard activeProcess == nil else {
            throw BackendProcessError.alreadyRunning
        }

        let process = Process()
        let standardInput = Pipe()
        let standardOutput = Pipe()
        let standardError = Pipe()
        // The backend may exit between an RPC lifecycle check and its write.
        // Surface that race as EPIPE instead of terminating the app.
        _ = Darwin.fcntl(
            standardInput.fileHandleForWriting.fileDescriptor,
            F_SETNOSIGPIPE,
            1
        )

        process.executableURL = launch.executableURL
        process.arguments = launch.arguments
        process.currentDirectoryURL = launch.currentDirectoryURL
        process.environment = launch.environment
        process.standardInput = standardInput
        process.standardOutput = standardOutput
        process.standardError = standardError
        process.terminationHandler = { [weak self] process in
            let reason: BackendProcessExitReason
            switch process.terminationReason {
            case .exit:
                reason = .exit
            case .uncaughtSignal:
                reason = .uncaughtSignal
            @unknown default:
                reason = .uncaughtSignal
            }

            let termination = BackendProcessTermination(
                processIdentifier: process.processIdentifier,
                reason: reason,
                status: process.terminationStatus
            )

            Task {
                await self?.recordTermination(termination)
            }
        }

        do {
            try process.run()
        } catch {
            standardInput.fileHandleForWriting.closeFile()
            standardOutput.fileHandleForReading.closeFile()
            standardError.fileHandleForReading.closeFile()
            throw BackendProcessError.launchFailed(error.localizedDescription)
        }

        let processIdentifier = process.processIdentifier
        activeProcess = ActiveProcess(
            process: process,
            processIdentifier: processIdentifier,
            standardInput: standardInput.fileHandleForWriting
        )
        lastTermination = nil

        return BackendProcessPipes(
            input: standardInput.fileHandleForWriting,
            output: standardOutput.fileHandleForReading,
            error: standardError.fileHandleForReading
        )
    }

    /// Closes stdin and sends `SIGTERM`; `SIGKILL` follows after `gracePeriod`
    /// only if the same backend generation is still running.
    public func terminate(gracePeriod: Duration = .seconds(2)) {
        guard let activeProcess else { return }

        activeProcess.standardInput.closeFile()
        guard activeProcess.process.isRunning else { return }

        activeProcess.process.terminate()
        scheduleForcedTermination(
            processIdentifier: activeProcess.processIdentifier,
            after: gracePeriod
        )
    }

    /// Sends `SIGKILL` to the active backend process immediately.
    @discardableResult
    public func forceTerminate() -> Bool {
        guard let activeProcess else { return false }
        activeProcess.standardInput.closeFile()
        return forceTerminate(processIdentifier: activeProcess.processIdentifier)
    }

    /// Stops the active backend and waits for its recorded termination.
    public func shutdown(gracePeriod: Duration = .seconds(2)) async -> BackendProcessTermination? {
        terminate(gracePeriod: gracePeriod)
        return await waitForTermination()
    }

    /// Waits for the active backend to exit, or returns the most recent exit
    /// when no backend is currently running.
    public func waitForTermination() async -> BackendProcessTermination? {
        guard activeProcess != nil else { return lastTermination }
        return await withCheckedContinuation { continuation in
            terminationWaiters.append(continuation)
        }
    }

    private func scheduleForcedTermination(processIdentifier: Int32, after gracePeriod: Duration) {
        forcedTerminationTask?.cancel()
        forcedTerminationTask = Task { [weak self] in
            do {
                try await Task.sleep(for: gracePeriod)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }
            await self?.forceTerminate(processIdentifier: processIdentifier)
        }
    }

    @discardableResult
    private func forceTerminate(processIdentifier: Int32) -> Bool {
        guard let activeProcess,
              activeProcess.processIdentifier == processIdentifier,
              activeProcess.process.isRunning
        else {
            return false
        }

        forcedTerminationTask?.cancel()
        forcedTerminationTask = nil
        return Darwin.kill(processIdentifier, SIGKILL) == 0
    }

    private func recordTermination(_ termination: BackendProcessTermination) {
        guard activeProcess?.processIdentifier == termination.processIdentifier else { return }

        activeProcess = nil
        lastTermination = termination
        forcedTerminationTask?.cancel()
        forcedTerminationTask = nil

        let waiters = terminationWaiters
        terminationWaiters.removeAll()
        waiters.forEach { $0.resume(returning: termination) }
    }
}
