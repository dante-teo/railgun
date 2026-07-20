import Foundation

/// A presentation-safe event emitted by the Railgun RPC backend.
///
/// This deliberately contains only the stable desktop vocabulary. Backend
/// event fields not represented here are ignored so protocol additions cannot
/// accidentally reach feature state or diagnostics.
public enum RailgunAgentEvent: Sendable, Equatable {
    case runStarted
    case runEnded
    /// A session checkpoint completed and its summary can be reloaded safely.
    case sessionSaved
    case contextUsage(inputTokens: Int, outputTokens: Int)
    case contextReset(reason: RailgunContextResetReason)
    case assistantDelta(String)
    case assistantCompleted
    case queueUpdated(steering: [String], followUp: [String])
    case toolStarted(id: String, name: String, input: String?)
    case toolEnded(id: String, name: String, failed: Bool, output: String?, todos: [RailgunTodo]?)
    case moaReferenceStarted(index: Int, count: Int, model: String)
    case moaReferenceEnded(index: Int, model: String, preview: String)
    case moaAggregating(model: String, referenceCount: Int)
    case advisorNote(severity: RailgunAdvisorSeverity, text: String)
    case subagentStarted(goal: String, index: Int, count: Int)
    case subagentEnded(goal: String, index: Int, result: String)
}

public enum RailgunContextResetReason: String, Sendable, Equatable {
    case compaction
    case model
    case backend
    case newChat = "new-chat"
}

public enum RailgunAdvisorSeverity: String, Sendable, Equatable {
    case nit
    case concern
    case blocker
}

public enum RailgunTodoStatus: String, Sendable, Equatable {
    case pending
    case inProgress = "in_progress"
    case completed
    case cancelled
}

public struct RailgunTodo: Sendable, Equatable {
    public let id: String
    public let content: String
    public let status: RailgunTodoStatus

    public init(id: String, content: String, status: RailgunTodoStatus) {
        self.id = id
        self.content = content
        self.status = status
    }
}

/// Validates and reduces untrusted backend JSON into ``RailgunAgentEvent``.
/// Malformed, unrelated, or unsafe input is silently withheld.
public enum RailgunRPCEventNormalizer {
    public static let idLimit = 256
    public static let toolNameLimit = 128
    public static let detailLimit = 8_000
    public static let contentLimit = 2_000
    public static let modelLimit = 256
    public static let previewLimit = 500
    public static let todoLimit = 256
    private static let maximumSafeInteger = 9_007_199_254_740_991

    public static func normalize(_ frame: Data) -> RailgunAgentEvent? {
        guard let value = try? JSONDecoder().decode(RailgunJSONValue.self, from: frame) else {
            return nil
        }
        return normalize(value)
    }

    public static func normalize(_ value: RailgunJSONValue) -> RailgunAgentEvent? {
        guard let event = value.objectValue,
              let type = event["type"]?.stringValue
        else {
            return nil
        }

        switch type {
        case "agent_start":
            return .runStarted
        case "agent_end":
            return .runEnded
        case "session_saved":
            return .sessionSaved
        case "turn_end":
            return contextUsage(from: event)
        case "compaction_start", "compaction_end":
            guard let reason = event["reason"]?.stringValue,
                  reason == "threshold" || reason == "overflow"
            else {
                return nil
            }
            return .contextReset(reason: .compaction)
        case "message_update":
            return assistantDelta(from: event)
        case "message_end":
            return assistantCompleted(from: event)
        case "message_start":
            return advisorNote(from: event)
        case "queue_update":
            return queueUpdate(from: event)
        case "tool_execution_start":
            return toolStart(from: event)
        case "tool_execution_end":
            return toolEnd(from: event)
        case "moa_reference_start":
            return moaReferenceStart(from: event)
        case "moa_reference_end":
            return moaReferenceEnd(from: event)
        case "moa_aggregating":
            return moaAggregating(from: event)
        case "subagent_start":
            return subagentStart(from: event)
        case "subagent_end":
            return subagentEnd(from: event)
        default:
            return nil
        }
    }

