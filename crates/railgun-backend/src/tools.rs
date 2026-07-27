use crate::{paths::RailgunPaths, storage::Store};
use anyhow::{Context, Result, bail};
use futures_util::{StreamExt, future::join_all};
use reqwest::redirect::Policy;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex, Semaphore, mpsc},
};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;
use widevin::{
    DevinChatRequest, DevinContentPart, DevinMessage, DevinProvider, DevinStreamEvent, DevinTool,
};

pub const TOOL_NAMES: &[&str] = &[
    "read_file",
    "write_file",
    "list_directory",
    "run_shell_command",
    "todo",
    "clarify",
    "memory_write",
    "memory_search",
    "memory_consolidate",
    "cron",
    "railgun_inspect",
    "skill_view",
    "web_search",
    "web_fetch",
    "delegate_task",
];
pub const ADVISOR_TOOL_NAMES: &[&str] = &["advise"];

const TEXT_LIMIT: usize = 200_000;
const WEB_LIMIT: usize = 50_000;
const MAX_FILE_BYTES: u64 = 1_000_000;

#[derive(Clone)]
pub struct ToolContext {
    pub paths: RailgunPaths,
    pub store: Store,
    pub cancellation: CancellationToken,
    pub updates: mpsc::UnboundedSender<Value>,
    pub todos: Arc<Mutex<Vec<Value>>>,
    pub interactions: Option<Interactions>,
    pub approvals: Arc<Mutex<HashSet<String>>>,
    pub delegation_depth: u8,
    pub delegation_slots: Arc<Semaphore>,
    pub provider: Option<DevinProvider>,
    pub model: Option<String>,
}

#[derive(Clone, Default)]
pub struct Interactions {
    pending: Arc<
        Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<InteractionResponse>>>,
    >,
}

#[derive(Clone, Debug)]
pub enum InteractionResponse {
    Approval(bool),
    Clarification(String),
}

impl Interactions {
    async fn request(
        &self,
        frame: Value,
        output: &mpsc::UnboundedSender<Value>,
        cancellation: &CancellationToken,
    ) -> Result<InteractionResponse> {
        let request_id = frame["requestId"]
            .as_str()
            .context("interaction frame is missing requestId")?
            .to_owned();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);
        let _ = output.send(frame);
        let response = tokio::select! {
            _ = cancellation.cancelled() => Err(anyhow::anyhow!("interaction cancelled")),
            answer = rx => answer.context("interaction request was abandoned"),
        };
        self.pending.lock().await.remove(&request_id);
        response
    }

    pub async fn request_approval(
        &self,
        command: &str,
        output: &mpsc::UnboundedSender<Value>,
        cancellation: &CancellationToken,
    ) -> Result<bool> {
        let request_id = Uuid::new_v4().to_string();
        match self
            .request(
                json!({"type":"approval_request","requestId":request_id,"command":command}),
                output,
                cancellation,
            )
            .await?
        {
            InteractionResponse::Approval(value) => Ok(value),
            InteractionResponse::Clarification(_) => {
                bail!("interaction response kind does not match approval request")
            }
        }
    }

    pub async fn request_clarification(
        &self,
        question: &str,
        choices: Vec<String>,
        output: &mpsc::UnboundedSender<Value>,
        cancellation: &CancellationToken,
    ) -> Result<String> {
        let request_id = Uuid::new_v4().to_string();
        let mut frame =
            json!({"type":"clarification_request","requestId":request_id,"question":question});
        if !choices.is_empty() {
            frame["choices"] = json!(choices);
        }
        match self.request(frame, output, cancellation).await? {
            InteractionResponse::Clarification(value) => Ok(value),
            InteractionResponse::Approval(_) => {
                bail!("interaction response kind does not match clarification request")
            }
        }
    }

    pub async fn resolve(&self, id: &str, response: InteractionResponse) -> Result<()> {
        let sender = self
            .pending
            .lock()
            .await
            .remove(id)
            .context("interaction request is no longer pending")?;
        sender
            .send(response)
            .map_err(|_| anyhow::anyhow!("interaction request is no longer pending"))
    }

    pub async fn reject_all(&self) {
        self.pending.lock().await.clear();
    }
}

pub fn schemas() -> Vec<DevinTool> {
    TOOL_NAMES.iter().map(|name| schema(name)).collect()
}

