import Foundation

/// Configuration for the version 1 Railgun RPC connection.
public struct RailgunRPCConfiguration: Sendable, Equatable {
    public static let version1 = Self()

    public let protocolVersion: Int
    public let clientName: String
    public let startupDeadline: Duration
    public let requiredCapabilities: Set<String>
    public let terminationGracePeriod: Duration

    public init(
        protocolVersion: Int = 1,
        clientName: String = "railgunx",
        startupDeadline: Duration = .seconds(15),
        requiredCapabilities: Set<String> = [
            "sessions",
            "interaction.approval",
            "interaction.clarification",
        ],
        terminationGracePeriod: Duration = .seconds(2)
    ) {
        precondition(protocolVersion > 0, "The protocol version must be positive.")
        precondition(!clientName.isEmpty, "The client name must not be empty.")
        precondition(startupDeadline > .zero, "The startup deadline must be positive.")
        precondition(!requiredCapabilities.isEmpty, "At least one capability must be required.")
        precondition(terminationGracePeriod >= .zero, "The termination grace period cannot be negative.")

        self.protocolVersion = protocolVersion
        self.clientName = clientName
        self.startupDeadline = startupDeadline
        self.requiredCapabilities = requiredCapabilities
        self.terminationGracePeriod = terminationGracePeriod
    }
}

/// The protocol details negotiated during a successful backend handshake.
public struct RailgunRPCHandshake: Sendable, Equatable {
    public let protocolVersion: Int
    public let capabilities: Set<String>

    public init(protocolVersion: Int, capabilities: Set<String>) {
        self.protocolVersion = protocolVersion
        self.capabilities = capabilities
    }
}

/// Failures reported by ``RailgunRPCClient``.
public enum RailgunRPCError: Error, Sendable, Equatable {
    case alreadyStarted
    case notReady
    case invalidRequestPayload
    case requestPayloadContainsID
    case startupRejected(command: String, reason: String?)
    case protocolVersionMismatch(expected: Int, received: Int)
    case missingRequiredCapabilities(Set<String>)
    case malformedResponse
    case mismatchedResponse(expectedCommand: String, receivedCommand: String)
    case backendTerminated
    case transportFailure(String)
    case cancelled
    case timeout
}