    private static func contextUsage(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let usage = event["usage"]?.objectValue,
              let inputTokens = nonNegativeInteger(usage["inputTokens"]),
              let outputTokens = nonNegativeInteger(usage["outputTokens"]),
              inputTokens <= maximumSafeInteger,
              outputTokens <= maximumSafeInteger
        else {
            return nil
        }
        return .contextUsage(inputTokens: inputTokens, outputTokens: outputTokens)
    }

    private static func assistantDelta(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let streamEvent = event["streamEvent"]?.objectValue,
              streamEvent["type"]?.stringValue == "text_delta",
              let delta = streamEvent["delta"]?.stringValue
        else {
            return nil
        }
        return .assistantDelta(delta)
    }

    private static func assistantCompleted(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard event["message"]?.objectValue?["role"]?.stringValue == "assistant" else {
            return nil
        }
        return .assistantCompleted
    }

    private static func advisorNote(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let message = event["message"]?.objectValue,
              message["role"]?.stringValue == "user",
              let advisory = parseAdvisory(message["content"]?.stringValue)
        else {
            return nil
        }
        let text = bounded(RailgunRPCRedactor.redact(text: advisory.text), limit: contentLimit)
        guard !text.isEmpty else { return nil }
        return .advisorNote(severity: advisory.severity, text: text)
    }

    private static func queueUpdate(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let steering = strings(event["steering"]),
              let followUp = strings(event["followUp"])
        else {
            return nil
        }
        return .queueUpdated(steering: steering, followUp: followUp)
    }

    private static func toolStart(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let id = requiredText(event["toolCallId"], limit: idLimit),
              let name = requiredText(event["toolName"], limit: toolNameLimit)
        else {
            return nil
        }
        return .toolStarted(
            id: id,
            name: name,
            input: event["args"].map(formatDetail)
        )
    }

    private static func toolEnd(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let id = requiredText(event["toolCallId"], limit: idLimit),
              let name = requiredText(event["toolName"], limit: toolNameLimit),
              let result = event["result"]?.objectValue,
              let failed = result["isError"]?.boolValue,
              let content = result["content"]?.stringValue
        else {
            return nil
        }

        if name == "todo", !failed, let todos = normalizeTodos(content) {
            return .toolEnded(id: id, name: name, failed: false, output: nil, todos: todos)
        }
        return .toolEnded(
            id: id,
            name: name,
            failed: failed,
            output: name == "todo" && !failed ? nil : formatDetail(.string(content)),
            todos: nil
        )
    }

    private static func moaReferenceStart(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let index = nonNegativeInteger(event["index"]),
              let count = positiveInteger(event["count"]),
              let model = requiredText(event["model"], limit: modelLimit)
        else {
            return nil
        }
        return .moaReferenceStarted(index: index, count: count, model: model)
    }

    private static func moaReferenceEnd(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let index = nonNegativeInteger(event["index"]),
              let model = requiredText(event["model"], limit: modelLimit),
              let text = event["text"]?.stringValue
        else {
            return nil
        }
        return .moaReferenceEnded(
            index: index,
            model: model,
            preview: bounded(RailgunRPCRedactor.redact(text: text), limit: previewLimit)
        )
    }

    private static func moaAggregating(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let model = requiredText(event["aggregator"], limit: modelLimit),
              let refCount = nonNegativeInteger(event["refCount"])
        else {
            return nil
        }
        return .moaAggregating(model: model, referenceCount: refCount)
    }

    private static func subagentStart(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let goal = requiredText(event["goal"], limit: contentLimit, redacted: true),
              let index = nonNegativeInteger(event["index"]),
              let count = positiveInteger(event["count"])
        else {
            return nil
        }
        return .subagentStarted(goal: goal, index: index, count: count)
    }