pub fn advisor_schemas() -> Vec<DevinTool> {
    ADVISOR_TOOL_NAMES.iter().map(|name| schema(name)).collect()
}

fn schema(name: &str) -> DevinTool {
    let (description, properties, required) = match name {
        "read_file" => (
            "Read UTF-8 text content from a process-accessible file.",
            json!({"path":{"type":"string"}}),
            json!(["path"]),
        ),
        "write_file" => (
            "Write UTF-8 text content to a process-accessible file.",
            json!({"path":{"type":"string"},"content":{"type":"string"}}),
            json!(["path", "content"]),
        ),
        "list_directory" => (
            "List the contents of a process-accessible directory.",
            json!({"path":{"type":"string"}}),
            json!(["path"]),
        ),
        "run_shell_command" => (
            "Run a shell command. Destructive commands are blocked and dangerous commands need approval.",
            json!({"command":{"type":"string"}}),
            json!(["command"]),
        ),
        "todo" => (
            "Read or persist the current session task list.",
            json!({"todos":{"type":"array"},"merge":{"type":"boolean"}}),
            json!([]),
        ),
        "clarify" => (
            "Ask the desktop user a question when a safe assumption is impossible.",
            json!({"question":{"type":"string"},"choices":{"type":"array","items":{"type":"string"},"maxItems":4}}),
            json!(["question"]),
        ),
        "memory_write" => (
            "Save a user fact or preference for future sessions.",
            json!({"content":{"type":"string"},"category":{"type":"string","enum":["preference","fact","project"]}}),
            json!(["content", "category"]),
        ),
        "memory_search" => (
            "Search saved memories by keyword.",
            json!({"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}}),
            json!(["query"]),
        ),
        "memory_consolidate" => (
            "Merge, update, or delete saved memories in a batch.",
            json!({"operations":{"type":"array","items":{"type":"object"}}}),
            json!(["operations"]),
        ),
        "cron" => (
            "List, add, update, or remove scheduled agent tasks.",
            json!({"action":{"type":"string","enum":["list","add","update","remove"]},"id":{"type":"string"},"schedule":{"type":"string"},"prompt":{"type":"string"}}),
            json!(["action"]),
        ),
        "railgun_inspect" => (
            "Inspect bounded, redacted Railgun diagnostics.",
            json!({"area":{"type":"string","enum":["config","sessions","memories","cron","paths"]}}),
            json!(["area"]),
        ),
        "skill_view" => (
            "Read a named skill's instructions.",
            json!({"name":{"type":"string"}}),
            json!(["name"]),
        ),
        "web_search" => (
            "Search the public web and return a bounded result list.",
            json!({"query":{"type":"string"},"max_results":{"type":"integer","minimum":1,"maximum":10}}),
            json!(["query"]),
        ),
        "web_fetch" => (
            "Fetch bounded text from a public HTTP(S) URL. Private networks are blocked.",
            json!({"url":{"type":"string"},"max_chars":{"type":"integer","minimum":1,"maximum":200000}}),
            json!(["url"]),
        ),
        "delegate_task" => (
            "Delegate independent goals to bounded child agents.",
            json!({"goals":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":3}}),
            json!(["goals"]),
        ),
        "advise" => (
            "Submit one concise advisor note for the primary agent.",
            json!({"severity":{"type":"string","enum":["nit","concern","blocker"]},"text":{"type":"string"}}),
            json!(["severity", "text"]),
        ),
        _ => unreachable!(),
    };
    DevinTool {
        name: name.into(),
        description: description.into(),
        input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        strict: true,
    }
}

pub async fn execute(name: &str, arguments: &Value, context: &ToolContext) -> Result<String> {
    if context.cancellation.is_cancelled() {
        bail!("[stopped by user]");
    }
    match name {
        "read_file" => read_file(arguments, context).await,
        "write_file" => write_file(arguments, context).await,
        "list_directory" => list_directory(arguments, context).await,
        "run_shell_command" => run_shell(arguments, context).await,
        "todo" => todo(arguments, context).await,
        "clarify" => clarify(arguments, context).await,
        "memory_write" => memory_write(arguments, context).await,
        "memory_search" => memory_search(arguments, context).await,
        "memory_consolidate" => memory_consolidate(arguments, context).await,
        "cron" => cron(arguments, context).await,
        "railgun_inspect" => inspect(arguments, context).await,
        "skill_view" => skill_view(arguments, context).await,
        "web_search" => web_search(arguments, context).await,
        "web_fetch" => web_fetch(arguments, context).await,
        "delegate_task" => delegate(arguments, context).await,
        "advise" => advise(arguments),
        _ => bail!("Error: unknown tool \"{name}\""),
    }
}

pub fn advisory(arguments: &Value) -> Result<(String, String)> {
    let severity = string(arguments, "severity")?;
    if !matches!(severity, "nit" | "concern" | "blocker") {
        bail!("advice severity must be nit, concern, or blocker")
    }
    let text = string(arguments, "text")?;
    Ok((severity.to_owned(), bounded(text.to_owned(), 4_000)))
}

fn advise(arguments: &Value) -> Result<String> {
    let (severity, text) = advisory(arguments)?;
    Ok(json!({"severity":severity,"text":text}).to_string())
}

fn string<'a>(arguments: &'a Value, key: &str) -> Result<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("{key} must be a non-empty string"))
}
fn bounded(value: String, limit: usize) -> String {
    if value.len() <= limit {
        value
    } else {
        let mut index = limit.saturating_sub('…'.len_utf8());
        while !value.is_char_boundary(index) {
            index -= 1;
        }
        format!("{}…", &value[..index])
    }
}

fn bounded_with_truncation(value: String, limit: usize) -> (String, bool) {
    let truncated = value.len() > limit;
    (bounded(value, limit), truncated)
}

fn agent_file_root(paths: &RailgunPaths) -> Result<PathBuf> {
    paths
        .home
        .parent()
        .map(Path::to_path_buf)
        .context("Railgun home has no parent")?
        .canonicalize()
        .context("could not access the user's home directory")
}

fn is_sensitive_local_file_path(path: &Path, root: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let components = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    let file_name = components
        .last()
        .copied()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = Path::new(&file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    components.first() == Some(&"Library")
        || components
            .iter()
            .any(|component| component.starts_with('.'))
        || matches!(extension, "key" | "pem" | "p12" | "pfx" | "kdbx")
        || matches!(
            file_name.as_str(),
            "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519"
        )
        || ["credential", "password", "secret", "token"]
            .iter()
            .any(|term| file_name.contains(term))
}

fn require_agent_path(path: PathBuf, root: &Path) -> Result<PathBuf> {
    if !path.starts_with(root) {
        bail!("file is outside the user's home directory");
    }
    if is_sensitive_local_file_path(&path, root) {
        bail!("file is in a protected location");
    }
    Ok(path)
}

async fn readable_file_path(raw: &str, root: &Path) -> Result<PathBuf> {
    let path = require_agent_path(
        tokio::fs::canonicalize(raw)
            .await
            .context("file does not exist or is inaccessible")?,
        root,
    )?;
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() {
        bail!("path is not a regular file");
    }
    if metadata.len() > MAX_FILE_BYTES {
        bail!("file is too large to read safely");
    }
    Ok(path)
}

async fn writable_file_path(raw: &str, root: &Path) -> Result<PathBuf> {
    match tokio::fs::canonicalize(raw).await {
        Ok(path) => {
            let path = require_agent_path(path, root)?;
            if !tokio::fs::metadata(&path).await?.is_file() {
                bail!("path is not a regular file");
            }
            Ok(path)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let requested = Path::new(raw);
            let parent = requested
                .parent()
                .context("file path has no parent directory")?;
            let parent = tokio::fs::canonicalize(parent)
                .await
                .context("parent directory does not exist or is inaccessible")?;
            let name = requested
                .file_name()
                .context("file path has no file name")?;
            require_agent_path(parent.join(name), root)
        }
        Err(error) => Err(error.into()),
    }
}

async fn directory_path(raw: &str, root: &Path) -> Result<PathBuf> {
    let path = require_agent_path(
        tokio::fs::canonicalize(raw)
            .await
            .context("directory does not exist or is inaccessible")?,
        root,
    )?;
    if !tokio::fs::metadata(&path).await?.is_dir() {
        bail!("path is not a directory");
    }
    Ok(path)
}

async fn read_file(arguments: &Value, context: &ToolContext) -> Result<String> {
    let root = agent_file_root(&context.paths)?;
    let path = readable_file_path(string(arguments, "path")?, &root).await?;
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        bail!("file is too large to read safely");
    }
    Ok(bounded(
        String::from_utf8(bytes).context("the selected file is not UTF-8 text")?,
        TEXT_LIMIT,
    ))
}
async fn write_file(arguments: &Value, context: &ToolContext) -> Result<String> {
    let root = agent_file_root(&context.paths)?;
    let path = writable_file_path(string(arguments, "path")?, &root).await?;
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .context("content must be a string")?;
    tokio::fs::write(&path, content).await?;
    Ok(format!(
        "Wrote {} bytes to {}",
        content.len(),
        path.display()
    ))
}
async fn list_directory(arguments: &Value, context: &ToolContext) -> Result<String> {
    let root = agent_file_root(&context.paths)?;
    let path = directory_path(string(arguments, "path")?, &root).await?;
    let mut entries = tokio::fs::read_dir(path).await?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let mut name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().await?.is_dir() {
            name.push('/');
        }
        names.push(name);
    }
    names.sort();
    Ok(if names.is_empty() {
        "(empty directory)".into()
    } else {
        bounded(names.join("\n"), TEXT_LIMIT)
    })
}

