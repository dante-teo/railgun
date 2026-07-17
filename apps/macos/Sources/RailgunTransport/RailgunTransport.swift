import Foundation

/// Limits and read sizes used by ``RailgunTransport``.
///
/// The default stdout limits match the existing Electron supervisor: a JSONL
/// frame may be at most 4 MiB and an unfinished stdout buffer may be at most
/// 8 MiB. Read sizes bound the amount of data retained for each pipe read;
/// they do not affect the accepted JSONL frame size. Stream capacities bound
/// data awaiting a consumer.
public struct RailgunTransportConfiguration: Sendable, Equatable {
    public static let electronCompatible = Self()

    public let maximumStdoutFrameBytes: Int
    public let maximumStdoutBufferBytes: Int
    public let stdoutReadChunkBytes: Int
    public let stderrReadChunkBytes: Int
    public let stdoutFrameBufferCapacity: Int
    public let stderrChunkBufferCapacity: Int

    public init(
        maximumStdoutFrameBytes: Int = 4 * 1024 * 1024,
        maximumStdoutBufferBytes: Int = 8 * 1024 * 1024,
        stdoutReadChunkBytes: Int = 64 * 1024,
        stderrReadChunkBytes: Int = 64 * 1024,
        stdoutFrameBufferCapacity: Int = 1,
        stderrChunkBufferCapacity: Int = 64
    ) {
        precondition(maximumStdoutFrameBytes > 0, "The stdout frame limit must be positive.")
        precondition(maximumStdoutBufferBytes > 0, "The stdout buffer limit must be positive.")
        precondition(stdoutReadChunkBytes > 0, "The stdout read chunk size must be positive.")
        precondition(stderrReadChunkBytes > 0, "The stderr read chunk size must be positive.")
        precondition(stdoutFrameBufferCapacity > 0, "The stdout stream capacity must be positive.")
        precondition(stderrChunkBufferCapacity > 0, "The stderr stream capacity must be positive.")

        self.maximumStdoutFrameBytes = maximumStdoutFrameBytes
        self.maximumStdoutBufferBytes = maximumStdoutBufferBytes
        self.stdoutReadChunkBytes = stdoutReadChunkBytes
        self.stderrReadChunkBytes = stderrReadChunkBytes
        self.stdoutFrameBufferCapacity = stdoutFrameBufferCapacity
        self.stderrChunkBufferCapacity = stderrChunkBufferCapacity
    }
}

/// A terminal failure while reading or validating backend stdout.
public enum RailgunTransportError: Error, Sendable, Equatable {
    case stdoutReadFailed(String)
    case stdoutFrameTooLarge(limit: Int)
    case stdoutBufferTooLarge(limit: Int)
    case stdoutFrameBufferOverflow(limit: Int)
    case malformedStdoutJSON
    case stdoutJSONWasNotAnObject
    case stdoutEndedWithPartialFrame
}