    private static func subagentEnd(from event: [String: RailgunJSONValue]) -> RailgunAgentEvent? {
        guard let goal = requiredText(event["goal"], limit: contentLimit, redacted: true),
              let index = nonNegativeInteger(event["index"]),
              let result = event["result"]?.stringValue
        else {
            return nil
        }
        return .subagentEnded(
            goal: goal,
            index: index,
            result: bounded(RailgunRPCRedactor.redact(text: result), limit: contentLimit)
        )
    }

    /// `nil` means malformed todo content. Callers intentionally retain the
    /// containing tool event but withhold the todo snapshot in that case.
    private static func normalizeTodos(_ content: String) -> [RailgunTodo]? {
        guard let value = try? JSONDecoder().decode(RailgunJSONValue.self, from: Data(content.utf8)),
              let object = value.objectValue,
              let values = object["todos"], case let .array(items) = values,
              items.count <= todoLimit
        else {
            return nil
        }

        var todos: [RailgunTodo] = []
        for item in items {
            guard let item = item.objectValue,
                  let id = requiredText(item["id"], limit: idLimit),
                  let content = requiredText(item["content"], limit: contentLimit, redacted: true)
            else {
                return nil
            }
            let status: RailgunTodoStatus
            if let rawStatus = item["status"]?.stringValue {
                guard let parsedStatus = RailgunTodoStatus(rawValue: rawStatus) else { return nil }
                status = parsedStatus
            } else if item["status"] == nil {
                status = .pending
            } else {
                return nil
            }
            todos.append(RailgunTodo(id: id, content: content, status: status))
        }
        return todos
    }

    private static func formatDetail(_ value: RailgunJSONValue) -> String {
        if case let .string(text) = value {
            if let nestedJSON = try? JSONDecoder().decode(RailgunJSONValue.self, from: Data(text.utf8)) {
                return RailgunRPCRedactor.detail(nestedJSON, limit: detailLimit)
            }
            return bounded(RailgunRPCRedactor.redact(text: text), limit: detailLimit)
        }
        return RailgunRPCRedactor.detail(value, limit: detailLimit)
    }

    private static func strings(_ value: RailgunJSONValue?) -> [String]? {
        guard let value, case let .array(values) = value else { return nil }
        var strings: [String] = []
        for value in values {
            guard let string = value.stringValue else { return nil }
            strings.append(string)
        }
        return strings
    }

    private static func requiredText(
        _ value: RailgunJSONValue?,
        limit: Int,
        redacted: Bool = false
    ) -> String? {
        guard let rawText = value?.stringValue else { return nil }
        let text = redacted ? RailgunRPCRedactor.redact(text: rawText) : rawText
        let bounded = bounded(text, limit: limit)
        return bounded.isEmpty ? nil : bounded
    }

    private static func nonNegativeInteger(_ value: RailgunJSONValue?) -> Int? {
        guard let integer = value?.integerValue, integer >= 0 else { return nil }
        return integer
    }

    private static func positiveInteger(_ value: RailgunJSONValue?) -> Int? {
        guard let integer = value?.integerValue, integer > 0 else { return nil }
        return integer
    }

    private static func parseAdvisory(_ text: String?) -> (severity: RailgunAdvisorSeverity, text: String)? {
        guard let text else { return nil }
        let pattern = "^\\s*<advisory\\b[^>]*\\bseverity=[\\\"'](nit|concern|blocker)[\\\"'][^>]*>(.*?)</advisory>\\s*$"
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = expression.firstMatch(in: text, range: range),
              let severityRange = Range(match.range(at: 1), in: text),
              let bodyRange = Range(match.range(at: 2), in: text),
              let severity = RailgunAdvisorSeverity(rawValue: String(text[severityRange]).lowercased())
        else {
            return nil
        }
        return (severity, decodeXMLText(String(text[bodyRange])).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func decodeXMLText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func bounded(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(max(0, limit - 1))) + "…"
    }
}