fn shell_tokens(command: &str) -> (String, Vec<String>) {
    let normalized = command
        .chars()
        .filter(|character| !matches!(character, '\\' | '\'' | '"'))
        .collect::<String>()
        .to_ascii_lowercase();
    let tokens = normalized
        .split(|character: char| {
            character.is_ascii_whitespace() || matches!(character, ';' | '|' | '&')
        })
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    (normalized, tokens)
}

fn blocked(command: &str) -> Option<&'static str> {
    let (normalized, tokens) = shell_tokens(command);
    if normalized.contains('$') || normalized.contains('`') {
        return Some("Dynamic shell syntax is blocked because it cannot be safely classified.");
    }
    let destructive_remove = tokens
        .iter()
        .position(|token| token == "rm")
        .is_some_and(|index| {
            tokens[index + 1..]
                .iter()
                .any(|token| token.contains('r') && token.contains('f'))
                && tokens[index + 1..].iter().any(|token| token == "/")
        });
    (destructive_remove
        || tokens
            .iter()
            .any(|token| matches!(token.as_str(), "mkfs" | "shutdown" | "reboot"))
        || tokens
            .windows(2)
            .any(|pair| pair[0] == "diskutil" && pair[1] == "erase")
        || normalized.contains(":(){"))
    .then_some("Command is blocked because it can destroy the system or user data.")
}
fn dangerous(command: &str) -> bool {
    let (normalized, tokens) = shell_tokens(command);
    if normalized.contains('\n') || normalized.contains('\r') {
        return true;
    }
    ["rm", "mv", "sudo", "chmod", "chown", "curl", "wget"]
        .iter()
        .any(|needle| tokens.iter().any(|token| token == needle))
        || tokens.windows(2).any(|pair| {
            (pair[0] == "git" && pair[1] == "reset") || (pair[0] == "git" && pair[1] == "clean")
        })
        || normalized.contains('>')
}
async fn run_shell(arguments: &Value, context: &ToolContext) -> Result<String> {
    let command = string(arguments, "command")?;
    if let Some(reason) = blocked(command) {
        bail!("{reason}");
    }
    if dangerous(command) && !context.approvals.lock().await.contains(command) {
        let interactions = context
            .interactions
            .as_ref()
            .context("dangerous commands cannot wait for desktop approval in this run")?;
        if !interactions
            .request_approval(command, &context.updates, &context.cancellation)
            .await?
        {
            bail!("Command not approved: {command}");
        }
        context.approvals.lock().await.insert(command.into());
    }
    let mut child = Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    child
        .args(["-lc", command])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::select! { _ = context.cancellation.cancelled() => bail!("[stopped by user]"), output = child.output() => output? };
    if output.status.success() {
        Ok(bounded(
            String::from_utf8_lossy(&output.stdout).into_owned(),
            TEXT_LIMIT,
        ))
    } else {
        bail!(
            "{}",
            bounded(
                String::from_utf8_lossy(&output.stderr).into_owned(),
                TEXT_LIMIT
            )
        )
    }
}