/// Concurrently reads a backend's raw output pipes.
///
/// Stdout is treated as untrusted JSONL: each nonempty line must be a JSON
/// object and is emitted as its original object bytes. Stderr is intentionally
/// opaque. This actor does not retain, log, redact, decode, or correlate either
/// stream; those policies belong to higher transport layers.
public actor RailgunTransport {
    public nonisolated let stdoutFrames: AsyncThrowingStream<Data, Error>
    public nonisolated let stderrChunks: AsyncStream<Data>

    private let configuration: RailgunTransportConfiguration
    private let standardOutput: FileHandle
    private let standardError: FileHandle
    private let stdoutContinuation: AsyncThrowingStream<Data, Error>.Continuation
    private let stderrContinuation: AsyncStream<Data>.Continuation
    private var stdoutReaderTask: Task<Void, Never>?
    private var stderrReaderTask: Task<Void, Never>?
    private var stdoutBuffer = Data()
    private var stdoutFinished = false
    private var stderrFinished = false
    private var isClosed = false

    public init(
        pipes: BackendProcessPipes,
        configuration: RailgunTransportConfiguration = .electronCompatible
    ) {
        self.configuration = configuration
        standardOutput = pipes.standardOutput
        standardError = pipes.standardError

        var capturedStdoutContinuation: AsyncThrowingStream<Data, Error>.Continuation!
        stdoutFrames = AsyncThrowingStream(
            bufferingPolicy: .bufferingOldest(configuration.stdoutFrameBufferCapacity)
        ) {
            capturedStdoutContinuation = $0
        }
        stdoutContinuation = capturedStdoutContinuation

        var capturedStderrContinuation: AsyncStream<Data>.Continuation!
        stderrChunks = AsyncStream(
            bufferingPolicy: .bufferingNewest(configuration.stderrChunkBufferCapacity)
        ) {
            capturedStderrContinuation = $0
        }
        stderrContinuation = capturedStderrContinuation

        capturedStdoutContinuation.onTermination = { [weak self] termination in
            guard case .cancelled = termination else { return }
            Task { await self?.close() }
        }
        capturedStderrContinuation.onTermination = { [weak self] termination in
            guard case .cancelled = termination else { return }
            Task { await self?.close() }
        }

        Task { [weak self] in
            await self?.startReaders()
        }
    }

    private func startReaders() {
        guard !isClosed, stdoutReaderTask == nil, stderrReaderTask == nil else { return }

        stdoutReaderTask = Self.makeReaderTask(
            handle: standardOutput,
            chunkSize: configuration.stdoutReadChunkBytes,
            dataReceived: { [weak self] data in
                await self?.consumeStdout(data)
            },
            endOfFile: { [weak self] in
                await self?.finishStdoutAtEndOfFile()
            },
            readFailed: { [weak self] error in
                await self?.failStdout(.stdoutReadFailed(error.localizedDescription))
            }
        )
        stderrReaderTask = Self.makeReaderTask(
            handle: standardError,
            chunkSize: configuration.stderrReadChunkBytes,
            dataReceived: { [weak self] data in
                await self?.consumeStderr(data)
            },
            endOfFile: { [weak self] in
                await self?.finishStderr()
            },
            readFailed: { [weak self] _ in
                await self?.finishStderr()
            }
        )
    }

    deinit {
        stdoutContinuation.finish()
        stderrContinuation.finish()
    }

    /// Finishes both public streams without terminating the backend process.
    ///
    /// The internal readers continue draining and discarding both pipes until
    /// EOF. Closing their read ends would cause a later child write to receive
    /// `SIGPIPE`, which would make transport closure terminate the backend.
    public func close() {
        guard !isClosed else { return }

        isClosed = true
        if !stdoutFinished {
            stdoutFinished = true
            stdoutContinuation.finish()
        }
        if !stderrFinished {
            stderrFinished = true
            stderrContinuation.finish()
        }
    }

    private static func makeReaderTask(
        handle: FileHandle,
        chunkSize: Int,
        dataReceived: @escaping @Sendable (Data) async -> Void,
        endOfFile: @escaping @Sendable () async -> Void,
        readFailed: @escaping @Sendable (Error) async -> Void
    ) -> Task<Void, Never> {
        Task.detached {
            do {
                while !Task.isCancelled {
                    guard let data = try handle.read(upToCount: chunkSize), !data.isEmpty else {
                        guard !Task.isCancelled else { return }
                        await endOfFile()
                        return
                    }
                    await dataReceived(data)
                }
            } catch {
                guard !Task.isCancelled else { return }
                await readFailed(error)
            }
        }
    }

    private func consumeStdout(_ data: Data) {
        guard !isClosed, !stdoutFinished else { return }

        stdoutBuffer.append(data)
        while let newlineOffset = stdoutBuffer.firstIndex(of: UInt8(ascii: "\n")) {
            var frame = stdoutBuffer.prefix(upTo: newlineOffset)
            stdoutBuffer.removeSubrange(...newlineOffset)

            if frame.last == UInt8(ascii: "\r") {
                frame.removeLast()
            }
            guard !frame.isEmpty else { continue }

            guard frame.count <= configuration.maximumStdoutFrameBytes else {
                failStdout(.stdoutFrameTooLarge(limit: configuration.maximumStdoutFrameBytes))
                return
            }
            guard let object = try? JSONSerialization.jsonObject(
                with: frame,
                options: .fragmentsAllowed
            ) else {
                failStdout(.malformedStdoutJSON)
                return
            }
            guard object is [String: Any] else {
                failStdout(.stdoutJSONWasNotAnObject)
                return
            }

            switch stdoutContinuation.yield(Data(frame)) {
            case .dropped:
                failStdout(.stdoutFrameBufferOverflow(limit: configuration.stdoutFrameBufferCapacity))
                return
            case .enqueued, .terminated:
                break
            @unknown default:
                break
            }
        }

        if stdoutBuffer.count > configuration.maximumStdoutFrameBytes {
            failStdout(.stdoutFrameTooLarge(limit: configuration.maximumStdoutFrameBytes))
        } else if stdoutBuffer.count > configuration.maximumStdoutBufferBytes {
            failStdout(.stdoutBufferTooLarge(limit: configuration.maximumStdoutBufferBytes))
        }
    }

    private func finishStdoutAtEndOfFile() {
        guard !isClosed, !stdoutFinished else { return }

        if stdoutBuffer.isEmpty {
            stdoutFinished = true
            stdoutContinuation.finish()
        } else {
            failStdout(.stdoutEndedWithPartialFrame)
        }
    }

    private func failStdout(_ error: RailgunTransportError) {
        guard !stdoutFinished else { return }

        stdoutFinished = true
        stdoutBuffer.removeAll(keepingCapacity: false)
        // Keep draining after failing the public stream so the backend neither
        // blocks on a full pipe nor receives SIGPIPE from a closed read end.
        stdoutContinuation.finish(throwing: error)
    }

    private func consumeStderr(_ data: Data) {
        guard !isClosed, !stderrFinished else { return }
        _ = stderrContinuation.yield(data)
    }

    private func finishStderr() {
        guard !stderrFinished else { return }
        stderrFinished = true
        stderrContinuation.finish()
    }
}
