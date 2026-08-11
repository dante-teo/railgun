use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub const PAGE_LIMIT: usize = 100;
const DATA_BUDGET: usize = 48 * 1024;
const TEXT_BUDGET: usize = 24 * 1024;
const TOOL_DETAIL_BUDGET: usize = 256;
const SHELL_COMMAND_BUDGET: usize = 4 * 1024;
const SHELL_OUTPUT_BUDGET: usize = 12 * 1024;
const FILE_DIFF_BUDGET: usize = 16 * 1024;

struct TranscriptToolResult {
    output: Option<String>,
    file_change: Option<Value>,
    failed: bool,
}

pub fn page(
    session_id: &str,
    history: &[Value],
    cursor: usize,
    limit: usize,
    message_ids: Option<&[i64]>,
    hide_initial_user: bool,
) -> Value {
    let entries = entries(history, message_ids, hide_initial_user);
    let mut messages = Vec::new();
    let mut next = cursor;
    while next < entries.len() && messages.len() < limit {
        let candidate = entries[next].clone();
        let proposed = json!({
            "sessionId": session_id,
            "messages": messages.iter().cloned().chain([candidate.clone()]).collect::<Vec<_>>(),
            "nextCursor": next + 1,
        });
        if serde_json::to_vec(&proposed).map_or(usize::MAX, |value| value.len()) > DATA_BUDGET
            && !messages.is_empty()
        {
            break;
        }
        messages.push(candidate);
        next += 1;
    }
    let mut result = json!({"sessionId": session_id, "messages": messages});
    if next < entries.len() {
        result["nextCursor"] = json!(next);
    }
    result
}

fn entries(history: &[Value], message_ids: Option<&[i64]>, hide_initial_user: bool) -> Vec<Value> {
    let tool_results = transcript_tool_results(history);
    let hidden = hide_initial_user.then(|| {
        history
            .iter()
            .position(|value| value["role"] == "user")
            .unwrap_or(usize::MAX)
    });
    let mut result = Vec::new();
    for (history_index, source) in history.iter().enumerate() {
        if hidden != Some(history_index) {
            if let Some(mut message) = transcript_message(source) {
                let object = message.as_object_mut().expect("transcript message object");
                object.insert(
                    "text".into(),
                    Value::String(truncate_utf8(
                        object["text"].as_str().unwrap_or_default(),
                        TEXT_BUDGET,
                    )),
                );
                if let Some(message_id) = message_ids.and_then(|values| values.get(history_index)) {
                    object.insert("messageId".into(), json!(message_id));
                    if object.remove("_branchable").is_some() {
                        object.insert("branchable".into(), Value::Bool(true));
                    }
                } else {
                    object.remove("_branchable");
                }
                result.push(message);
            }
        }
        result.extend(transcript_tools(source, history_index, &tool_results));
    }
    result
}

fn transcript_message(message: &Value) -> Option<Value> {
    let item = message.as_object()?;
    let role = item.get("role")?.as_str()?;
    if !matches!(role, "user" | "assistant") {
        return None;
    }
    let text = transcript_text(item).trim().to_owned();
    if text.is_empty() {
        return None;
    }
    let has_tool_calls = role == "assistant"
        && item
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(|part| part["type"] == "toolCall"));
    let mut result = json!({"role": role, "text": text});
    if role == "assistant" && !has_tool_calls {
        result["_branchable"] = Value::Bool(true);
    }
    if let Some(at) = item.get("at").and_then(Value::as_u64) {
        result[if role == "user" {
            "startedAt"
        } else {
            "completedAt"
        }] = json!(at);
    }
    Some(result)
}

fn transcript_text(item: &Map<String, Value>) -> String {
    text_content(item.get("content"))
}

fn text_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect(),
        _ => String::new(),
    }
}

fn transcript_tool_results(history: &[Value]) -> HashMap<String, TranscriptToolResult> {
    let tool_names = history
        .iter()
        .filter(|message| message["role"] == "assistant")
        .filter_map(|message| message.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part["type"] == "toolCall")
        .filter_map(|part| Some((part.get("id")?.as_str()?, part.get("name")?.as_str()?)))
        .collect::<HashMap<_, _>>();
    history
        .iter()
        .filter(|message| message["role"] == "tool")
        .filter_map(|message| {
            let id = message.get("toolCallId")?.as_str()?;
            let failed = message.get("isError").and_then(Value::as_bool) == Some(true);
            let name = tool_names.get(id).copied();
            Some((
                id.to_owned(),
                TranscriptToolResult {
                    output: (name == Some("run_shell_command"))
                        .then(|| tool_result_text(message.get("content")))
                        .flatten(),
                    file_change: (!failed && matches!(name, Some("create_file" | "write_file")))
                        .then(|| tool_result_file_change(message.get("content")))
                        .flatten(),
                    failed,
                },
            ))
        })
        .collect()
}

