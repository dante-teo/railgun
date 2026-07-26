use crate::paths::RailgunPaths;
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::{os::unix::fs::PermissionsExt, path::Path};

pub fn defaults() -> Value {
    json!({
        "model": null,
        "operationTimeoutMs": 600000,
        "archiveRetentionDays": 7
    })
}

fn merge(defaults: &Value, user: &Value) -> Value {
    match (defaults, user) {
        (Value::Object(defaults), Value::Object(user)) => {
            let mut result = defaults.clone();
            for (key, value) in user {
                let merged = defaults
                    .get(key)
                    .map_or_else(|| value.clone(), |base| merge(base, value));
                result.insert(key.clone(), merged);
            }
            Value::Object(result)
        }
        (_, user) => user.clone(),
    }
}

pub fn validate(value: Value, path: &Path) -> Result<Value> {
    if !value.is_object() {
        bail!(
            "Invalid Railgun configuration at {}: the JSON root must be an object",
            path.display()
        );
    }
    let merged = merge(&defaults(), &value);
    let object = merged.as_object().expect("merged config is an object");
    match object.get("model") {
        Some(Value::Null) => {}
        Some(Value::String(model))
            if !model.is_empty() && !model.chars().any(char::is_whitespace) => {}
        _ => bail!(
            "Invalid Railgun configuration at {}: \"model\" must be a non-empty string without whitespace, or null",
            path.display()
        ),
    }
    if !matches!(
        object.get("archiveRetentionDays").and_then(Value::as_i64),
        Some(1 | 7 | 30 | 90)
    ) {
        bail!(
            "Invalid Railgun configuration at {}: \"archiveRetentionDays\" must be one of 1, 7, 30, or 90",
            path.display()
        );
    }
    if object
        .get("operationTimeoutMs")
        .and_then(Value::as_i64)
        .is_none_or(|value| value <= 0)
    {
        bail!(
            "Invalid Railgun configuration at {}: \"operationTimeoutMs\" must be a positive integer",
            path.display()
        );
    }
    if let Some(mode) = object.get("approvalMode") {
        if !matches!(mode.as_str(), Some("manual" | "smart" | "off")) {
            bail!(
                "Invalid Railgun configuration at {}: \"approvalMode\" must be \"manual\", \"smart\", or \"off\"",
                path.display()
            );
        }
    }
    if let Some(reviewer) = object.get("reviewerModel") {
        let valid = reviewer
            .as_str()
            .is_some_and(|model| !model.is_empty() && !model.chars().any(char::is_whitespace));
        if !valid {
            bail!(
                "Invalid Railgun configuration at {}: \"reviewerModel\" must be a non-empty string without whitespace",
                path.display()
            );
        }
    }
    let presets = object.get("moaPresets");
    if let Some(presets) = presets {
        let presets = presets.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "Invalid Railgun configuration at {}: \"moaPresets\" must be an object",
                path.display()
            )
        })?;
        for (name, preset) in presets {
            validate_moa_preset(name, preset, path)?;
        }
    }
    if let Some(active) = object.get("activeMoaPreset") {
        let active = active.as_str().filter(|value| !value.is_empty()).ok_or_else(|| {
            anyhow::anyhow!(
                "Invalid Railgun configuration at {}: \"activeMoaPreset\" must be a non-empty string",
                path.display()
            )
        })?;
        if presets
            .and_then(Value::as_object)
            .is_some_and(|presets| !presets.contains_key(active))
        {
            bail!(
                "Invalid Railgun configuration at {}: \"activeMoaPreset\" refers to unknown preset \"{active}\"",
                path.display()
            );
        }
    }
    if let Some(advisor) = object.get("advisor") {
        let advisor = advisor.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "Invalid Railgun configuration at {}: \"advisor\" must be an object",
                path.display()
            )
        })?;
        if advisor
            .get("enabled")
            .is_some_and(|value| !value.is_boolean())
        {
            bail!(
                "Invalid Railgun configuration at {}: \"advisor.enabled\" must be a boolean",
                path.display()
            );
        }
        if let Some(model) = advisor.get("model") {
            let valid = model
                .as_str()
                .is_some_and(|model| !model.is_empty() && !model.chars().any(char::is_whitespace));
            if !valid {
                bail!(
                    "Invalid Railgun configuration at {}: \"advisor.model\" must be a non-empty string without whitespace",
                    path.display()
                );
            }
        }
        if advisor.get("enabled").and_then(Value::as_bool) == Some(true)
            && advisor.get("model").is_none()
        {
            bail!(
                "Invalid Railgun configuration at {}: \"advisor\" is enabled but no model is assigned",
                path.display()
            );
        }
    }
    Ok(merged)
}