fn normalize_todo(value: &Value) -> Value {
    json!({"id":value.get("id").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).unwrap_or("?"),"content":value.get("content").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).unwrap_or("(no description)"),"status":match value.get("status").and_then(Value::as_str).unwrap_or("pending") { "in_progress" => "in_progress", "completed" => "completed", "cancelled" => "cancelled", _ => "pending" }})
}
async fn todo(arguments: &Value, context: &ToolContext) -> Result<String> {
    let mut todos = context.todos.lock().await;
    if let Some(value) = arguments.get("todos") {
        let next = value
            .as_array()
            .context("todos must be an array")?
            .iter()
            .map(normalize_todo)
            .take(256)
            .collect::<Vec<_>>();
        *todos = next;
    }
    let summary = json!({"total":todos.len(),"pending":todos.iter().filter(|todo| todo["status"]=="pending").count(),"in_progress":todos.iter().filter(|todo| todo["status"]=="in_progress").count(),"completed":todos.iter().filter(|todo| todo["status"]=="completed").count(),"cancelled":todos.iter().filter(|todo| todo["status"]=="cancelled").count()});
    Ok(json!({"todos":*todos,"summary":summary}).to_string())
}
async fn clarify(arguments: &Value, context: &ToolContext) -> Result<String> {
    let choices = arguments
        .get("choices")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(4)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let answer = context
        .interactions
        .as_ref()
        .context("clarify is not available in this context")?
        .request_clarification(
            string(arguments, "question")?,
            choices,
            &context.updates,
            &context.cancellation,
        )
        .await?;
    Ok(json!({"question":string(arguments,"question")?,"answer":answer}).to_string())
}
async fn memory_write(arguments: &Value, context: &ToolContext) -> Result<String> {
    context
        .store
        .create_memory(
            string(arguments, "content")?,
            string(arguments, "category")?,
        )
        .await?;
    Ok("Saved.".into())
}
async fn memory_search(arguments: &Value, context: &ToolContext) -> Result<String> {
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(10)
        .clamp(1, 100);
    let memories = context
        .store
        .memories(Some(string(arguments, "query")?), limit)
        .await?;
    Ok(if memories.is_empty() {
        "No matching memories found.".into()
    } else {
        memories
            .iter()
            .map(|m| {
                format!(
                    "- [{}] {}",
                    m["category"].as_str().unwrap_or_default(),
                    m["content"].as_str().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}
async fn memory_consolidate(arguments: &Value, context: &ToolContext) -> Result<String> {
    let ops = arguments
        .get("operations")
        .and_then(Value::as_array)
        .context("memory_consolidate requires an operations array")?;
    let mut results = Vec::new();
    for operation in ops {
        let action = string(operation, "action")?;
        let ids = operation
            .get("ids")
            .and_then(Value::as_array)
            .context("operation ids must be an array")?
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        match action {
            "delete" => {
                let mut count = 0;
                for id in ids {
                    count += usize::from(context.store.delete_memory(id).await?);
                }
                results.push(format!("Deleted {count} memories"));
            }
            "update" => {
                if ids.len() != 1 {
                    bail!("update requires exactly one id");
                }
                context
                    .store
                    .update_memory(
                        ids[0],
                        Some(string(operation, "newContent")?),
                        operation.get("category").and_then(Value::as_str),
                    )
                    .await?
                    .context("memory not found")?;
                results.push("Updated memory".into());
            }
            "merge" => {
                if ids.len() < 2 {
                    bail!("merge requires at least two ids");
                }
                for id in ids {
                    context.store.delete_memory(id).await?;
                }
                context
                    .store
                    .create_memory(
                        string(operation, "newContent")?,
                        string(operation, "category")?,
                    )
                    .await?;
                results.push("Merged memories".into());
            }
            _ => bail!("unknown consolidation action"),
        }
    }
    Ok(results.join("\n"))
}

async fn cron(arguments: &Value, context: &ToolContext) -> Result<String> {
    let mut jobs = load_jobs(&context.paths).await?;
    match string(arguments, "action")? {
        "list" => Ok(if jobs.is_empty() {
            "No cron jobs configured.".into()
        } else {
            serde_json::to_string_pretty(&jobs)?
        }),
        "add" => {
            let id = string(arguments, "id")?;
            if jobs.iter().any(|job| job["id"] == id) {
                bail!("a cron job with id {id:?} already exists")
            };
            let schedule = string(arguments, "schedule")?;
            validate_schedule(schedule)?;
            let prompt = string(arguments, "prompt")?;
            jobs.push(json!({"id":id,"schedule":schedule,"prompt":prompt,"lastRun":null,"requiredOutputs":[],"lastSuccess":null,"lastStatus":null,"lastError":null}));
            save_jobs(&context.paths, &jobs).await?;
            Ok(format!("Added cron job {id:?}"))
        }
        "remove" => {
            let id = string(arguments, "id")?;
            let before = jobs.len();
            jobs.retain(|job| job["id"] != id);
            if jobs.len() == before {
                bail!("no cron job found with id {id:?}")
            };
            save_jobs(&context.paths, &jobs).await?;
            Ok(format!("Removed cron job {id:?}."))
        }
        "update" => {
            let id = string(arguments, "id")?;
            let job = jobs
                .iter_mut()
                .find(|job| job["id"] == id)
                .context("cron job not found")?;
            if let Some(schedule) = arguments.get("schedule").and_then(Value::as_str) {
                validate_schedule(schedule)?;
                job["schedule"] = json!(schedule);
            }
            if let Some(prompt) = arguments
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|p| !p.trim().is_empty())
            {
                job["prompt"] = json!(prompt);
            }
            save_jobs(&context.paths, &jobs).await?;
            Ok(format!("Updated cron job {id:?}."))
        }
        _ => bail!("unknown cron action"),
    }
}
pub async fn load_jobs(paths: &RailgunPaths) -> Result<Vec<Value>> {
    match tokio::fs::read_to_string(&paths.cron).await {
        Ok(value) => {
            let jobs: Vec<Value> = serde_json::from_str(&value)?;
            for job in &jobs {
                validate_schedule(job["schedule"].as_str().unwrap_or_default())?;
            }
            Ok(jobs)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}
pub async fn save_jobs(paths: &RailgunPaths, jobs: &[Value]) -> Result<()> {
    if let Some(parent) = paths.cron.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(
        &paths.cron,
        format!("{}\n", serde_json::to_string_pretty(jobs)?),
    )
    .await?;
    Ok(())
}
pub fn validate_schedule(schedule: &str) -> Result<()> {
    if schedule.trim().is_empty() {
        bail!("cron schedule must not be empty")
    };
    if schedule.split_ascii_whitespace().count() != 5 {
        bail!("cron schedule must use five-minute fields")
    }
    schedule.parse::<croner::Cron>()?;
    Ok(())
}

async fn inspect(arguments: &Value, context: &ToolContext) -> Result<String> {
    let area = string(arguments, "area")?;
    let value = match area {
        "sessions" => json!({"sessions":context.store.list_sessions(false).await?}),
        "memories" => json!({"memories":context.store.memories(None,20).await?}),
        "cron" => json!({"jobs":load_jobs(&context.paths).await?}),
        "paths" => json!({"state":"configured","cron":"configured","skills":"configured"}),
        "config" => {
            json!({"stateExists":context.paths.state.exists(),"cronExists":context.paths.cron.exists()})
        }
        _ => bail!("unknown inspection area"),
    };
    Ok(bounded(serde_json::to_string_pretty(&value)?, TEXT_LIMIT))
}
async fn skill_view(arguments: &Value, context: &ToolContext) -> Result<String> {
    let name = string(arguments, "name")?;
    let path = find_skill(&context.paths.skills, name)?;
    Ok(bounded(tokio::fs::read_to_string(path).await?, TEXT_LIMIT))
}
fn find_skill(root: &Path, name: &str) -> Result<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            let candidate = path.join("SKILL.md");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        if let Ok(entries) = std::fs::read_dir(&path) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    stack.push(entry.path())
                }
            }
        }
    }
    bail!("Skill {name:?} not found.")
}

async fn web_search(arguments: &Value, _context: &ToolContext) -> Result<String> {
    let query = string(arguments, "query")?;
    let count = arguments
        .get("max_results")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, 10);
    let url = Url::parse_with_params("https://html.duckduckgo.com/html/", &[("q", query)])?;
    let text = public_client()?
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let results = text
        .split("result__a")
        .skip(1)
        .take(count as usize)
        .map(|part| bounded(part.replace('<', " <"), 1000))
        .collect::<Vec<_>>();
    Ok(json!({"query":query,"provider":"duckduckgo","results":results}).to_string())
}
fn public_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Railgun/0.10")
        .build()?)
}
struct ValidatedUrl {
    url: Url,
    host: String,
    addresses: Vec<SocketAddr>,
}