fn transcript_tools(
    message: &Value,
    history_index: usize,
    tool_results: &HashMap<String, TranscriptToolResult>,
) -> Vec<Value> {
    if message["role"] != "assistant" {
        return Vec::new();
    }
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(part_index, call)| {
            if call["type"] != "toolCall" {
                return None;
            }
            let id = call.get("id")?.as_str()?;
            let name = call.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let mut result = json!({
                "role": "tool",
                "id": format!("restored-tool-{history_index}-{part_index}"),
                "name": truncate_utf8(name, 128),
                "failed": tool_results.get(id).is_some_and(|result| result.failed),
            });
            if is_file_tool(name) {
                if let Some(path) = call
                    .get("arguments")
                    .and_then(Value::as_object)
                    .and_then(|arguments| arguments.get("path"))
                    .and_then(Value::as_str)
                    .and_then(safe_basename)
                {
                    result["target"] = Value::String(truncate_utf8(&path, 256));
                }
            }
            if let Some(detail) = tool_detail(name, call.get("arguments")) {
                result["detail"] = Value::String(detail);
            }
            if name == "run_shell_command" {
                if let Some(command) = call
                    .get("arguments")
                    .and_then(Value::as_object)
                    .and_then(|arguments| arguments.get("command"))
                    .and_then(Value::as_str)
                    .and_then(|command| safe_terminal_text(command, SHELL_COMMAND_BUDGET))
                {
                    result["command"] = Value::String(command);
                }
                if let Some(output) = tool_results
                    .get(id)
                    .and_then(|tool_result| tool_result.output.as_deref())
                    .and_then(|output| safe_terminal_text(output, SHELL_OUTPUT_BUDGET))
                {
                    result["output"] = Value::String(output);
                }
            }
            if let Some(file_change) = tool_results
                .get(id)
                .and_then(|tool_result| tool_result.file_change.as_ref())
            {
                result["fileChange"] = file_change.clone();
            }
            Some(result)
        })
        .collect()
}

fn tool_result_text(content: Option<&Value>) -> Option<String> {
    let text = text_content(content);
    (!text.is_empty()).then_some(text)
}

fn tool_result_file_change(content: Option<&Value>) -> Option<Value> {
    let mut parts = content?
        .as_array()?
        .iter()
        .filter(|part| part["type"] == "fileChange");
    let part = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    match part.get("status")?.as_str()? {
        "changed" => {
            let diff = part.get("diff")?.as_str()?;
            let truncated = part.get("truncated")?.as_bool()?;
            (diff.len() <= FILE_DIFF_BUDGET)
                .then(|| json!({"status":"changed","diff":diff,"truncated":truncated}))
        }
        "unchanged" if part.get("diff").is_none() && part.get("truncated").is_none() => {
            Some(json!({"status":"unchanged"}))
        }
        "unavailable" if part.get("diff").is_none() && part.get("truncated").is_none() => {
            Some(json!({"status":"unavailable"}))
        }
        _ => None,
    }
}

fn safe_terminal_text(value: &str, budget: usize) -> Option<String> {
    let mut output = String::with_capacity(value.len().min(budget));
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            if characters.next_if_eq(&'[').is_some() {
                for sequence in characters.by_ref() {
                    if ('@'..='~').contains(&sequence) {
                        break;
                    }
                }
            } else {
                characters.next();
            }
            continue;
        }
        match character {
            '\n' | '\t' => output.push(character),
            '\r' => {
                characters.next_if_eq(&'\n');
                output.push('\n');
            }
            value if !value.is_control() => output.push(value),
            _ => {}
        }
    }
    let output = output.trim().to_owned();
    (!output.is_empty()).then(|| truncate_utf8(&output, budget))
}