/// Coordinates one generation of the Railgun RPC backend.
///
/// This layer owns process lifetime, startup negotiation, and response
/// correlation. It intentionally returns raw response objects: command DTOs
/// and event normalization are owned by higher-level protocol features.
public actor RailgunRPCClient {
    private enum Lifecycle {
        case starting
        case ready
    }

    private struct PendingRequest {
        let command: String
        let continuation: CheckedContinuation<Data, Error>
        let timeoutTask: Task<Void, Never>
    }

    private let backend: BackendProcess
    private let configuration: RailgunRPCConfiguration
    private let transportConfiguration: RailgunTransportConfiguration

    private var transport: RailgunTransport?
    private var standardInput: FileHandle?
    private var readerTask: Task<Void, Never>?
    private var terminationTask: Task<Void, Never>?
    private var lifecycle: Lifecycle?
    private var activeGeneration: Int?
    private var generation = 0
    private var nextRequestSequence = 0
    private var pendingRequests: [String: PendingRequest] = [:]
    private var requestIDsAwaitingSettlement: Set<String> = []
    private var cancelledRequestIDs: Set<String> = []
    private var handshake: RailgunRPCHandshake?

    public init(
        backend: BackendProcess = BackendProcess(),
        configuration: RailgunRPCConfiguration = .version1,
        transportConfiguration: RailgunTransportConfiguration = .rpcCompatible
    ) {
        self.backend = backend
        self.configuration = configuration
        self.transportConfiguration = transportConfiguration
    }

    /// The most recently negotiated handshake while this client is ready.
    public var negotiatedHandshake: RailgunRPCHandshake? {
        handshake
    }

    /// Starts a new backend generation and waits for initialize plus get_state.
    @discardableResult
    public func start(_ launch: BackendProcessLaunch) async throws -> RailgunRPCHandshake {
        guard activeGeneration == nil else {
            throw RailgunRPCError.alreadyStarted
        }

        generation += 1
        let currentGeneration = generation
        let pipes = try await backend.start(launch)

        let currentTransport = RailgunTransport(
            pipes: pipes,
            configuration: transportConfiguration
        )
        transport = currentTransport
        standardInput = pipes.standardInput
        activeGeneration = currentGeneration
        lifecycle = .starting
        nextRequestSequence = 0

        readerTask = Task { [weak self, currentTransport] in
            do {
                for try await frame in currentTransport.stdoutFrames {
                    await self?.receive(frame, from: currentGeneration)
                }
                await self?.stdoutEnded(for: currentGeneration)
            } catch {
                await self?.stdoutFailed(error, for: currentGeneration)
            }
        }
        terminationTask = Task { [weak self, backend] in
            _ = await backend.waitForTermination()
            await self?.backendDidTerminate(generation: currentGeneration)
        }

        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: configuration.startupDeadline)

        do {
            let initializeResponse = try await send(
                command: "initialize",
                payload: [
                    "type": "initialize",
                    "clientName": configuration.clientName,
                    "version": configuration.protocolVersion,
                ],
                identifier: "initialize-\(currentGeneration)",
                timeout: configuration.startupDeadline
            )
            let negotiatedHandshake = try validateHandshake(in: initializeResponse)

            let remaining = clock.now.duration(to: deadline)
            guard remaining > .zero else {
                throw RailgunRPCError.timeout
            }
            let readinessResponse = try await send(
                command: "get_state",
                payload: ["type": "get_state"],
                identifier: "get-state-\(currentGeneration)",
                timeout: remaining
            )
            try validateSuccessfulReadinessResponse(readinessResponse)

            guard activeGeneration == currentGeneration else {
                throw RailgunRPCError.backendTerminated
            }
            handshake = negotiatedHandshake
            lifecycle = .ready
            return negotiatedHandshake
        } catch {
            await endGeneration(currentGeneration, error: normalized(error), terminateBackend: true)
            throw normalized(error)
        }
    }

    /// Stops the current generation, then starts a fresh one.
    @discardableResult
    public func restart(_ launch: BackendProcessLaunch) async throws -> RailgunRPCHandshake {
        await shutdown()
        return try await start(launch)
    }

    /// Invalidates every pending call and gracefully terminates the backend.
    public func shutdown() async {
        guard let currentGeneration = activeGeneration else { return }
        await endGeneration(
            currentGeneration,
            error: .backendTerminated,
            terminateBackend: true
        )
    }

    /// Sends an ordinary RPC request and returns its matched raw response.
    ///
    /// `payload` must encode a JSON object with a string `type` field and no
    /// `id`. The actor creates the request ID and adds the JSONL delimiter.
    public func request(_ payload: Data, timeout: Duration) async throws -> Data {
        guard timeout > .zero else { throw RailgunRPCError.timeout }
        guard !Task.isCancelled else { throw RailgunRPCError.cancelled }
        guard case .ready = lifecycle, let currentGeneration = activeGeneration else {
            throw RailgunRPCError.notReady
        }

        let object = try requestObject(from: payload)
        guard object["id"] == nil else { throw RailgunRPCError.requestPayloadContainsID }
        guard let command = object["type"] as? String, !command.isEmpty else {
            throw RailgunRPCError.invalidRequestPayload
        }

        nextRequestSequence += 1
        let identifier = "request-\(currentGeneration)-\(nextRequestSequence)"
        let requestData = try encodedRequestData(payload: object, identifier: identifier)
        return try await awaitResponse(
            command: command,
            identifier: identifier,
            requestData: requestData,
            timeout: timeout
        )
    }

    private func send(
        command: String,
        payload: [String: Any],
        identifier: String,
        timeout: Duration
    ) async throws -> Data {
        let requestData = try encodedRequestData(payload: payload, identifier: identifier)
        return try await awaitResponse(
            command: command,
            identifier: identifier,
            requestData: requestData,
            timeout: timeout
        )
    }

    private func awaitResponse(
        command: String,
        identifier: String,
        requestData: Data,
        timeout: Duration
    ) async throws -> Data {
        requestIDsAwaitingSettlement.insert(identifier)
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                enqueue(
                    command: command,
                    identifier: identifier,
                    requestData: requestData,
                    timeout: timeout,
                    continuation: continuation
                )
            }
        }, onCancel: {
            Task { [weak self] in
                await self?.cancelRequest(identifier)
            }
        })
    }

    private func enqueue(
        command: String,
        identifier: String,
        requestData: Data,
        timeout: Duration,
        continuation: CheckedContinuation<Data, Error>
    ) {
        guard activeGeneration != nil, standardInput != nil else {
            requestIDsAwaitingSettlement.remove(identifier)
            continuation.resume(throwing: RailgunRPCError.backendTerminated)
            return
        }
        if cancelledRequestIDs.remove(identifier) != nil {
            requestIDsAwaitingSettlement.remove(identifier)
            continuation.resume(throwing: RailgunRPCError.cancelled)
            return
        }

        let timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: timeout)
            } catch {
                return
            }
            await self?.timeoutRequest(identifier)
        }
        pendingRequests[identifier] = PendingRequest(
            command: command,
            continuation: continuation,
            timeoutTask: timeoutTask
        )

        var jsonLine = requestData
        jsonLine.append(UInt8(ascii: "\n"))
        standardInput?.write(jsonLine)
    }

    private func receive(_ frame: Data, from currentGeneration: Int) {
        guard activeGeneration == currentGeneration else { return }
        guard let object = try? requestObject(from: frame), object["type"] as? String == "response" else {
            return
        }
        guard let identifier = object["id"] as? String, let pending = pendingRequests[identifier] else {
            return
        }
        guard let command = object["command"] as? String,
              object["success"] is Bool
        else {
            settle(identifier, with: .failure(.malformedResponse))
            return
        }
        guard command == pending.command else {
            settle(
                identifier,
                with: .failure(
                    .mismatchedResponse(expectedCommand: pending.command, receivedCommand: command)
                )
            )
            return
        }
        settle(identifier, with: .success(frame))
    }

    private func stdoutEnded(for currentGeneration: Int) async {
        await endGeneration(currentGeneration, error: .backendTerminated, terminateBackend: true)
    }

    private func stdoutFailed(_ error: Error, for currentGeneration: Int) async {
        await endGeneration(
            currentGeneration,
            error: .transportFailure(String(describing: error)),
            terminateBackend: true
        )
    }

    private func backendDidTerminate(generation currentGeneration: Int) async {
        await endGeneration(currentGeneration, error: .backendTerminated, terminateBackend: false)
    }

    private func timeoutRequest(_ identifier: String) {
        settle(identifier, with: .failure(.timeout))
    }

    private func cancelRequest(_ identifier: String) {
        guard requestIDsAwaitingSettlement.contains(identifier) else { return }
        guard pendingRequests[identifier] != nil else {
            cancelledRequestIDs.insert(identifier)
            return
        }
        settle(identifier, with: .failure(.cancelled))
    }

    private func settle(_ identifier: String, with result: Result<Data, RailgunRPCError>) {
        guard let pending = pendingRequests.removeValue(forKey: identifier) else { return }
        requestIDsAwaitingSettlement.remove(identifier)
        pending.timeoutTask.cancel()
        switch result {
        case let .success(response):
            pending.continuation.resume(returning: response)
        case let .failure(error):
            pending.continuation.resume(throwing: error)
        }
    }

    private func endGeneration(
        _ currentGeneration: Int,
        error: RailgunRPCError,
        terminateBackend: Bool
    ) async {
        guard activeGeneration == currentGeneration else { return }

        activeGeneration = nil
        lifecycle = nil
        handshake = nil
        standardInput = nil
        let pending = pendingRequests
        pendingRequests.removeAll()
        requestIDsAwaitingSettlement.subtract(pending.keys)
        cancelledRequestIDs.removeAll()
        pending.values.forEach { pendingRequest in
            pendingRequest.timeoutTask.cancel()
            pendingRequest.continuation.resume(throwing: error)
        }

        readerTask?.cancel()
        readerTask = nil
        terminationTask?.cancel()
        terminationTask = nil

        let currentTransport = transport
        transport = nil
        await currentTransport?.close()
        if terminateBackend {
            _ = await backend.shutdown(gracePeriod: configuration.terminationGracePeriod)
        }
    }

    private func requestObject(from data: Data) throws -> [String: Any] {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            throw RailgunRPCError.invalidRequestPayload
        }
        return dictionary
    }

    private func encodedRequestData(
        payload: [String: Any],
        identifier: String
    ) throws -> Data {
        var request = payload
        request["id"] = identifier
        return try JSONSerialization.data(withJSONObject: request)
    }

    private func validateHandshake(in response: Data) throws -> RailgunRPCHandshake {
        let object = try responseObject(from: response)
        guard object["success"] as? Bool == true else {
            throw RailgunRPCError.startupRejected(
                command: "initialize",
                reason: object["error"] as? String
            )
        }
        guard let data = object["data"] as? [String: Any],
              let version = data["version"] as? Int,
              let capabilityValues = data["capabilities"] as? [String]
        else {
            throw RailgunRPCError.malformedResponse
        }
        guard version == configuration.protocolVersion else {
            throw RailgunRPCError.protocolVersionMismatch(
                expected: configuration.protocolVersion,
                received: version
            )
        }

        let capabilities = Set(capabilityValues)
        let missingCapabilities = configuration.requiredCapabilities.subtracting(capabilities)
        guard missingCapabilities.isEmpty else {
            throw RailgunRPCError.missingRequiredCapabilities(missingCapabilities)
        }
        return RailgunRPCHandshake(protocolVersion: version, capabilities: capabilities)
    }

    private func validateSuccessfulReadinessResponse(_ response: Data) throws {
        let object = try responseObject(from: response)
        guard object["success"] as? Bool == true else {
            throw RailgunRPCError.startupRejected(
                command: "get_state",
                reason: object["error"] as? String
            )
        }
    }

    private func responseObject(from response: Data) throws -> [String: Any] {
        guard let object = try? JSONSerialization.jsonObject(with: response),
              let dictionary = object as? [String: Any],
              dictionary["type"] as? String == "response"
        else {
            throw RailgunRPCError.malformedResponse
        }
        return dictionary
    }

    private func normalized(_ error: Error) -> RailgunRPCError {
        if error is CancellationError {
            return .cancelled
        }
        return error as? RailgunRPCError ?? .backendTerminated
    }
}
