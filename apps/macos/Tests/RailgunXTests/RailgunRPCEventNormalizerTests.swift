import Foundation
import XCTest
import RailgunTransport

final class RailgunRPCEventNormalizerTests: XCTestCase {
    func testNormalizesMessageToolTodoAndQueueEvents() {
        XCTAssertEqual(
            normalize(#"{"type":"agent_start"}"#),
            .runStarted
        )
        XCTAssertEqual(
            normalize(#"{"type":"message_update","streamEvent":{"type":"text_delta","delta":"hello"}}"#),
            .assistantDelta("hello")
        )
        XCTAssertEqual(
            normalize(#"{"type":"message_end","message":{"role":"assistant"}}"#),
            .assistantCompleted
        )
        XCTAssertEqual(
            normalize(#"{"type":"queue_update","steering":["first"],"followUp":["second"]}"#),
            .queueUpdated(steering: ["first"], followUp: ["second"])
        )

        XCTAssertEqual(
            normalize(#"{"type":"tool_execution_start","toolCallId":"tool-1","toolName":"read_file","args":{"path":"/private/file.txt"}}"#),
            .toolStarted(id: "tool-1", name: "read_file", input: #"{"path":"[REDACTED_PATH]"}"#)
        )
        XCTAssertEqual(
            normalize(#"{"type":"tool_execution_end","toolCallId":"todo-1","toolName":"todo","result":{"isError":false,"content":"{\"todos\":[{\"id\":\"a\",\"content\":\"First\",\"status\":\"in_progress\"},{\"id\":\"b\",\"content\":\"Second\"}]}"}}"#),
            .toolEnded(
                id: "todo-1",
                name: "todo",
                failed: false,
                output: nil,
                todos: [
                    RailgunTodo(id: "a", content: "First", status: .inProgress),
                    RailgunTodo(id: "b", content: "Second", status: .pending),
                ]
            )
        )
    }

    func testNormalizesUsageAdvisorMoAAndSubagentEvents() {
        XCTAssertEqual(
            normalize(#"{"type":"turn_end","usage":{"inputTokens":120,"outputTokens":30}}"#),
            .contextUsage(inputTokens: 120, outputTokens: 30)
        )
        XCTAssertEqual(
            normalize(#"{"type":"compaction_start","reason":"threshold"}"#),
            .contextReset(reason: .compaction)
        )
        XCTAssertEqual(
            normalize(#"{"type":"message_start","message":{"role":"user","content":" <advisory severity='blocker'>Fix &amp; verify</advisory> "}}"#),
            .advisorNote(severity: .blocker, text: "Fix & verify")
        )
        XCTAssertEqual(
            normalize(#"{"type":"moa_reference_start","index":0,"count":2,"model":"ref"}"#),
            .moaReferenceStarted(index: 0, count: 2, model: "ref")
        )
        XCTAssertEqual(
            normalize(#"{"type":"moa_reference_end","index":0,"model":"ref","text":"private advice"}"#),
            .moaReferenceEnded(index: 0, model: "ref", preview: "private advice")
        )
        XCTAssertEqual(
            normalize(#"{"type":"moa_aggregating","aggregator":"agg","refCount":2}"#),
            .moaAggregating(model: "agg", referenceCount: 2)
        )
        XCTAssertEqual(
            normalize(#"{"type":"subagent_start","goal":"Inspect","index":0,"count":1}"#),
            .subagentStarted(goal: "Inspect", index: 0, count: 1)
        )
        XCTAssertEqual(
            normalize(#"{"type":"subagent_end","goal":"Inspect","index":0,"result":"Done"}"#),
            .subagentEnded(goal: "Inspect", index: 0, result: "Done")
        )
    }

    func testWithholdsMalformedEventsAndRedactsBoundedDetails() {
        XCTAssertNil(normalize(#"{"type":"turn_end","usage":{"inputTokens":-1,"outputTokens":2}}"#))
        XCTAssertNil(normalize(#"{"type":"turn_end","usage":{"inputTokens":9007199254740992,"outputTokens":2}}"#))
        XCTAssertNil(normalize(#"{"type":"queue_update","steering":[7],"followUp":[]}"#))
        XCTAssertNil(normalize(#"{"type":"message_start","message":{"role":"user","content":"<advisory severity=\"unknown\">raw</advisory>"}}"#))
        XCTAssertNil(normalize(#"{"type":"tool_execution_end","toolCallId":"x","toolName":"read_file","result":{"isError":false,"content":7}}"#))

        XCTAssertEqual(
            normalize(#"{"type":"tool_execution_end","toolCallId":"todo-1","toolName":"todo","result":{"isError":false,"content":"{\"todos\":[{\"id\":7}]}"}}"#),
            .toolEnded(id: "todo-1", name: "todo", failed: false, output: nil, todos: nil)
        )

        let event = normalize(#"{"type":"tool_execution_start","toolCallId":"tool-1","toolName":"run_shell","args":{"password":"hunter2","apiToken":"abc","command":"Authorization: Bearer secret-value"}}"#)
        guard case let .toolStarted(_, _, input?) = event else {
            return XCTFail("Expected a tool-start event")
        }
        XCTAssertTrue(input.contains("[REDACTED]"))
        XCTAssertFalse(input.contains("hunter2"))
        XCTAssertFalse(input.contains("secret-value"))
    }

    private func normalize(_ json: String) -> RailgunAgentEvent? {
        RailgunRPCEventNormalizer.normalize(Data(json.utf8))
    }
}
