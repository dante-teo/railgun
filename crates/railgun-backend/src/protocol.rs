use anyhow::{Result, bail};
use serde_json::{Map, Value};

pub const VERSION: i64 = 1;
pub const CAPABILITIES: &[&str] = &[
    "sessions",
    "interaction.approval",
    "interaction.clarification",
    "config",
    "mcp",
    "cron",
    "memory",
    "dream",
    "instructions",
    "skills",
    "session.delivery",
    "model_catalog.refresh",
];

#[derive(Clone, Debug)]
pub struct Command {
    pub id: Option<String>,
    pub kind: String,
    pub fields: Map<String, Value>,
}

impl Command {
    pub fn parse(value: Value) -> Result<Self> {
        let Value::Object(fields) = value else {
            bail!("invalid command: missing type field");
        };
        let kind = fields
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("invalid command: missing type field"))?
            .to_owned();
        let id = match fields.get("id") {
            None => None,
            Some(value) => Some(non_empty(value, "id")?.to_owned()),
        };
        validate(&kind, &fields)?;
        Ok(Self { id, kind, fields })
    }

    pub fn string(&self, field: &str) -> Result<&str> {
        non_empty(
            self.fields.get(field).ok_or_else(|| {
                anyhow::anyhow!("invalid command: {field} must be a non-empty string")
            })?,
            field,
        )
    }

    pub fn bool(&self, field: &str) -> Result<bool> {
        self.fields
            .get(field)
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow::anyhow!("invalid command: {field} must be a boolean"))
    }

    pub fn integer(&self, field: &str) -> Result<i64> {
        self.fields
            .get(field)
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow::anyhow!("invalid command: {field} must be an integer"))
    }
}

fn non_empty<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("invalid command: {field} must be a non-empty string"))
}

fn optional_bool(fields: &Map<String, Value>, field: &str) -> Result<()> {
    if fields.get(field).is_some_and(|value| !value.is_boolean()) {
        bail!("invalid command: {field} must be a boolean");
    }
    Ok(())
}

fn optional_limit(fields: &Map<String, Value>) -> Result<()> {
    if let Some(value) = fields.get("limit") {
        let valid = value
            .as_i64()
            .is_some_and(|value| (1..=100).contains(&value));
        if !valid {
            bail!("invalid command: limit must be an integer between 1 and 100");
        }
    }
    Ok(())
}

fn optional_cursor(fields: &Map<String, Value>) -> Result<()> {
    if fields
        .get("cursor")
        .is_some_and(|value| value.as_i64().is_none_or(|value| value < 0))
    {
        bail!("invalid command: cursor must be a non-negative integer");
    }
    Ok(())
}

fn require_string(fields: &Map<String, Value>, field: &str) -> Result<()> {
    non_empty(
        fields.get(field).ok_or_else(|| {
            anyhow::anyhow!("invalid command: {field} must be a non-empty string")
        })?,
        field,
    )?;
    Ok(())
}

fn require_text(fields: &Map<String, Value>, field: &str) -> Result<()> {
    if !fields.get(field).is_some_and(Value::is_string) {
        bail!("invalid command: {field} must be a string");
    }
    Ok(())
}

fn require_object(fields: &Map<String, Value>, field: &str) -> Result<()> {
    if !fields.get(field).is_some_and(Value::is_object) {
        bail!("invalid command: {field} must be an object");
    }
    Ok(())
}