fn public_url(raw: &str) -> Result<ValidatedUrl> {
    let url = Url::parse(raw).context("malformed URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("only HTTP(S) URLs are supported")
    };
    if !url.username().is_empty() || url.password().is_some() {
        bail!("credentials in URLs are not allowed")
    };
    let host = url.host_str().context("URL has no host")?.to_owned();
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        bail!("localhost is not allowed")
    };
    let port = url
        .port_or_known_default()
        .context("URL has no known port")?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            bail!("URL resolves to a non-public address")
        };
        vec![SocketAddr::new(ip, port)]
    } else {
        let addresses = (
            host.as_str(),
            if url.scheme() == "https" { 443 } else { 80 },
        )
            .to_socket_addrs()?
            .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
            bail!("hostname resolved to a non-public or unavailable address")
        };
        addresses
    };
    Ok(ValidatedUrl {
        url,
        host,
        addresses,
    })
}
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.is_multicast())
        }
        IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(ipv4));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
    }
}
fn pinned_public_client(target: &ValidatedUrl) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Railgun/0.10")
        .resolve_to_addrs(&target.host, &target.addresses)
        .build()?)
}
async fn web_fetch(arguments: &Value, context: &ToolContext) -> Result<String> {
    let mut target = public_url(string(arguments, "url")?)?;
    let max = arguments
        .get("max_chars")
        .and_then(Value::as_u64)
        .unwrap_or(WEB_LIMIT as u64)
        .clamp(1, TEXT_LIMIT as u64) as usize;
    for redirects in 0..=5 {
        if context.cancellation.is_cancelled() {
            bail!("[stopped by user]")
        };
        let response = pinned_public_client(&target)?
            .get(target.url.clone())
            .send()
            .await?;
        if response.status().is_redirection() {
            if redirects == 5 {
                bail!("too many redirects")
            };
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .context("redirect did not include a Location header")?
                .to_str()?;
            target = public_url(target.url.join(next)?.as_ref())?;
            continue;
        }
        let response = response.error_for_status()?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("unknown")
            .to_owned();
        if !(content_type.starts_with("text/")
            || content_type.contains("json")
            || content_type.contains("html"))
        {
            bail!("unsupported content type: {content_type}")
        };
        let (content, truncated) = bounded_with_truncation(response.text().await?, max);
        return Ok(json!({"final_url":target.url.to_string(),"content_type":content_type,"content":content,"truncated":truncated}).to_string());
    }
    unreachable!()
}