fn validate_moa_preset(name: &str, value: &Value, path: &Path) -> Result<()> {
    let preset = value.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "Invalid Railgun configuration at {}: moaPresets[\"{name}\"] must be an object",
            path.display()
        )
    })?;
    let references = preset
        .get("referenceModels")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Invalid Railgun configuration at {}: moaPresets[\"{name}\"].referenceModels must be an array",
                path.display()
            )
        })?;
    if references.is_empty() {
        bail!(
            "Invalid Railgun configuration at {}: moaPresets[\"{name}\"].referenceModels must not be empty",
            path.display()
        );
    }
    if references.len() > 8 {
        bail!(
            "Invalid Railgun configuration at {}: moaPresets[\"{name}\"].referenceModels must have at most 8 entries",
            path.display()
        );
    }
    for (index, slot) in references.iter().enumerate() {
        validate_model_slot(
            slot,
            &format!("moaPresets[\"{name}\"].referenceModels[{index}]"),
            path,
        )?;
    }
    validate_model_slot(
        preset.get("aggregator").unwrap_or(&Value::Null),
        &format!("moaPresets[\"{name}\"].aggregator"),
        path,
    )?;
    if preset.get("referenceMaxTokens").is_some_and(|value| {
        value
            .as_f64()
            .is_none_or(|value| !value.is_finite() || value <= 0.0)
    }) {
        bail!(
            "Invalid Railgun configuration at {}: moaPresets[\"{name}\"].referenceMaxTokens must be a positive number",
            path.display()
        );
    }
    Ok(())
}

fn validate_model_slot(value: &Value, field: &str, path: &Path) -> Result<()> {
    let slot = value.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "Invalid Railgun configuration at {}: {field} must be an object",
            path.display()
        )
    })?;
    if slot
        .get("model")
        .and_then(Value::as_str)
        .is_none_or(|model| model.is_empty())
    {
        bail!(
            "Invalid Railgun configuration at {}: {field}.model must be a non-empty string",
            path.display()
        );
    }
    if slot
        .get("temperature")
        .is_some_and(|temperature| !temperature.is_number())
    {
        bail!(
            "Invalid Railgun configuration at {}: {field}.temperature must be a number",
            path.display()
        );
    }
    Ok(())
}

pub async fn load(paths: &RailgunPaths) -> Result<Value> {
    let text = match tokio::fs::read_to_string(&paths.config).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(defaults()),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Invalid Railgun configuration at {}: could not read the file",
                    paths.config.display()
                )
            });
        }
    };
    let value = serde_json::from_str(&text).with_context(|| {
        format!(
            "Invalid Railgun configuration at {}: the file contains malformed JSON",
            paths.config.display()
        )
    })?;
    validate(value, &paths.config)
}

pub async fn update(
    paths: &RailgunPaths,
    current: &Value,
    patch: &Map<String, Value>,
) -> Result<Value> {
    let mut next = current.as_object().cloned().unwrap_or_default();
    for (key, value) in patch {
        if key == "activeMoaPreset" && value.is_null() {
            next.remove(key);
        } else {
            next.insert(key.clone(), value.clone());
        }
    }
    let next = validate(Value::Object(next), &paths.config)?;
    let parent = paths.config.parent().context("config path has no parent")?;
    tokio::fs::create_dir_all(parent).await?;
    tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
    let temporary = paths
        .config
        .with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let bytes = format!("{}\n", serde_json::to_string_pretty(&next)?);
    tokio::fs::write(&temporary, bytes).await?;
    tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?;
    tokio::fs::rename(&temporary, &paths.config).await?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_keys_and_nested_values_survive_validation() {
        let path = Path::new("/tmp/config.json");
        let value = validate(json!({"model": null, "future": {"enabled": true}}), path).unwrap();
        assert_eq!(value["future"]["enabled"], true);
    }

    #[test]
    fn validates_existing_reviewer_moa_and_advisor_shapes() {
        let path = Path::new("/tmp/config.json");
        let value = validate(
            json!({
                "model": "primary",
                "reviewerModel": "reviewer",
                "moaPresets": {
                    "careful": {
                        "referenceModels": [
                            {"model":"one"},
                            {"model":"two","temperature":0.2}
                        ],
                        "aggregator":{"model":"final"},
                        "referenceMaxTokens":2048
                    }
                },
                "activeMoaPreset":"careful",
                "advisor":{"enabled":true,"model":"advisor"}
            }),
            path,
        )
        .unwrap();
        assert_eq!(value["activeMoaPreset"], "careful");
        assert_eq!(value["advisor"]["model"], "advisor");
    }

    #[test]
    fn rejects_dangling_presets_and_enabled_advisors_without_models() {
        let path = Path::new("/tmp/config.json");
        let dangling = validate(
            json!({
                "model":null,
                "moaPresets":{},
                "activeMoaPreset":"missing"
            }),
            path,
        )
        .unwrap_err()
        .to_string();
        assert!(dangling.contains("refers to unknown preset"));

        let advisor = validate(json!({"model":null,"advisor":{"enabled":true}}), path)
            .unwrap_err()
            .to_string();
        assert!(advisor.contains("enabled but no model is assigned"));
    }
}
