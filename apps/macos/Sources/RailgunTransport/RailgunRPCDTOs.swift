import Foundation

/// JSON values carried by versioned Railgun RPC messages.
///
/// Keeping the protocol's extensible fields as this value rather than
/// `[String: Any]` preserves `Sendable`, `Codable`, and equality guarantees at
/// the transport boundary.
public enum RailgunJSONValue: Sendable, Equatable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([RailgunJSONValue])
    case object([String: RailgunJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([RailgunJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: RailgunJSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    public var objectValue: [String: RailgunJSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    public var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    public var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    public var integerValue: Int? {
        guard case let .number(value) = self,
              value.isFinite,
              value.rounded() == value
        else { return nil }
        return Int(exactly: value)
    }
}

/// The commands supported by RPC protocol version 1.
public enum RailgunRPCCommandType: String, Sendable, CaseIterable, Codable {
    case initialize, prompt, steer, followUp = "follow_up", abort, getState = "get_state"
    case getMessages = "get_messages", setModel = "set_model", getAvailableModels = "get_available_models"
    case compact, setAutoCompaction = "set_auto_compaction", approvalResponse = "approval_response"
    case clarificationResponse = "clarification_response", sessionNew = "session_new", sessionList = "session_list"
    case sessionListArchived = "session_list_archived", sessionDeliveryCursor = "session_delivery_cursor"
    case sessionLoad = "session_load", sessionArchive = "session_archive"
    case sessionUnarchive = "session_unarchive", sessionSave = "session_save", sessionBranch = "session_branch"
    case sessionFork = "session_fork", sessionRecentMessages = "session_recent_messages"
    case sessionTranscript = "session_transcript", configGet = "config_get", configUpdate = "config_update"
    case mcpList = "mcp_list", mcpUpsert = "mcp_upsert", mcpRemove = "mcp_remove", cronList = "cron_list"
    case cronAdd = "cron_add", cronUpdate = "cron_update", cronRemove = "cron_remove", memoryList = "memory_list"
    case memorySearch = "memory_search", memoryCreate = "memory_create", memoryUpdate = "memory_update"
    case memoryDelete = "memory_delete", notesImport = "notes_import", notesSearch = "notes_search"
    case dreamRun = "dream_run", instructionFilesList = "instruction_files_list"
    case instructionFileGet = "instruction_file_get", instructionFileUpdate = "instruction_file_update"
    case skillsList = "skills_list", skillGet = "skill_get"
}

/// Contract limits shared with the desktop RPC boundary.
public enum RailgunRPCValidationLimits {
    public static let resultLimit = 100
    public static let backendInteractionRequestID = 256
    public static let interactionCorrelationID = 128
    public static let interactionText = 8_000
    public static let interactionChoice = 500
    public static let interactionChoices = 32
    public static let clarificationAnswer = 100_000
    public static let diagnosticText = 2_000
    public static let detailText = 8_000
}

/// A validated outbound RPC command. `id` is intentionally absent: the RPC
/// client owns correlation IDs and adds them immediately before writing JSONL.
public struct RailgunRPCCommand: Sendable, Equatable {
    public let type: RailgunRPCCommandType
    public let fields: [String: RailgunJSONValue]

    public init(type: RailgunRPCCommandType, fields: [String: RailgunJSONValue] = [:]) throws {
        guard fields["id"] == nil, fields["type"] == nil else {
            throw RailgunRPCDTOError.reservedField
        }
        self.type = type
        self.fields = fields
        try validate()
    }

    public func encodedData() throws -> Data {
        var object = fields
        object["type"] = .string(type.rawValue)
        return try JSONEncoder().encode(RailgunJSONValue.object(object))
    }

    private func validate() throws {
        func requiredString(_ name: String) throws {
            guard let value = fields[name]?.stringValue, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw RailgunRPCDTOError.invalidField(name, "must be a non-empty string")
            }
        }
        func boundedString(_ name: String, limit: Int) throws {
            try requiredString(name)
            guard let value = fields[name]?.stringValue, value.count <= limit else {
                throw RailgunRPCDTOError.invalidField(name, "exceeds the configured limit")
            }
        }
        func optionalString(_ name: String) throws {
            guard fields[name] == nil || fields[name]?.stringValue != nil else {
                throw RailgunRPCDTOError.invalidField(name, "must be a string")
            }
        }
        func optionalBool(_ name: String) throws {
            guard fields[name] == nil || fields[name]?.boolValue != nil else {
                throw RailgunRPCDTOError.invalidField(name, "must be a boolean")
            }
        }
        func requiredObject(_ name: String) throws {
            guard fields[name]?.objectValue != nil else {
                throw RailgunRPCDTOError.invalidField(name, "must be an object")
            }
        }
        func optionalStringArray(_ name: String) throws {
            guard let value = fields[name] else { return }
            guard case let .array(values) = value,
                  values.allSatisfy({ $0.stringValue != nil })
            else {
                throw RailgunRPCDTOError.invalidField(name, "must be an array of strings")
            }
        }
        func optionalStringOrNullObject(_ name: String) throws {
            guard let value = fields[name] else { return }
            guard let object = value.objectValue,
                  object.values.allSatisfy({ $0.stringValue != nil || $0 == .null })
            else {
                throw RailgunRPCDTOError.invalidField(name, "values must be strings or null")
            }
        }
        func positiveLimit(_ name: String) throws {
            guard fields[name] == nil else {
                guard let value = fields[name]?.integerValue, (1 ... RailgunRPCValidationLimits.resultLimit).contains(value) else {
                    throw RailgunRPCDTOError.invalidField(name, "must be an integer between 1 and 100")
                }
                return
            }
        }
        func nonNegativeCursor(_ name: String) throws {
            guard fields[name] == nil || (fields[name]?.integerValue ?? -1) >= 0 else {
                throw RailgunRPCDTOError.invalidField(name, "must be a non-negative integer")
            }
        }
        func positiveInteger(_ name: String) throws {
            guard fields[name] == nil || (fields[name]?.integerValue ?? 0) > 0 else {
                throw RailgunRPCDTOError.invalidField(name, "must be a positive integer")
            }
        }

        switch type {
        case .initialize:
            guard fields["version"]?.integerValue != nil else {
                throw RailgunRPCDTOError.invalidField("version", "must be an integer")
            }
            try optionalString("clientName")
        case .prompt, .steer, .followUp:
            try requiredString("message")
        case .setModel:
            try requiredString("modelId")
        case .setAutoCompaction:
            guard fields["enabled"]?.boolValue != nil else { throw RailgunRPCDTOError.invalidField("enabled", "must be a boolean") }
        case .approvalResponse:
            try boundedString("requestId", limit: RailgunRPCValidationLimits.backendInteractionRequestID)
            guard fields["approved"]?.boolValue != nil else { throw RailgunRPCDTOError.invalidField("approved", "must be a boolean") }
        case .clarificationResponse:
            try boundedString("requestId", limit: RailgunRPCValidationLimits.backendInteractionRequestID)
            try boundedString("answer", limit: RailgunRPCValidationLimits.clarificationAnswer)
        case .sessionNew:
            try optionalString("modelId")
        case .sessionLoad:
            try requiredString("sessionId")
            try optionalBool("includeMessages")
        case .sessionArchive, .sessionUnarchive:
            try requiredString("sessionId")
        case .sessionBranch:
            try positiveInteger("messageId")
            try optionalBool("summarize")
            try optionalBool("includeMessages")
        case .sessionFork:
            try optionalString("sessionId")
            try optionalBool("includeMessages")
        case .sessionRecentMessages:
            try optionalString("sessionId")
            try positiveLimit("limit")
        case .sessionTranscript:
            try requiredString("sessionId")
            try nonNegativeCursor("cursor")
            try positiveLimit("limit")
        case .configUpdate:
            try requiredObject("patch")
        case .mcpUpsert:
            try requiredString("name")
            try requiredString("command")
            try optionalStringArray("args")
            try optionalStringOrNullObject("env")
        case .mcpRemove, .skillGet:
            try requiredString("name")
        case .cronList:
            try nonNegativeCursor("cursor")
            try positiveLimit("limit")
            try optionalBool("editableOnly")
            try positiveInteger("maxPromptLength")
        case .cronAdd:
            try requiredString("schedule")
            try requiredString("prompt")
            try optionalString("jobId")
            try optionalBool("includeJob")
        case .cronUpdate:
            try requiredString("jobId")
            try requiredObject("patch")
            try optionalBool("includeJob")
        case .cronRemove:
            try requiredString("jobId")
        case .memoryList:
            try positiveLimit("limit")
        case .memorySearch:
            try requiredString("query")
            try positiveLimit("limit")
        case .memoryCreate:
            try requiredString("content")
            try requiredString("category")
        case .memoryUpdate:
            try requiredString("memoryId")
            try requiredObject("patch")
        case .memoryDelete:
            try requiredString("memoryId")
        case .notesImport:
            try requiredString("folderPath")
            try optionalBool("semantic")
        case .notesSearch:
            try requiredString("query")
            if let mode = fields["mode"]?.stringValue, mode != "keyword", mode != "semantic" {
                throw RailgunRPCDTOError.invalidField("mode", "must be keyword or semantic")
            } else if fields["mode"] != nil, fields["mode"]?.stringValue == nil {
                throw RailgunRPCDTOError.invalidField("mode", "must be keyword or semantic")
            }
            try positiveLimit("limit")
        case .instructionFileGet:
            try requiredString("fileId")
        case .instructionFileUpdate:
            try requiredString("fileId")
            guard fields["content"]?.stringValue != nil else { throw RailgunRPCDTOError.invalidField("content", "must be a string") }
        case .abort, .getState, .getMessages, .getAvailableModels, .compact, .sessionList, .sessionListArchived,
             .sessionDeliveryCursor, .sessionSave, .configGet, .mcpList, .dreamRun, .instructionFilesList, .skillsList:
            break
        }
    }
}

public enum RailgunRPCDTOError: Error, Sendable, Equatable {
    case reservedField
    case invalidField(String, String)
    case malformedResponse
    case malformedInteraction
}

/// The user-facing category of a pending backend interaction.
public enum RailgunRPCInteractionKind: String, Sendable, Equatable {
    case approval
    case clarification
}

/// A presentation-safe interaction request.
///
/// `id` is an opaque client-side correlation identifier. It deliberately does
/// not contain the backend request identifier, which remains transport-owned.
public enum RailgunRPCInteraction: Sendable, Equatable {
    case approval(id: String, command: String)
    case clarification(id: String, question: String, choices: [String]?)

    public var id: String {
        switch self {
        case let .approval(id, _), let .clarification(id, _, _):
            id
        }
    }

    public var kind: RailgunRPCInteractionKind {
        switch self {
        case .approval:
            .approval
        case .clarification:
            .clarification
        }
    }
}

/// A decoded RPC response envelope. The `data` member remains extensible while
/// command-specific DTOs decode only the fields they consume.
public struct RailgunRPCResponse: Sendable, Equatable {
    public let id: String?
    public let command: String
    public let success: Bool
    public let data: RailgunJSONValue?
    public let error: String?

    public init(data: Data) throws {
        let value = try JSONDecoder().decode(RailgunJSONValue.self, from: data)
        guard let object = value.objectValue,
              object["type"]?.stringValue == "response",
              let command = object["command"]?.stringValue,
              !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let success = object["success"]?.boolValue,
              object["id"] == nil || object["id"]?.stringValue != nil
        else { throw RailgunRPCDTOError.malformedResponse }
        if !success, object["error"]?.stringValue == nil { throw RailgunRPCDTOError.malformedResponse }
        id = object["id"]?.stringValue
        self.command = command
        self.success = success
        self.data = object["data"]
        error = object["error"]?.stringValue
    }
}

public struct RailgunRPCInitializeResult: Sendable, Equatable {
    public let version: Int
    public let capabilities: Set<String>

    public init(data: RailgunJSONValue?) throws {
        guard let object = data?.objectValue,
              let version = object["version"]?.integerValue,
              let values = object["capabilities"], case let .array(capabilities) = values,
              capabilities.allSatisfy({ $0.stringValue != nil })
        else { throw RailgunRPCDTOError.malformedResponse }
        self.version = version
        self.capabilities = Set(capabilities.compactMap(\.stringValue))
    }
}

public struct RailgunRPCSessionState: Sendable, Equatable {
    public let running: Bool
    public let model: String
    public let messageCount: Int
    public let sessionID: String?
    public let persistence: String?

    public init(data: RailgunJSONValue?) throws {
        guard let object = data?.objectValue,
              let running = object["running"]?.boolValue,
              let model = object["model"]?.stringValue,
              let messageCount = object["messageCount"]?.integerValue,
              messageCount >= 0,
              object["sessionId"] == nil || object["sessionId"]?.stringValue != nil,
              object["persistence"] == nil || object["persistence"]?.stringValue != nil
        else { throw RailgunRPCDTOError.malformedResponse }
        self.running = running
        self.model = model
        self.messageCount = messageCount
        sessionID = object["sessionId"]?.stringValue
        persistence = object["persistence"]?.stringValue
    }
}

public enum RailgunRPCInteractionRequest: Sendable, Equatable {
    case approval(requestID: String, command: String)
    case clarification(requestID: String, question: String, choices: [String]?)

    public init(data: Data) throws {
        let value = try JSONDecoder().decode(RailgunJSONValue.self, from: data)
        guard let object = value.objectValue,
              let type = object["type"]?.stringValue,
              let requestID = object["requestId"]?.stringValue,
              requestID.count <= RailgunRPCValidationLimits.backendInteractionRequestID,
              !requestID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw RailgunRPCDTOError.malformedInteraction }
        switch type {
        case "approval_request":
            guard let command = Self.validInteractionText(object["command"], limit: RailgunRPCValidationLimits.interactionText) else {
                throw RailgunRPCDTOError.malformedInteraction
            }
            self = .approval(requestID: requestID, command: command)
        case "clarification_request":
            guard let question = Self.validInteractionText(object["question"], limit: RailgunRPCValidationLimits.interactionText) else {
                throw RailgunRPCDTOError.malformedInteraction
            }
            let choices: [String]?
            if let rawChoices = object["choices"] {
                guard case let .array(values) = rawChoices,
                      !values.isEmpty,
                      values.count <= RailgunRPCValidationLimits.interactionChoices
                else { throw RailgunRPCDTOError.malformedInteraction }
                choices = try values.map { value in
                    guard let choice = Self.validInteractionText(value, limit: RailgunRPCValidationLimits.interactionChoice) else {
                        throw RailgunRPCDTOError.malformedInteraction
                    }
                    return choice
                }
            } else {
                choices = nil
            }
            self = .clarification(requestID: requestID, question: question, choices: choices)
        default:
            throw RailgunRPCDTOError.malformedInteraction
        }
    }

    public static func validateClarificationAnswer(_ answer: String) throws -> String {
        let trimmed = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= RailgunRPCValidationLimits.clarificationAnswer else {
            throw RailgunRPCDTOError.invalidField("answer", "must be a non-empty string within the configured limit")
        }
        return trimmed
    }

    private static func validInteractionText(_ value: RailgunJSONValue?, limit: Int) -> String? {
        guard let value = value?.stringValue,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= limit
        else { return nil }
        return value
    }
}

/// Removes values that are unsafe for presentation or diagnostics.
public enum RailgunRPCRedactor {
    private static let secretKeyPattern = "(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|token|api[_-]?key)"
    private static let tokenPattern = "\\b(?:Bearer\\s+)?(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9._-]{8,}|\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}"

    public static func redact(text: String) -> String {
        text
            .replacingOccurrences(of: "\\b(Bearer\\s+)[^\\s,;]+", with: "$1[REDACTED]", options: .regularExpression)
            .replacingOccurrences(of: "\\b((?:DEVIN_TOKEN|[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)[A-Z0-9_]*)\\s*=\\s*)[^\\s,;]+", with: "$1[REDACTED]", options: .regularExpression)
            .replacingOccurrences(of: "([\\\"']?" + secretKeyPattern + "[\\\"']?\\s*[:=]\\s*[\\\"']?)[^\\\"'\\s,;}]+", with: "$1[REDACTED]", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: tokenPattern, with: "[REDACTED]", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "file://[^\\s,;]+|(?:/Users|/home|/private|/var|/tmp)(?:/[^\\s,;]*)?", with: "[REDACTED_PATH]", options: .regularExpression)
    }

    public static func redact(_ value: RailgunJSONValue, parentKey: String? = nil) -> RailgunJSONValue {
        redactObject(value, parentKey: parentKey)
    }

    public static func detail(_ value: RailgunJSONValue, limit: Int = RailgunRPCValidationLimits.detailText) -> String {
        let redacted = redactObject(value)
        let data = (try? JSONEncoder().encode(redacted)) ?? Data("[Unserializable detail]".utf8)
        let text = String(decoding: data, as: UTF8.self)
        return bounded(text, limit: limit)
    }

    /// A deliberately tiny summary of an untrusted frame. It never includes
    /// request/response data, messages, tool details, environment values, or
    /// arbitrary fields.
    public static func diagnosticSummary(for value: RailgunJSONValue) -> String {
        guard let object = value.objectValue else { return "non-object JSONL frame" }
        var fields: [String] = []
        if let type = object["type"]?.stringValue { fields.append("type=\(diagnosticComponent(type))") }
        else { fields.append("type=unknown") }
        if object["type"]?.stringValue == "response", let command = object["command"]?.stringValue {
            fields.append("command=\(diagnosticComponent(command))")
        }
        if object["id"]?.stringValue != nil { fields.append("id=present") }
        if let status = object["status"]?.stringValue { fields.append("status=\(diagnosticComponent(status))") }
        if let success = object["success"]?.boolValue { fields.append("success=\(success)") }
        return bounded(fields.joined(separator: " "), limit: RailgunRPCValidationLimits.diagnosticText)
    }

    private static func redactObject(_ value: RailgunJSONValue, parentKey: String? = nil) -> RailgunJSONValue {
        switch value {
        case let .array(items):
            return .array(items.map { redactObject($0, parentKey: parentKey) })
        case let .object(items):
            return .object(Dictionary(uniqueKeysWithValues: items.map { key, item in
                let isSecret = key.range(of: secretKeyPattern, options: [.regularExpression, .caseInsensitive]) != nil
                return (key, isSecret || parentKey == "env" ? .string("[REDACTED]") : redactObject(item, parentKey: key))
            }))
        case let .string(text):
            return .string(redact(text: text))
        default:
            return value
        }
    }

    private static func diagnosticComponent(_ value: String) -> String {
        bounded(redact(text: value).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression), limit: 128)
    }

    private static func bounded(_ value: String, limit: Int) -> String {
        guard value.count > limit else { return value }
        return String(value.prefix(max(0, limit - 1))) + "…"
    }
}
