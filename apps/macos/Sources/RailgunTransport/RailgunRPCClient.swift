import Foundation

/// Configuration for the version 1 Railgun RPC connection.
public struct RailgunRPCConfiguration: Sendable, Equatable {
    public static let version1 = Self()

    public let protocolVersion: Int
    public let clientName: String
    public let startupDeadline: Duration
    public let interactionResponseDeadline: Duration
    public let requiredCapabilities: Set<String>
    public let terminationGracePeriod: Duration

    public init(
        protocolVersion: Int = 1,
        clientName: String = "railgunx",
        startupDeadline: Duration = .seconds(15),
        interactionResponseDeadline: Duration = .seconds(15),
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
        precondition(interactionResponseDeadline > .zero, "The interaction response deadline must be positive.")
        precondition(!requiredCapabilities.isEmpty, "At least one capability must be required.")
        precondition(terminationGracePeriod >= .zero, "The termination grace period cannot be negative.")

        self.protocolVersion = protocolVersion
        self.clientName = clientName
        self.startupDeadline = startupDeadline
        self.interactionResponseDeadline = interactionResponseDeadline
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

/// The credential location reported by a backend that cannot authenticate.
///
/// This deliberately models only the values emitted by the bundled backend.
/// Unknown values are treated as ordinary, ignored startup frames.
public enum RailgunRPCCredentialSource: String, Sendable, Equatable {
    case file
    case environment
}

/// Failures reported by ``RailgunRPCClient``.
public enum RailgunRPCError: Error, Sendable, Equatable {
    case alreadyStarted
    case notReady
    case invalidRequestPayload
    case requestPayloadContainsID
    case startupRejected(command: String, reason: String?)
    case authenticationRequired(source: RailgunRPCCredentialSource)
    case protocolVersionMismatch(expected: Int, received: Int)
    case missingRequiredCapabilities(Set<String>)
    case malformedResponse
    case mismatchedResponse(expectedCommand: String, receivedCommand: String)
    case backendTerminated
    case transportFailure(String)
    case cancelled
    case timeout
    case unknownInteraction
    case mismatchedInteractionKind(expected: RailgunRPCInteractionKind, received: RailgunRPCInteractionKind)
    case interactionResponseInFlight
    case invalidInteractionResponse
}

/// Coordinates one generation of the Railgun RPC backend.
///
/// This layer owns process lifetime, startup negotiation, and response
/// correlation. It intentionally returns raw response objects: command DTOs
/// and event normalization are owned by higher-level protocol features.
public actor RailgunRPCClient {
    private static let declinedClarificationAnswer = "[user declined to answer]"

    private enum Lifecycle {
        case starting
        case ready
    }

    private struct PendingRequest {
        let command: String
        let continuation: CheckedContinuation<Data, Error>
        let timeoutTask: Task<Void, Never>
    }

    private struct PendingInteraction {
        let kind: RailgunRPCInteractionKind
        let backendRequestID: String
    }

    private let backend: BackendProcess
    private let configuration: RailgunRPCConfiguration
    private let transportConfiguration: RailgunTransportConfiguration
    private let eventContinuation: AsyncStream<RailgunAgentEvent>.Continuation
    private let interactionContinuation: AsyncStream<RailgunRPCInteraction>.Continuation
    private let unexpectedTerminationContinuation: AsyncStream<Void>.Continuation

    /// Normalized backend activity. The stream survives backend restarts and
    /// uses a bounded newest-value buffer so an unobserved UI cannot stall RPC
    /// response handling.
    public nonisolated let events: AsyncStream<RailgunAgentEvent>

    /// Presentation-safe approval and clarification requests in backend arrival
    /// order. The queue retains the oldest 128 prompts; a newer prompt that
    /// cannot be delivered is safely denied rather than left unresolved.
    /// Backend request identifiers never enter this stream.
    public nonisolated let interactions: AsyncStream<RailgunRPCInteraction>

    /// Emits when a ready backend generation ends without an explicit client
    /// shutdown. Consumers can use this to update connection presentation.
    public nonisolated let unexpectedTerminations: AsyncStream<Void>

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
    private var pendingInteractions: [String: PendingInteraction] = [:]
    private var correlationIDsByBackendRequestID: [String: String] = [:]
    private var submittingInteractionIDs: Set<String> = []
    private var nextInteractionSequence = 0
    private var interactionEpoch = 0
    private var handshake: RailgunRPCHandshake?
    private var startupFailure: RailgunRPCError?

    public init(
        backend: BackendProcess = BackendProcess(),
        configuration: RailgunRPCConfiguration = .version1,
        transportConfiguration: RailgunTransportConfiguration = .rpcCompatible
    ) {
        let eventStream = AsyncStream<RailgunAgentEvent>.makeStream(
            bufferingPolicy: .bufferingNewest(128)
        )
        self.backend = backend
        self.configuration = configuration
        self.transportConfiguration = transportConfiguration
        self.events = eventStream.stream
        self.eventContinuation = eventStream.continuation

        let interactionStream = AsyncStream<RailgunRPCInteraction>.makeStream(
            bufferingPolicy: .bufferingOldest(128)
        )
        self.interactions = interactionStream.stream
        self.interactionContinuation = interactionStream.continuation

        let unexpectedTerminationStream = AsyncStream<Void>.makeStream(
            bufferingPolicy: .bufferingNewest(1)
        )
        self.unexpectedTerminations = unexpectedTerminationStream.stream
        self.unexpectedTerminationContinuation = unexpectedTerminationStream.continuation
    }

    deinit {
        eventContinuation.finish()
        interactionContinuation.finish()
        unexpectedTerminationContinuation.finish()
    }

    /// The most recently negotiated handshake while this client is ready.
    public var negotiatedHandshake: RailgunRPCHandshake? {
        handshake
    }

    /// The number of unresolved approval or clarification prompts.
    public var pendingInteractionCount: Int {
        pendingInteractions.count
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
        startupFailure = nil

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

    /// Sends a validated version 1 command and decodes its response envelope.
    /// Prefer this overload for new call sites; the raw-data overload remains
    /// available for fixture replay and forward-compatible transport probes.
    public func request(_ command: RailgunRPCCommand, timeout: Duration) async throws -> RailgunRPCResponse {
        let response = try await request(command.encodedData(), timeout: timeout)
        do {
            return try RailgunRPCResponse(data: response)
        } catch {
            throw RailgunRPCError.malformedResponse
        }
    }

    /// Resolves an approval request using its opaque client-side identifier.
    public func respondToApproval(id: String, approved: Bool) async throws {
        try validateInteractionCorrelationID(id)
        try await respondToInteraction(
            id: id,
            expectedKind: .approval,
            command: RailgunRPCCommand(
                type: .approvalResponse,
                fields: ["requestId": .string(try backendRequestID(for: id, expectedKind: .approval)), "approved": .bool(approved)]
            )
        )
    }

    /// Resolves a clarification request using its opaque client-side
    /// identifier. The answer is validated before it crosses the boundary.
    public func respondToClarification(id: String, answer: String) async throws {
        try validateInteractionCorrelationID(id)
        let validAnswer = try RailgunRPCInteractionRequest.validateClarificationAnswer(answer)
        try await respondToInteraction(
            id: id,
            expectedKind: .clarification,
            command: RailgunRPCCommand(
                type: .clarificationResponse,
                fields: ["requestId": .string(try backendRequestID(for: id, expectedKind: .clarification)), "answer": .string(validAnswer)]
            )
        )
    }

    /// Produces a bounded, redacted summary suitable for diagnostics. Raw RPC
    /// payloads must never be written to logs or observable feature state.
    public nonisolated static func safeDiagnosticSummary(for frame: Data) -> String {
        guard let value = try? JSONDecoder().decode(RailgunJSONValue.self, from: frame) else {
            return "malformed JSONL frame"
        }
        return RailgunRPCRedactor.diagnosticSummary(for: value)
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
        if let startupFailure {
            throw startupFailure
        }
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
        if let startupFailure {
            requestIDsAwaitingSettlement.remove(identifier)
            continuation.resume(throwing: startupFailure)
            return
        }
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
        do {
            try standardInput?.write(contentsOf: jsonLine)
        } catch {
            settle(identifier, with: .failure(.backendTerminated))
        }
    }

    private func receive(_ frame: Data, from currentGeneration: Int) {
        guard activeGeneration == currentGeneration else { return }
        guard startupFailure == nil else { return }
        if let source = authenticationRequiredSource(from: frame) {
            failStartup(with: .authenticationRequired(source: source))
            return
        }
        guard let object = try? requestObject(from: frame) else {
            return
        }
        guard object["type"] as? String == "response" else {
            receiveInteractionOrSettleInvalidFrame(frame, generation: currentGeneration)
            if let event = RailgunRPCEventNormalizer.normalize(frame) {
                if event == .runEnded {
                    settleInteractions()
                }
                eventContinuation.yield(event)
            }
            return
        }
        guard let identifier = object["id"] as? String, let pending = pendingRequests[identifier] else {
            return
        }
        guard let response = try? RailgunRPCResponse(data: frame) else {
            settle(identifier, with: .failure(.malformedResponse))
            return
        }
        guard response.command == pending.command else {
            settle(
                identifier,
                with: .failure(
                    .mismatchedResponse(expectedCommand: pending.command, receivedCommand: response.command)
                )
            )
            return
        }
        settle(identifier, with: .success(frame))
    }

    private func receiveInteractionOrSettleInvalidFrame(_ frame: Data, generation: Int) {
        if let request = try? RailgunRPCInteractionRequest(data: frame) {
            receiveInteraction(request)
            return
        }
        guard let command = invalidInteractionSettlementCommand(from: frame) else { return }
        let epoch = interactionEpoch
        Task { [weak self] in
            await self?.settleInteractionSafely(command, generation: generation, epoch: epoch)
        }
    }

    private func receiveInteraction(_ request: RailgunRPCInteractionRequest) {
        guard let currentGeneration = activeGeneration else { return }
        let backendRequestID: String
        let kind: RailgunRPCInteractionKind
        let content: (String, [String]?)
        switch request {
        case let .approval(requestID, command):
            backendRequestID = requestID
            kind = .approval
            content = (boundedInteractionText(command, limit: RailgunRPCValidationLimits.interactionText), nil)
        case let .clarification(requestID, question, choices):
            backendRequestID = requestID
            kind = .clarification
            content = (
                boundedInteractionText(question, limit: RailgunRPCValidationLimits.interactionText),
                choices?.map { boundedInteractionText($0, limit: RailgunRPCValidationLimits.interactionChoice) }
            )
        }

        guard correlationIDsByBackendRequestID[backendRequestID] == nil else { return }
        let correlationID = nextInteractionID()
        let interaction: RailgunRPCInteraction = switch kind {
        case .approval:
            .approval(id: correlationID, command: content.0)
        case .clarification:
            .clarification(id: correlationID, question: content.0, choices: content.1)
        }
        pendingInteractions[interaction.id] = PendingInteraction(
            kind: interaction.kind,
            backendRequestID: backendRequestID
        )
        correlationIDsByBackendRequestID[backendRequestID] = interaction.id
        switch interactionContinuation.yield(interaction) {
        case .enqueued:
            break
        case .dropped, .terminated:
            guard let dropped = removePendingInteraction(id: interaction.id),
                  let command = interactionSettlementCommand(
                      kind: dropped.kind,
                      backendRequestID: dropped.backendRequestID
                  )
            else { return }
            let epoch = interactionEpoch
            Task { [weak self] in
                await self?.settleInteractionSafely(command, generation: currentGeneration, epoch: epoch)
            }
        @unknown default:
            break
        }
    }

    private func respondToInteraction(
        id: String,
        expectedKind: RailgunRPCInteractionKind,
        command: RailgunRPCCommand
    ) async throws {
        guard let pending = pendingInteractions[id] else {
            throw RailgunRPCError.unknownInteraction
        }
        guard pending.kind == expectedKind else {
            throw RailgunRPCError.mismatchedInteractionKind(expected: pending.kind, received: expectedKind)
        }
        guard submittingInteractionIDs.insert(id).inserted else {
            throw RailgunRPCError.interactionResponseInFlight
        }
        defer { submittingInteractionIDs.remove(id) }

        let response = try await request(command, timeout: configuration.interactionResponseDeadline)
        guard response.success, response.data == nil else {
            throw RailgunRPCError.invalidInteractionResponse
        }
        _ = removePendingInteraction(id: id)
    }

    private func backendRequestID(
        for id: String,
        expectedKind: RailgunRPCInteractionKind
    ) throws -> String {
        guard let pending = pendingInteractions[id] else {
            throw RailgunRPCError.unknownInteraction
        }
        guard pending.kind == expectedKind else {
            throw RailgunRPCError.mismatchedInteractionKind(expected: pending.kind, received: expectedKind)
        }
        return pending.backendRequestID
    }

    private func validateInteractionCorrelationID(_ id: String) throws {
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              id.count <= RailgunRPCValidationLimits.interactionCorrelationID
        else {
            throw RailgunRPCError.unknownInteraction
        }
    }

    private func invalidInteractionSettlementCommand(from frame: Data) -> RailgunRPCCommand? {
        guard let value = try? JSONDecoder().decode(RailgunJSONValue.self, from: frame),
              let object = value.objectValue,
              let type = object["type"]?.stringValue,
              type == "approval_request" || type == "clarification_request"
        else { return nil }

        let kind: RailgunRPCInteractionKind? = switch type {
        case "approval_request": .approval
        case "clarification_request": .clarification
        default: nil
        }
        if let requestID = object["requestId"]?.stringValue,
           let kind,
           let command = interactionSettlementCommand(kind: kind, backendRequestID: requestID) {
            return command
        }
        return try? RailgunRPCCommand(type: .abort)
    }

    private func interactionSettlementCommand(
        kind: RailgunRPCInteractionKind,
        backendRequestID: String
    ) -> RailgunRPCCommand? {
        switch kind {
        case .approval:
            try? RailgunRPCCommand(
                type: .approvalResponse,
                fields: ["requestId": .string(backendRequestID), "approved": .bool(false)]
            )
        case .clarification:
            try? RailgunRPCCommand(
                type: .clarificationResponse,
                fields: ["requestId": .string(backendRequestID), "answer": .string(Self.declinedClarificationAnswer)]
            )
        }
    }

    private func settleInteractionSafely(
        _ command: RailgunRPCCommand,
        generation: Int,
        epoch: Int
    ) async {
        guard activeGeneration == generation, interactionEpoch == epoch else { return }
        do {
            let response = try await request(command, timeout: configuration.interactionResponseDeadline)
            guard response.success, response.data == nil else {
                throw RailgunRPCError.invalidInteractionResponse
            }
        } catch {
            guard command.type != .abort, activeGeneration == generation, interactionEpoch == epoch else { return }
            _ = try? await request(
                RailgunRPCCommand(type: .abort),
                timeout: configuration.interactionResponseDeadline
            )
        }
    }

    @discardableResult
    private func removePendingInteraction(id: String) -> PendingInteraction? {
        guard let pending = pendingInteractions.removeValue(forKey: id) else { return nil }
        correlationIDsByBackendRequestID.removeValue(forKey: pending.backendRequestID)
        return pending
    }

    private func nextInteractionID() -> String {
        nextInteractionSequence += 1
        return "interaction-\(generation)-\(nextInteractionSequence)-\(UUID().uuidString.lowercased())"
    }

    private func boundedInteractionText(_ text: String, limit: Int) -> String {
        let redacted = RailgunRPCRedactor.redact(text: text)
        guard redacted.count > limit else { return redacted }
        return String(redacted.prefix(max(0, limit - 1))) + "…"
    }

    private func settleInteractions() {
        interactionEpoch += 1
        pendingInteractions.removeAll()
        correlationIDsByBackendRequestID.removeAll()
        submittingInteractionIDs.removeAll()
    }

    private func stdoutEnded(for currentGeneration: Int) async {
        await endUnexpectedly(
            currentGeneration,
            error: .backendTerminated,
            terminateBackend: true
        )
    }

    private func stdoutFailed(_ error: Error, for currentGeneration: Int) async {
        await endUnexpectedly(
            currentGeneration,
            error: .transportFailure(RailgunRPCRedactor.redact(text: String(describing: error))),
            terminateBackend: true
        )
    }

    private func backendDidTerminate(generation currentGeneration: Int) async {
        await endUnexpectedly(
            currentGeneration,
            error: .backendTerminated,
            terminateBackend: false
        )
    }

    private func endUnexpectedly(
        _ currentGeneration: Int,
        error: RailgunRPCError,
        terminateBackend: Bool
    ) async {
        guard activeGeneration == currentGeneration else { return }
        let wasReady: Bool
        if case .ready = lifecycle {
            wasReady = true
        } else {
            wasReady = false
        }

        await endGeneration(currentGeneration, error: error, terminateBackend: terminateBackend)
        if wasReady {
            unexpectedTerminationContinuation.yield(())
        }
    }

    private func timeoutRequest(_ identifier: String) {
        settle(identifier, with: .failure(.timeout))
    }

    /// Fails every startup request immediately, preserving the specific cause
    /// until ``start(_:)`` finishes generation cleanup.
    private func failStartup(with error: RailgunRPCError) {
        startupFailure = error
        let pendingRequestIDs = Array(pendingRequests.keys)
        pendingRequestIDs.forEach { settle($0, with: .failure(error)) }
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
        startupFailure = nil
        standardInput = nil
        settleInteractions()
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
        let decoded = try successfulResponse(from: response, for: "initialize")
        let initialize: RailgunRPCInitializeResult
        do {
            initialize = try RailgunRPCInitializeResult(data: decoded.data)
        } catch {
            throw RailgunRPCError.malformedResponse
        }
        guard initialize.version == configuration.protocolVersion else {
            throw RailgunRPCError.protocolVersionMismatch(
                expected: configuration.protocolVersion,
                received: initialize.version
            )
        }

        let missingCapabilities = configuration.requiredCapabilities.subtracting(initialize.capabilities)
        guard missingCapabilities.isEmpty else {
            throw RailgunRPCError.missingRequiredCapabilities(missingCapabilities)
        }
        return RailgunRPCHandshake(protocolVersion: initialize.version, capabilities: initialize.capabilities)
    }

    /// Recognizes only the private startup frame emitted for authentication
    /// failures. Nonconforming frames continue through normal event handling.
    private func authenticationRequiredSource(from frame: Data) -> RailgunRPCCredentialSource? {
        guard let value = try? JSONDecoder().decode(RailgunJSONValue.self, from: frame),
              let object = value.objectValue,
              object["type"]?.stringValue == "startup_status",
              object["status"]?.stringValue == "authentication_required",
              let rawSource = object["credential_source"]?.stringValue
        else {
            return nil
        }
        return RailgunRPCCredentialSource(rawValue: rawSource)
    }

    private func validateSuccessfulReadinessResponse(_ response: Data) throws {
        _ = try successfulResponse(from: response, for: "get_state")
    }

    private func successfulResponse(
        from response: Data,
        for command: String
    ) throws -> RailgunRPCResponse {
        let decoded: RailgunRPCResponse
        do {
            decoded = try RailgunRPCResponse(data: response)
        } catch {
            throw RailgunRPCError.malformedResponse
        }
        guard decoded.success else {
            throw RailgunRPCError.startupRejected(
                command: command,
                reason: decoded.error.map { RailgunRPCRedactor.redact(text: $0) }
            )
        }
        return decoded
    }

    private func normalized(_ error: Error) -> RailgunRPCError {
        if error is CancellationError {
            return .cancelled
        }
        return error as? RailgunRPCError ?? .backendTerminated
    }
}
