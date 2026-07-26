use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub const PAGE_LIMIT: usize = 100;
const DATA_BUDGET: usize = 48 * 1024;
const TEXT_BUDGET: usize = 24 * 1024;

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
    let failures = tool_failures(history);
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
        result.extend(transcript_tools(source, history_index, &failures));
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
    match item.get("content") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect(),
        _ => String::new(),
    }
}

fn tool_failures(history: &[Value]) -> HashMap<String, bool> {
    history
        .iter()
        .filter(|message| message["role"] == "tool")
        .filter_map(|message| {
            Some((
                message.get("toolCallId")?.as_str()?.to_owned(),
                message.get("isError").and_then(Value::as_bool) == Some(true),
            ))
        })
        .collect()
}

fn transcript_tools(
    message: &Value,
    history_index: usize,
    failures: &HashMap<String, bool>,
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
                "failed": failures.get(id).copied().unwrap_or(false),
            });
            if matches!(name, "read_file" | "write_file" | "list_directory") {
                if let Some(path) = call
                    .get("arguments")
                    .and_then(Value::as_object)
                    .and_then(|arguments| arguments.get("path"))
                    .and_then(Value::as_str)
                    .and_then(|path| {
                        path.replace('\\', "/")
                            .split('/')
                            .next_back()
                            .map(str::to_owned)
                    })
                    .filter(|target| !target.trim().is_empty())
                {
                    result["target"] = Value::String(truncate_utf8(path.trim(), 256));
                }
            }
            Some(result)
        })
        .collect()
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
        assert!(!encoded.contains("\"secret\""));
        assert!(!encoded.contains("/private/"));
    }
}