fn validate(kind: &str, fields: &Map<String, Value>) -> Result<()> {
    match kind {
        "initialize" => {
            if fields.get("version").and_then(Value::as_i64).is_none() {
                bail!("invalid command: version must be an integer");
            }
            if fields
                .get("clientName")
                .is_some_and(|value| !value.is_string())
            {
                bail!("invalid command: clientName must be a string");
            }
        }
        "prompt" | "steer" | "follow_up" => require_string(fields, "message")?,
        "set_model" => require_string(fields, "modelId")?,
        "set_auto_compaction" => {
            if !fields.get("enabled").is_some_and(Value::is_boolean) {
                bail!("invalid command: enabled must be a boolean");
            }
        }
        "approval_response" => {
            require_string(fields, "requestId")?;
            if !fields.get("approved").is_some_and(Value::is_boolean) {
                bail!("invalid command: approved must be a boolean");
            }
        }
        "clarification_response" => {
            require_string(fields, "requestId")?;
            require_string(fields, "answer")?;
        }
        "session_new" => {
            if fields.contains_key("modelId") {
                require_string(fields, "modelId")?;
            }
        }
        "session_load" => {
            require_string(fields, "sessionId")?;
            optional_bool(fields, "includeMessages")?;
        }
        "session_archive" | "session_unarchive" => require_string(fields, "sessionId")?,
        "session_branch" => {
            if fields
                .get("messageId")
                .and_then(Value::as_i64)
                .is_none_or(|value| value < 1)
            {
                bail!("invalid command: messageId must be a positive integer");
            }
            optional_bool(fields, "summarize")?;
            optional_bool(fields, "includeMessages")?;
        }
        "session_fork" => {
            if fields.contains_key("sessionId") {
                require_string(fields, "sessionId")?;
            }
            optional_bool(fields, "includeMessages")?;
        }
        "session_recent_messages" => {
            if fields.contains_key("sessionId") {
                require_string(fields, "sessionId")?;
            }
            optional_limit(fields)?;
        }
        "session_transcript" => {
            require_string(fields, "sessionId")?;
            optional_cursor(fields)?;
            optional_limit(fields)?;
        }
        "config_update" => require_object(fields, "patch")?,
        "mcp_upsert" => {
            require_string(fields, "name")?;
            require_string(fields, "command")?;
            if let Some(args) = fields.get("args") {
                let valid = args
                    .as_array()
                    .is_some_and(|values| values.iter().all(Value::is_string));
                if !valid {
                    bail!("invalid command: args must be an array of strings");
                }
            }
            if let Some(env) = fields.get("env") {
                let valid = env.as_object().is_some_and(|values| {
                    values
                        .values()
                        .all(|value| value.is_string() || value.is_null())
                });
                if !valid {
                    bail!("invalid command: env values must be strings or null");
                }
            }
        }
        "mcp_remove" => require_string(fields, "name")?,
        "cron_list" => {
            optional_cursor(fields)?;
            optional_limit(fields)?;
            optional_bool(fields, "editableOnly")?;
            if fields
                .get("maxPromptLength")
                .is_some_and(|value| value.as_i64().is_none_or(|value| value < 1))
            {
                bail!("invalid command: maxPromptLength must be a positive integer");
            }
        }
        "cron_add" => {
            require_string(fields, "schedule")?;
            require_string(fields, "prompt")?;
            if fields.contains_key("jobId") {
                require_string(fields, "jobId")?;
            }
            optional_bool(fields, "includeJob")?;
        }
        "cron_update" => {
            require_string(fields, "jobId")?;
            require_object(fields, "patch")?;
            optional_bool(fields, "includeJob")?;
        }
        "cron_remove" => require_string(fields, "jobId")?,
        "memory_list" => optional_limit(fields)?,
        "memory_search" => {
            require_string(fields, "query")?;
            optional_limit(fields)?;
        }
        "memory_create" => {
            require_string(fields, "content")?;
            require_string(fields, "category")?;
        }
        "memory_update" => {
            require_string(fields, "memoryId")?;
            require_object(fields, "patch")?;
        }
        "memory_delete" => require_string(fields, "memoryId")?,
        "instruction_file_get" => require_string(fields, "fileId")?,
        "instruction_file_update" => {
            require_string(fields, "fileId")?;
            if !fields.get("content").is_some_and(Value::is_string) {
                bail!("invalid command: content must be a string");
            }
        }
        "skill_get" | "skill_delete" => require_string(fields, "name")?,
        "skill_create" | "skill_update" => {
            require_string(fields, "name")?;
            require_string(fields, "description")?;
            require_text(fields, "body")?;
            optional_bool(fields, "disableModelInvocation")?;
        }
        "abort"
        | "get_state"
        | "get_messages"
        | "get_available_models"
        | "refresh_model_catalog"
        | "compact"
        | "session_list"
        | "session_list_archived"
        | "session_save"
        | "session_delivery_cursor"
        | "config_get"
        | "mcp_list"
        | "skills_list"
        | "dream_run"
        | "instruction_files_list" => {}
        _ => bail!("unknown command: {kind}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_limits_and_ids() {
        assert_eq!(
            Command::parse(json!({"type":"session_transcript","sessionId":"s","limit":101}))
                .unwrap_err()
                .to_string(),
            "invalid command: limit must be an integer between 1 and 100"
        );
        assert!(Command::parse(json!({"id":"1","type":"initialize","version":1})).is_ok());
    }

    #[test]
    fn accepts_the_additive_fieldless_catalog_refresh_command() {
        assert!(Command::parse(json!({"id":"refresh-1","type":"refresh_model_catalog"})).is_ok());
        assert!(CAPABILITIES.contains(&"model_catalog.refresh"));
    }

    #[test]
    fn validates_skill_crud_shapes_without_rejecting_an_empty_body() {
        assert!(
            Command::parse(json!({
                "type":"skill_create",
                "name":"review",
                "description":"Review the change",
                "body":"",
                "disableModelInvocation":false
            }))
            .is_ok()
        );
        assert!(
            Command::parse(json!({
                "type":"skill_update",
                "name":"review",
                "description":"Review the change",
                "body":"body"
            }))
            .is_ok()
        );
        assert!(Command::parse(json!({"type":"skill_delete","name":"review"})).is_ok());
        assert!(
            Command::parse(json!({
                "type":"skill_create",
                "name":"review",
                "description":"Review"
            }))
            .is_err()
        );
        assert!(
            Command::parse(json!({
                "type":"skill_create",
                "name":"review",
                "description":"Review",
                "body":"body",
                "disableModelInvocation":"false"
            }))
            .is_err()
        );
    }
}