fn tool_detail(name: &str, arguments: Option<&Value>) -> Option<String> {
    let arguments = arguments.and_then(Value::as_object);
    let array_count = |key: &str, singular: &str, plural: &str| {
        arguments
            .and_then(|value| value.get(key))
            .and_then(Value::as_array)
            .map(|items| count_label(items.len(), singular, plural))
    };
    match name {
        name if is_file_tool(name) => arguments
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .and_then(safe_basename),
        "run_shell_command" => Some("Local shell command".into()),
        "todo" => array_count("todos", "task item", "task items")
            .or_else(|| Some("Current task list".into())),
        "clarify" => Some("User clarification request".into()),
        "memory_write" => arguments
            .and_then(|value| value.get("category"))
            .and_then(Value::as_str)
            .and_then(|category| match category {
                "preference" => Some("Preference memory".into()),
                "fact" => Some("Fact memory".into()),
                "project" => Some("Project memory".into()),
                _ => None,
            }),
        "memory_search" => Some("Saved memories".into()),
        "memory_consolidate" => array_count("operations", "memory operation", "memory operations"),
        "cron" => arguments
            .and_then(|value| value.get("action"))
            .and_then(Value::as_str)
            .and_then(|action| match action {
                "list" => Some("Scheduled tasks".into()),
                "add" => Some("Add scheduled task".into()),
                "update" => Some("Update scheduled task".into()),
                "remove" => Some("Remove scheduled task".into()),
                _ => None,
            }),
        "railgun_inspect" => arguments
            .and_then(|value| value.get("area"))
            .and_then(Value::as_str)
            .and_then(|area| match area {
                "config" => Some("Configuration diagnostics".into()),
                "sessions" => Some("Session diagnostics".into()),
                "memories" => Some("Memory diagnostics".into()),
                "cron" => Some("Schedule diagnostics".into()),
                "paths" => Some("Path diagnostics".into()),
                _ => None,
            }),
        "skill_view" => arguments
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .and_then(safe_one_line)
            .map(|name| format!("Skill: {name}")),
        "web_search" => Some("Public web search".into()),
        "web_fetch" => Some("Public web page".into()),
        "delegate_task" => array_count("goals", "delegated task", "delegated tasks"),
        _ => None,
    }
    .map(|detail| truncate_utf8(&detail, TOOL_DETAIL_BUDGET))
}

fn is_file_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file" | "create_file" | "write_file" | "delete_file" | "list_directory"
    )
}

fn count_label(count: usize, singular: &str, plural: &str) -> String {
    format!("{count} {}", if count == 1 { singular } else { plural })
}

fn safe_basename(path: &str) -> Option<String> {
    path.replace('\\', "/")
        .split('/')
        .next_back()
        .and_then(safe_one_line)
}

fn safe_one_line(value: &str) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then(|| truncate_utf8(&value, TOOL_DETAIL_BUDGET))
}

fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let allowed = max_bytes.saturating_sub('…'.len_utf8());
    let mut boundary = allowed.min(text.len());
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}…", &text[..boundary])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_provider_private_content_and_arguments() {
        let history = vec![json!({
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "secret"},
                {"type": "toolCall", "id": "1", "name": "read_file", "arguments": {"path": "/private/token.txt", "token": "secret"}},
                {"type": "text", "text": "Visible"}
            ]
        })];
        let result = page("s", &history, 0, 100, Some(&[7]), false);
        let encoded = result.to_string();
        assert!(encoded.contains("Visible"));
        assert!(encoded.contains("token.txt"));
        assert!(encoded.contains("\"detail\":\"token.txt\""));
        assert!(!encoded.contains("\"secret\""));
        assert!(!encoded.contains("/private/"));
    }

    #[test]
    fn file_tools_project_only_safe_basename_details_and_targets() {
        let tool_names = [
            "read_file",
            "create_file",
            "write_file",
            "delete_file",
            "list_directory",
        ];
        let calls = tool_names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                json!({
                    "type":"toolCall",
                    "id":format!("tool-{index}"),
                    "name":name,
                    "arguments":{
                        "path":format!("/Users/private/.hidden/{name}.txt"),
                        "content":"private content"
                    }
                })
            })
            .collect::<Vec<_>>();
        let result = page(
            "s",
            &[json!({"role":"assistant","content":calls})],
            0,
            100,
            None,
            false,
        );

        for message in result["messages"].as_array().unwrap() {
            let expected = format!("{}.txt", message["name"].as_str().unwrap());
            assert_eq!(message["target"], expected);
            assert_eq!(message["detail"], expected);
        }
        assert!(!result.to_string().contains("/Users/private"));
        assert!(!result.to_string().contains("private content"));
    }

    #[test]
    fn projects_turn_boundary_timestamps() {
        let history = vec![
            json!({"role":"user","at":1_000,"content":"Start"}),
            json!({"role":"assistant","at":208_000,"content":[{"type":"text","text":"Done"}]}),
        ];

        let result = page("s", &history, 0, 100, None, false);
        assert_eq!(result["messages"][0]["startedAt"], 1_000);
        assert_eq!(result["messages"][1]["completedAt"], 208_000);
    }

    #[test]
    fn projects_bounded_human_readable_tool_details_without_raw_payloads() {
        assert_eq!(
            tool_detail(
                "run_shell_command",
                Some(&json!({"command":"echo private"}))
            ),
            Some("Local shell command".into())
        );
        assert_eq!(
            tool_detail("todo", Some(&json!({"todos":[{}, {}]}))),
            Some("2 task items".into())
        );
        assert_eq!(
            tool_detail("memory_consolidate", Some(&json!({"operations":[{}]}))),
            Some("1 memory operation".into())
        );
        assert_eq!(
            tool_detail("cron", Some(&json!({"action":"add","prompt":"private"}))),
            Some("Add scheduled task".into())
        );
        assert_eq!(
            tool_detail("skill_view", Some(&json!({"name":"desktop-testing"}))),
            Some("Skill: desktop-testing".into())
        );
        assert_eq!(
            tool_detail(
                "delegate_task",
                Some(&json!({"goals":[{"goal":"one"},{"goal":"two"}]}))
            ),
            Some("2 delegated tasks".into())
        );

        for name in crate::tools::TOOL_NAMES {
            let arguments = match *name {
                "read_file" | "create_file" | "write_file" | "delete_file" | "list_directory" => {
                    json!({"path":"notes.md"})
                }
                "memory_write" => json!({"category":"project"}),
                "railgun_inspect" => json!({"area":"sessions"}),
                "skill_view" => json!({"name":"desktop-testing"}),
                "cron" => json!({"action":"list"}),
                "todo" => json!({"todos":[]}),
                "memory_consolidate" => json!({"operations":[]}),
                "delegate_task" => json!({"goals":[]}),
                _ => json!({}),
            };
            assert!(
                tool_detail(name, Some(&arguments)).is_some(),
                "{name} should have a safe tool detail"
            );
        }
    }

    #[test]
    fn projects_bounded_terminal_text_only_for_shell_commands() {
        let history = vec![
            json!({"role":"assistant","content":[
                {"type":"toolCall","id":"shell","name":"run_shell_command","arguments":{"command":"printf '\u{1b}[31mhello\u{1b}[0m'"}},
                {"type":"toolCall","id":"memory","name":"memory_write","arguments":{"content":"private memory","category":"fact"}}
            ]}),
            json!({"role":"tool","toolCallId":"shell","content":"\u{1b}[32mhello\u{1b}[0m\n","isError":false}),
            json!({"role":"tool","toolCallId":"memory","content":"private memory result","isError":false}),
        ];

        let result = page("s", &history, 0, 100, None, false);
        let tools = result["messages"].as_array().unwrap();
        let shell = tools
            .iter()
            .find(|message| message["name"] == "run_shell_command")
            .unwrap();
        assert_eq!(shell["command"], "printf 'hello'");
        assert_eq!(shell["output"], "hello");
        let memory = tools
            .iter()
            .find(|message| message["name"] == "memory_write")
            .unwrap();
        assert!(memory.get("command").is_none());
        assert!(memory.get("output").is_none());
        assert!(transcript_tool_results(&history)["memory"].output.is_none());
        assert!(!result.to_string().contains("private memory"));
        assert_eq!(
            safe_terminal_text("first\r\nsecond\rthird", 100),
            Some("first\nsecond\nthird".into())
        );
    }

    #[test]
    fn projects_only_valid_successful_file_change_metadata() {
        let history = vec![
            json!({"role":"assistant","content":[
                {"type":"toolCall","id":"create","name":"create_file","arguments":{"path":"/private/notes.txt","content":"secret"}},
                {"type":"toolCall","id":"write","name":"write_file","arguments":{"path":"/private/failed.txt","content":"secret"}},
                {"type":"toolCall","id":"delete","name":"delete_file","arguments":{"path":"/private/removed.txt"}},
                {"type":"toolCall","id":"malformed","name":"write_file","arguments":{"path":"/private/malformed.txt","content":"secret"}}
            ]}),
            json!({"role":"tool","toolCallId":"create","content":[
                {"type":"text","text":"Created"},
                {"type":"fileChange","status":"changed","diff":"--- notes.txt\n+++ notes.txt\n@@ -0,0 +1 @@\n+hello\n","truncated":false}
            ],"isError":false}),
            json!({"role":"tool","toolCallId":"malformed","content":[
                {"type":"text","text":"Wrote"},
                {"type":"fileChange","status":"unchanged","diff":"unexpected"}
            ],"isError":false}),
            json!({"role":"tool","toolCallId":"write","content":[
                {"type":"text","text":"Failed"},
                {"type":"fileChange","status":"unchanged"}
            ],"isError":true}),
            json!({"role":"tool","toolCallId":"delete","content":[
                {"type":"text","text":"Deleted"},
                {"type":"fileChange","status":"unavailable"}
            ],"isError":false}),
        ];

        let result = page("s", &history, 0, 100, None, false);
        let messages = result["messages"].as_array().unwrap();
        assert_eq!(
            messages[0]["fileChange"],
            json!({
                "status":"changed",
                "diff":"--- notes.txt\n+++ notes.txt\n@@ -0,0 +1 @@\n+hello\n",
                "truncated":false
            })
        );
        assert!(messages[1].get("fileChange").is_none());
        assert!(messages[2].get("fileChange").is_none());
        assert!(messages[3].get("fileChange").is_none());
        assert!(!result.to_string().contains("/private/"));
    }
}