async fn delegate(arguments: &Value, context: &ToolContext) -> Result<String> {
    if context.delegation_depth >= 2 {
        bail!("delegation depth limit reached")
    }
    let goals = arguments
        .get("goals")
        .and_then(Value::as_array)
        .context("delegate_task requires goals array")?;
    if goals.is_empty() || goals.len() > 3 {
        bail!("delegate_task requires between one and three goals")
    }
    let provider = context
        .provider
        .clone()
        .context("delegation is not available in this run")?;
    let model = context
        .model
        .clone()
        .context("delegation is not available in this run")?;
    let count = goals.len();
    let children = goals.iter().enumerate().map(|(index, goal)| {
        let goal = string(goal, "goal").map(str::to_owned);
        let provider = provider.clone();
        let model = model.clone();
        let slots = context.delegation_slots.clone();
        let cancellation = context.cancellation.clone();
        let updates = context.updates.clone();
        async move {
            let goal = goal?;
            let permit = slots.acquire_owned().await?;
            let _ = updates
                .send(json!({"type":"subagent_start","goal":goal,"index":index,"count":count}));
            let result = child_turn(provider, model, &goal, cancellation).await;
            drop(permit);
            let output = result
                .as_ref()
                .map_or_else(|error| format!("Error: {error}"), Clone::clone);
            let _ = updates
                .send(json!({"type":"subagent_end","goal":goal,"index":index,"result":output}));
            result
        }
    });
    Ok(join_all(children)
        .await
        .into_iter()
        .collect::<Result<Vec<_>>>()?
        .join("\n\n"))
}

async fn child_turn(
    provider: DevinProvider,
    model: String,
    goal: &str,
    cancellation: CancellationToken,
) -> Result<String> {
    let request=DevinChatRequest { model, messages: vec![DevinMessage::User { content: vec![DevinContentPart::Text { text: goal.into() }] }], system_prompt: vec!["You are a bounded delegated subagent. Complete this independent goal concisely. Do not delegate further.".into()], ..Default::default() };
    let mut stream = provider.stream_chat(request);
    let mut text = String::new();
    let mut turns = 0;
    loop {
        tokio::select! { _=cancellation.cancelled()=>bail!("[stopped by user]"), event=stream.next()=>match event { Some(event)=>match event? { DevinStreamEvent::TextDelta{delta}=>text.push_str(&delta), DevinStreamEvent::Done{..}=>break, _=>{} }, None=>break } }
        turns += 1;
        if turns > 10_000 {
            bail!("child turn exceeded event budget")
        }
    }
    if text.trim().is_empty() {
        bail!("delegated agent returned an empty result")
    } else {
        Ok(bounded(text, TEXT_LIMIT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn registry_advertises_every_restored_schema() {
        let advertised = schemas()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert_eq!(advertised, TOOL_NAMES);
    }

    #[test]
    fn advisor_tool_is_not_advertised_to_the_primary_agent() {
        assert!(!schemas().iter().any(|tool| tool.name == "advise"));
        assert_eq!(advisor_schemas()[0].name, "advise");
        assert_eq!(
            advisory(&json!({"severity":"concern","text":"Check the migration."}))
                .unwrap()
                .0,
            "concern"
        );
    }

    #[tokio::test]
    async fn filesystem_tools_reject_sensitive_model_paths() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let token = directory.path().join(".railgun/devin-token");
        tokio::fs::create_dir_all(token.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&token, "secret").await.unwrap();
        assert!(
            readable_file_path(token.to_str().unwrap(), &root)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn filesystem_tools_reject_outside_and_oversized_paths_before_reading() {
        let home = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = home.path().canonicalize().unwrap();
        let outside_file = outside.path().join("outside.txt");
        tokio::fs::write(&outside_file, "outside").await.unwrap();
        assert!(
            readable_file_path(outside_file.to_str().unwrap(), &root)
                .await
                .is_err()
        );

        let oversized = home.path().join("large.txt");
        tokio::fs::write(&oversized, vec![b'x'; MAX_FILE_BYTES as usize + 1])
            .await
            .unwrap();
        assert!(
            readable_file_path(oversized.to_str().unwrap(), &root)
                .await
                .is_err()
        );
    }

    #[test]
    fn private_networks_are_not_fetchable() {
        assert!(public_url("http://127.0.0.1/secret").is_err());
        assert!(public_url("http://[::ffff:127.0.0.1]/").is_err());
        assert!(public_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn shell_policy_normalizes_whitespace_before_classification() {
        assert!(blocked("rm\t-rf\t/").is_some());
        assert!(blocked("r\\m -rf /").is_some());
        assert!(dangerous("rm\ttemporary-file"));
    }

    #[test]
    fn bounded_web_content_reports_truncation() {
        assert_eq!(
            bounded_with_truncation("abcdef".into(), 3),
            ("…".into(), true)
        );
        assert_eq!(
            bounded_with_truncation("abc".into(), 3),
            ("abc".into(), false)
        );
    }

    #[tokio::test]
    async fn interactions_round_trip_the_original_request() {
        let interactions = Interactions::default();
        let cancellation = CancellationToken::new();
        let (output, mut frames) = mpsc::unbounded_channel();
        let pending = tokio::spawn({
            let interactions = interactions.clone();
            let cancellation = cancellation.clone();
            async move {
                interactions
                    .request_clarification(
                        "Which target?",
                        vec!["A".into()],
                        &output,
                        &cancellation,
                    )
                    .await
            }
        });
        let request = frames.recv().await.unwrap();
        assert_eq!(request["type"], "clarification_request");
        interactions
            .resolve(
                request["requestId"].as_str().unwrap(),
                InteractionResponse::Clarification("A".into()),
            )
            .await
            .unwrap();
        assert_eq!(pending.await.unwrap().unwrap(), "A");
    }

    #[tokio::test]
    async fn cancelling_an_interaction_removes_its_pending_request() {
        let interactions = Interactions::default();
        let cancellation = CancellationToken::new();
        let (output, mut frames) = mpsc::unbounded_channel();
        let pending = tokio::spawn({
            let interactions = interactions.clone();
            let cancellation = cancellation.clone();
            async move {
                interactions
                    .request_approval("rm risky-file", &output, &cancellation)
                    .await
            }
        });
        let request = frames.recv().await.unwrap();
        cancellation.cancel();
        assert!(pending.await.unwrap().is_err());
        assert!(
            interactions
                .resolve(
                    request["requestId"].as_str().unwrap(),
                    InteractionResponse::Approval(true),
                )
                .await
                .is_err()
        );
    }
}
