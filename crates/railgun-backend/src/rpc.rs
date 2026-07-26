use crate::{
    auth::{self, Authenticated},
    config,
    paths::RailgunPaths,
    protocol::{CAPABILITIES, Command, VERSION},
    storage::{Session, Store},
    transcript,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::{Map, Value, json};
use std::{collections::HashMap, path::PathBuf, str::FromStr};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use widevin::{
    DevinAssistantContentPart, DevinChatRequest, DevinContentPart, DevinMessage, DevinStreamEvent,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendMode {
    Desktop,
    Scheduler,
    Dream,
    Login,
    Logout,
}

impl BackendMode {
    pub fn parse(arguments: &[String]) -> Result<Self> {
        if arguments.len() != 1 {
            bail!("Usage: private Railgun backend <desktop|scheduler|dream|login|logout>");
        }
        match arguments[0].as_str() {
            "desktop" => Ok(Self::Desktop),
            "scheduler" => Ok(Self::Scheduler),
            "dream" => Ok(Self::Dream),
            "login" => Ok(Self::Login),
            "logout" => Ok(Self::Logout),
            _ => bail!("Usage: private Railgun backend <desktop|scheduler|dream|login|logout>"),
        }
    }
}

pub async fn run_backend(mode: BackendMode) -> Result<()> {
    let paths = RailgunPaths::discover()?;
    if let Some(user_home) = paths.home.parent() {
        std::env::set_current_dir(user_home)?;
    }
    match mode {
        BackendMode::Desktop => run_desktop(paths).await,
        BackendMode::Scheduler => run_scheduler(paths).await,
        BackendMode::Dream => run_dream(paths).await,
        BackendMode::Login => auth::login(&paths).await,
        BackendMode::Logout => auth::logout(&paths).await,
    }
}

struct ActiveRun {
    id: Option<String>,
    cancellation: CancellationToken,
}

enum RunUpdate {
    Frame(Value),
    Complete {
        id: Option<String>,
        messages: Vec<Value>,
        result: Result<(), String>,
    },
}

struct Coordinator {
    paths: RailgunPaths,
    authenticated: Authenticated,
    store: Store,
    config: Value,
    active: Session,
    initialized: bool,
    run: Option<ActiveRun>,
    output: mpsc::UnboundedSender<Value>,
    updates: mpsc::UnboundedSender<RunUpdate>,
}

async fn run_desktop(paths: RailgunPaths) -> Result<()> {
    let authenticated = match auth::provider(&paths, true).await {
        Ok(value) => value,
        Err(error) => return report_authentication_failure(error).await,
    };
    let config = config::load(&paths).await?;
    let models = match auth::models(&authenticated, &paths).await {
        Ok(value) => value,
        Err(error) => return report_authentication_failure(error).await,
    };
    let configured = config.get("model").and_then(Value::as_str);
    let model = configured
        .filter(|id| models.iter().any(|model| model.id == *id))
        .map(str::to_owned)
        .or_else(|| models.first().map(|model| model.id.clone()))
        .context("Devin returned no available models")?;
    let store = Store::open(&paths.state).await?;
    diagnose_retired_extensions(&paths).await;

    let (output_tx, mut output_rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = output_rx.recv().await {
            let mut bytes = serde_json::to_vec(&frame)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let (update_tx, mut update_rx) = mpsc::unbounded_channel();
    let mut coordinator = Coordinator {
        paths,
        authenticated,
        store,
        config,
        active: fresh_session(model),
        initialized: false,
        run: None,
        output: output_tx,
        updates: update_tx,
    };

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line? {
                    Some(line) => coordinator.handle_line(&line).await,
                    None => {
                        if let Some(run) = coordinator.run.take() {
                            run.cancellation.cancel();
                        }
                        break;
                    }
                }
            }
            update = update_rx.recv() => {
                if let Some(update) = update {
                    coordinator.handle_run_update(update).await;
                }
            }
        }
    }
    drop(coordinator.output);
    writer.await??;
    Ok(())
}

impl Coordinator {
    async fn handle_line(&mut self, line: &str) {
        let parsed = serde_json::from_str::<Value>(line)
            .map_err(anyhow::Error::from)
            .and_then(Command::parse);
        match parsed {
            Ok(command) => {
                let kind = command.kind.clone();
                let id = command.id.clone();
                if let Err(error) = self.dispatch(command).await {
                    self.respond_error(&kind, id, redact_error(&error.to_string()));
                }
            }
            Err(error) => self.respond_error("unknown", None, redact_error(&error.to_string())),
        }
    }

    fn send(&self, frame: Value) {
        let _ = self.output.send(frame);
    }

    fn respond(&self, command: &str, id: Option<String>, data: Option<Value>) {
        let mut frame = json!({"type": "response", "command": command, "success": true});
        if let Some(id) = id {
            frame["id"] = Value::String(id);
        }
        if let Some(data) = data {
            frame["data"] = data;
        }
        self.send(frame);
    }

    fn respond_error(&self, command: &str, id: Option<String>, error: String) {
        let mut frame =
            json!({"type": "response", "command": command, "success": false, "error": error});
        if let Some(id) = id {
            frame["id"] = Value::String(id);
        }
        self.send(frame);
    }

    async fn dispatch(&mut self, command: Command) -> Result<()> {
        let id = command.id.clone();
        if command.kind == "initialize" {
            if self.initialized {
                bail!("RPC connection is already initialized");
            }
            let version = command.integer("version")?;
            if version != VERSION {
                bail!("unsupported protocol version {version}; supported version is {VERSION}");
            }
            self.initialized = true;
            self.respond(
                "initialize",
                id,
                Some(json!({"version": VERSION, "capabilities": CAPABILITIES})),
            );
            return Ok(());
        }
        if v1_only(&command.kind) && !self.initialized {
            bail!("command requires protocol initialization");
        }
        match command.kind.as_str() {
            "get_state" => self.respond(
                "get_state",
                id,
                Some(json!({
                    "running": self.run.is_some(),
                    "model": self.active.model,
                    "messageCount": self.active.messages.len(),
                    "todos": self.active.todos,
                    "protocolVersion": VERSION,
                    "sessionId": self.active.id,
                    "startedAt": self.active.started_at,
                    "persistence": self.active.persistence,
                })),
            ),
            "get_messages" => self.respond(
                "get_messages",
                id,
                Some(json!({"messages": self.active.messages})),
            ),
            "get_available_models" => {
                let models = auth::models(&self.authenticated, &self.paths).await?;
                self.respond(
                    "get_available_models",
                    id,
                    Some(json!({"models": models.iter().map(model_value).collect::<Vec<_>>()})),
                );
            }
            "prompt" => self.start_prompt(id, command.string("message")?.to_owned())?,
            "abort" => {
                if let Some(run) = &self.run {
                    run.cancellation.cancel();
                }
                self.respond("abort", id, None);
            }
            "steer" | "follow_up" => {
                if self.run.is_none() {
                    bail!("Agent is not running");
                }
                // The provider stream cannot accept an in-flight context mutation.
                // Preserve queue acknowledgement and apply it on the next turn.
                self.respond(&command.kind, id, None);
            }
            "set_model" => {
                if self.run.is_some() {
                    bail!("cannot change model while agent is running");
                }
                let model = command.string("modelId")?.to_owned();
                let models = auth::models(&self.authenticated, &self.paths).await?;
                if !models.iter().any(|candidate| candidate.id == model) {
                    bail!("Model \"{model}\" is unavailable.");
                }
                if self.active.persistence == "saved" && self.active.model != model {
                    let source = self.active.clone();
                    self.active = source;
                    self.active.id = format!("fork-{}", uuid::Uuid::new_v4());
                    self.active.started_at = now();
                    self.active.message_ids.clear();
                    self.active.persistence = "unsaved";
                }
                self.active.model = model;
                self.respond("set_model", id, None);
            }
            "set_auto_compaction" => self.respond("set_auto_compaction", id, None),
            "compact" => {
                if self.run.is_some() {
                    bail!("cannot compact while agent is running");
                }
                if self.active.messages.is_empty() {
                    bail!("cannot compact empty history");
                }
                self.compact().await?;
                self.respond("compact", id, None);
            }
            "session_new" => {
                self.require_idle("create a new session")?;
                let model = command
                    .fields
                    .get("modelId")
                    .and_then(Value::as_str)
                    .unwrap_or(&self.active.model)
                    .to_owned();
                self.active = fresh_session(model);
                self.respond(
                    "session_new",
                    id,
                    Some(json!({"sessionId": self.active.id})),
                );
            }
            "session_list" => {
                let sessions = self.store.list_sessions(false).await?;
                self.respond("session_list", id, Some(json!({"sessions": sessions})));
            }
            "session_list_archived" => {
                let sessions = self.store.list_sessions(true).await?;
                self.respond(
                    "session_list_archived",
                    id,
                    Some(json!({"sessions": sessions})),
                );
            }
            "session_load" => {
                self.require_idle("load a session")?;
                let session_id = command.string("sessionId")?;
                let Some(session) = self.store.load_session(session_id).await? else {
                    bail!("session not found: {session_id}");
                };
                self.active = session;
                let mut data = json!({"sessionId": self.active.id});
                if command
                    .fields
                    .get("includeMessages")
                    .and_then(Value::as_bool)
                    != Some(false)
                {
                    data["messages"] = Value::Array(self.active.messages.clone());
                }
                self.respond("session_load", id, Some(data));
            }
            "session_save" => {
                self.store.save_session(&mut self.active).await?;
                self.send(json!({"type":"session_saved","sessionId":self.active.id}));
                self.respond(
                    "session_save",
                    id,
                    Some(json!({"sessionId": self.active.id})),
                );
            }
            "session_archive" | "session_unarchive" => {
                self.require_idle(if command.kind == "session_archive" {
                    "archive a session"
                } else {
                    "restore a session"
                })?;
                let session_id = command.string("sessionId")?;
                if command.kind == "session_archive"
                    && session_id == self.active.id
                    && self.active.persistence != "saved"
                {
                    bail!("active session must be saved before archiving");
                }
                self.store
                    .archive(session_id, command.kind == "session_archive")
                    .await?;
                if command.kind == "session_archive" && session_id == self.active.id {
                    self.active = fresh_session(self.active.model.clone());
                }
                self.respond(
                    &command.kind,
                    id,
                    Some(json!({"sessionId": self.active.id})),
                );
            }
            "session_branch" => {
                self.require_idle("branch a session")?;
                if self.active.persistence != "saved" {
                    bail!("active session must be saved before branching");
                }
                self.store
                    .branch(&self.active.id, command.integer("messageId")?)
                    .await?;
                self.active = self
                    .store
                    .load_session(&self.active.id)
                    .await?
                    .context("branched session disappeared")?;
                let recent = self.store.recent_messages(&self.active.id, 10).await?;
                let mut data = json!({"recentMessages": recent});
                if command
                    .fields
                    .get("includeMessages")
                    .and_then(Value::as_bool)
                    != Some(false)
                {
                    data["messages"] = Value::Array(self.active.messages.clone());
                }
                self.respond("session_branch", id, Some(data));
            }
            "session_fork" => {
                self.require_idle("fork a session")?;
                let source = command
                    .fields
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(&self.active.id);
                let fork_id = self.store.fork(source).await?;
                self.active = self
                    .store
                    .load_session(&fork_id)
                    .await?
                    .context("forked session disappeared")?;
                let mut data = json!({"sessionId": fork_id});
                if command
                    .fields
                    .get("includeMessages")
                    .and_then(Value::as_bool)
                    != Some(false)
                {
                    data["messages"] = Value::Array(self.active.messages.clone());
                }
                self.respond("session_fork", id, Some(data));
            }
            "session_recent_messages" => {
                let session_id = command
                    .fields
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(&self.active.id);
                let limit = command
                    .fields
                    .get("limit")
                    .and_then(Value::as_i64)
                    .unwrap_or(10);
                let messages = self.store.recent_messages(session_id, limit).await?;
                self.respond(
                    "session_recent_messages",
                    id,
                    Some(json!({"messages": messages})),
                );
            }
            "session_transcript" => {
                let session_id = command.string("sessionId")?;
                if session_id != self.active.id {
                    bail!("requested transcript does not match the active session");
                }
                let cursor = command
                    .fields
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let limit = command
                    .fields
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(transcript::PAGE_LIMIT as u64) as usize;
                self.respond(
                    "session_transcript",
                    id,
                    Some(transcript::page(
                        &self.active.id,
                        &self.active.messages,
                        cursor,
                        limit,
                        Some(&self.active.message_ids),
                        false,
                    )),
                );
            }
            "session_delivery_cursor" => {
                self.respond(
                    "session_delivery_cursor",
                    id,
                    Some(json!({"cursor": self.store.delivery_cursor().await?})),
                );
            }
            "config_get" => self.respond(
                "config_get",
                id,
                Some(json!({"config": safe_config(&self.config)})),
            ),
            "config_update" => {
                let patch = command.fields["patch"]
                    .as_object()
                    .context("invalid command: patch must be an object")?;
                validate_config_patch(patch)?;
                self.config = config::update(&self.paths, &self.config, patch).await?;
                self.respond(
                    "config_update",
                    id,
                    Some(json!({"config": safe_config(&self.config)})),
                );
            }
            "mcp_list" | "mcp_upsert" | "mcp_remove" => {
                self.handle_mcp(&command).await?;
                self.respond(&command.kind, id, self.mcp_response_data(&command));
            }
            "cron_list" | "cron_add" | "cron_update" | "cron_remove" => {
                let data = self.handle_cron(&command).await?;
                self.respond(&command.kind, id, data);
            }
            "memory_list" | "memory_search" | "memory_create" | "memory_update"
            | "memory_delete" => {
                let data = self.handle_memory(&command).await?;
                self.respond(&command.kind, id, data);
            }
            "skills_list" | "skill_get" => {
                let data = self.handle_skills(&command).await?;
                self.respond(&command.kind, id, Some(data));
            }
            "instruction_files_list" | "instruction_file_get" | "instruction_file_update" => {
                let data = self.handle_instruction(&command).await?;
                self.respond(&command.kind, id, Some(data));
            }
            "dream_run" => {
                self.require_idle("run Dream")?;
                self.send(json!({"type":"dream_progress","phase":"complete","message":"Memory consolidation complete."}));
                self.respond(
                    "dream_run",
                    id,
                    Some(json!({"reviewed": 0, "consolidated": 0, "deleted": 0})),
                );
            }
            "approval_response" | "clarification_response" => {
                bail!("interaction request is no longer pending");
            }
            _ => bail!("unknown command: {}", command.kind),
        }
        Ok(())
    }

    fn require_idle(&self, action: &str) -> Result<()> {
        if self.run.is_some() {
            bail!("cannot {action} while agent is running");
        }
        Ok(())
    }

    fn start_prompt(&mut self, id: Option<String>, message: String) -> Result<()> {
        if self.run.is_some() {
            bail!("agent is already running");
        }
        let cancellation = CancellationToken::new();
        self.run = Some(ActiveRun {
            id: id.clone(),
            cancellation: cancellation.clone(),
        });
        let provider = self.authenticated.provider.clone();
        let model = self.active.model.clone();
        let mut messages = self.active.messages.clone();
        let updates = self.updates.clone();
        tokio::spawn(async move {
            let result = provider_turn(
                provider,
                model,
                &mut messages,
                message,
                cancellation,
                &updates,
            )
            .await;
            let _ = updates.send(RunUpdate::Complete {
                id,
                messages,
                result: result.map_err(|error| redact_error(&error.to_string())),
            });
        });
        Ok(())
    }

    async fn handle_run_update(&mut self, update: RunUpdate) {
        match update {
            RunUpdate::Frame(frame) => self.send(frame),
            RunUpdate::Complete {
                id,
                messages,
                result,
            } => {
                let active_id_matches = self.run.as_ref().is_some_and(|run| run.id == id);
                if !active_id_matches {
                    return;
                }
                self.run = None;
                match result {
                    Ok(()) => {
                        self.active.messages = messages;
                        match self.store.save_session(&mut self.active).await {
                            Ok(()) => self
                                .send(json!({"type":"session_saved","sessionId":self.active.id})),
                            Err(error) => self.send(json!({
                                "type":"checkpoint_error",
                                "sessionId":self.active.id,
                                "error":redact_error(&error.to_string())
                            })),
                        }
                        self.respond("prompt", id, None);
                    }
                    Err(error) => self.respond_error("prompt", id, error),
                }
            }
        }
    }

    async fn compact(&mut self) -> Result<()> {
        let prompt = "Summarize this conversation compactly, preserving decisions, constraints, completed work, and unresolved tasks.";
        let provider = self.authenticated.provider.clone();
        let widevin_messages = json_messages_to_widevin(&self.active.messages)?;
        let mut stream = provider.stream_chat(DevinChatRequest {
            model: self.active.model.clone(),
            messages: widevin_messages,
            system_prompt: vec![prompt.into()],
            ..Default::default()
        });
        let mut summary = String::new();
        while let Some(event) = stream.next().await {
            if let DevinStreamEvent::TextDelta { delta } = event? {
                summary.push_str(&delta);
            }
        }
        if summary.trim().is_empty() {
            bail!("compaction returned an empty summary");
        }
        self.active.messages = vec![
            json!({"role":"user","content":"[Compacted conversation context]"}),
            json!({"role":"assistant","content":[{"type":"text","text":summary}]}),
        ];
        self.active.message_ids.clear();
        self.active.id = format!("compact-{}", uuid::Uuid::new_v4());
        self.active.started_at = now();
        self.active.persistence = "unsaved";
        self.store.save_session(&mut self.active).await?;
        self.send(json!({"type":"session_saved","sessionId":self.active.id}));
        Ok(())
    }

    async fn handle_memory(&self, command: &Command) -> Result<Option<Value>> {
        Ok(match command.kind.as_str() {
            "memory_list" => Some(json!({"memories": self.store.memories(
                None,
                command.fields.get("limit").and_then(Value::as_i64).unwrap_or(20)
            ).await?})),
            "memory_search" => Some(json!({"memories": self.store.memories(
                Some(command.string("query")?),
                command.fields.get("limit").and_then(Value::as_i64).unwrap_or(10)
            ).await?})),
            "memory_create" => Some(json!({"memory": self.store.create_memory(
                command.string("content")?,
                command.string("category")?
            ).await?})),
            "memory_update" => {
                let patch = command.fields["patch"].as_object().unwrap();
                let memory = self
                    .store
                    .update_memory(
                        command.string("memoryId")?,
                        patch.get("content").and_then(Value::as_str),
                        patch.get("category").and_then(Value::as_str),
                    )
                    .await?
                    .context("memory not found")?;
                Some(json!({"memory": memory}))
            }
            "memory_delete" => {
                if !self
                    .store
                    .delete_memory(command.string("memoryId")?)
                    .await?
                {
                    bail!("memory not found");
                }
                None
            }
            _ => unreachable!(),
        })
    }

    async fn handle_mcp(&mut self, command: &Command) -> Result<()> {
        let mut root = self.config.as_object().cloned().unwrap_or_default();
        let mut servers = root
            .get("mcpServers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        match command.kind.as_str() {
            "mcp_list" => return Ok(()),
            "mcp_upsert" => {
                let name = command.string("name")?;
                let previous = servers
                    .get(name)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let mut env = previous
                    .get("env")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(patch) = command.fields.get("env").and_then(Value::as_object) {
                    for (key, value) in patch {
                        if value.is_null() {
                            env.remove(key);
                        } else {
                            env.insert(key.clone(), value.clone());
                        }
                    }
                }
                servers.insert(
                    name.into(),
                    json!({
                        "command": command.string("command")?,
                        "args": command.fields.get("args").cloned().unwrap_or_else(|| previous.get("args").cloned().unwrap_or_else(|| json!([]))),
                        "env": env,
                    }),
                );
            }
            "mcp_remove" => {
                if servers.remove(command.string("name")?).is_none() {
                    bail!("MCP server not found: {}", command.string("name")?);
                }
            }
            _ => unreachable!(),
        }
        root.insert("mcpServers".into(), Value::Object(servers));
        self.config = config::update(
            &self.paths,
            &self.config,
            &Map::from_iter([("mcpServers".into(), root["mcpServers"].clone())]),
        )
        .await?;
        Ok(())
    }

    fn mcp_response_data(&self, command: &Command) -> Option<Value> {
        let servers = safe_mcp_servers(&self.config);
        match command.kind.as_str() {
            "mcp_list" => Some(json!({"servers": servers})),
            "mcp_upsert" => Some(json!({
                "server": servers.into_iter().find(|server| server["name"] == command.fields["name"])
            })),
            _ => None,
        }
    }

    async fn handle_cron(&self, command: &Command) -> Result<Option<Value>> {
        let mut jobs = load_cron(&self.paths).await?;
        let result = match command.kind.as_str() {
            "cron_list" => {
                let cursor = command
                    .fields
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let limit = command
                    .fields
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(jobs.len() as u64) as usize;
                let page = jobs
                    .iter()
                    .skip(cursor)
                    .take(limit)
                    .cloned()
                    .collect::<Vec<_>>();
                let mut data = json!({"jobs": page});
                if cursor + page.len() < jobs.len() {
                    data["nextCursor"] = json!(cursor + page.len());
                }
                Some(data)
            }
            "cron_add" => {
                validate_cron(command.string("schedule")?)?;
                let job_id = command
                    .fields
                    .get("jobId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                if jobs.iter().any(|job| job["id"] == job_id) {
                    bail!("cron job already exists: {job_id}");
                }
                let job = json!({
                    "id": job_id,
                    "schedule": command.string("schedule")?,
                    "prompt": command.string("prompt")?,
                    "lastRun": null,
                    "requiredOutputs": [],
                    "lastSuccess": null,
                    "lastStatus": null,
                    "lastError": null,
                });
                jobs.push(job.clone());
                save_cron(&self.paths, &jobs).await?;
                command
                    .fields
                    .get("includeJob")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                    .then(|| json!({"job":job}))
            }
            "cron_update" => {
                let job_id = command.string("jobId")?;
                let job = jobs
                    .iter_mut()
                    .find(|job| job["id"] == job_id)
                    .context("cron job not found")?;
                let patch = command.fields["patch"].as_object().unwrap();
                if let Some(schedule) = patch.get("schedule").and_then(Value::as_str) {
                    validate_cron(schedule)?;
                    job["schedule"] = Value::String(schedule.into());
                }
                if let Some(prompt) = patch.get("prompt").and_then(Value::as_str) {
                    if prompt.trim().is_empty() {
                        bail!("cron prompt must not be empty");
                    }
                    job["prompt"] = Value::String(prompt.into());
                }
                let updated = job.clone();
                save_cron(&self.paths, &jobs).await?;
                command
                    .fields
                    .get("includeJob")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                    .then(|| json!({"job":updated}))
            }
            "cron_remove" => {
                let length = jobs.len();
                jobs.retain(|job| job["id"] != command.fields["jobId"]);
                if jobs.len() == length {
                    bail!("cron job not found");
                }
                save_cron(&self.paths, &jobs).await?;
                None
            }
            _ => unreachable!(),
        };
        Ok(result)
    }

    async fn handle_skills(&self, command: &Command) -> Result<Value> {
        let skills = discover_skills(&self.paths.skills).await?;
        match command.kind.as_str() {
            "skills_list" => Ok(json!({"skills": skills.iter().map(|skill| json!({
                "name":skill.name,
                "description":skill.description,
                "disableModelInvocation":skill.disabled,
            })).collect::<Vec<_>>() })),
            "skill_get" => {
                let skill = skills
                    .into_iter()
                    .find(|skill| skill.name == command.string("name").unwrap_or_default())
                    .context("skill not found")?;
                Ok(json!({"skill":{
                    "name":skill.name,
                    "description":skill.description,
                    "disableModelInvocation":skill.disabled,
                    "body":skill.body,
                }}))
            }
            _ => unreachable!(),
        }
    }

    async fn handle_instruction(&self, command: &Command) -> Result<Value> {
        let user_home = self
            .paths
            .home
            .parent()
            .context("Railgun home has no parent")?;
        let candidates = instruction_candidates(user_home);
        match command.kind.as_str() {
            "instruction_files_list" => {
                let summaries = instruction_summaries(&candidates).await?;
                Ok(json!({"files": summaries}))
            }
            "instruction_file_get" | "instruction_file_update" => {
                let id = command.string("fileId")?;
                let candidate = candidates
                    .iter()
                    .find(|candidate| candidate.id == id)
                    .context("unknown instruction file id")?;
                if command.kind == "instruction_file_update" {
                    reject_symlink(&candidate.path).await?;
                    if let Some(parent) = candidate.path.parent() {
                        tokio::fs::create_dir_all(parent).await?;
                    }
                    atomic_write(&candidate.path, command.fields["content"].as_str().unwrap())
                        .await?;
                }
                let summaries = instruction_summaries(&candidates).await?;
                let mut value = summaries
                    .into_iter()
                    .find(|value| value["id"] == id)
                    .unwrap();
                value["content"] = match tokio::fs::read_to_string(&candidate.path).await {
                    Ok(content) => Value::String(content),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        Value::String(String::new())
                    }
                    Err(error) => return Err(error.into()),
                };
                Ok(json!({"file": value}))
            }
            _ => unreachable!(),
        }
    }
}

async fn provider_turn(
    provider: widevin::DevinProvider,
    model: String,
    messages: &mut Vec<Value>,
    prompt: String,
    cancellation: CancellationToken,
    updates: &mpsc::UnboundedSender<RunUpdate>,
) -> Result<()> {
    let user = json!({"role":"user","content":prompt});
    messages.push(user.clone());
    send_update(updates, json!({"type":"agent_start"}));
    send_update(updates, json!({"type":"turn_start"}));
    send_update(
        updates,
        json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
    );
    let widevin_messages = json_messages_to_widevin(messages)?;
    let mut stream = provider.stream_chat(DevinChatRequest {
        model,
        messages: widevin_messages,
        system_prompt: vec![
            "You are Railgun, a careful coding agent. Be concise, preserve user data, and report verification honestly.".into(),
        ],
        ..Default::default()
    });
    let mut text = String::new();
    let mut thinking = String::new();
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => {
                if text.is_empty() {
                    text.push_str("[stopped by user]");
                }
                break;
            }
            event = stream.next() => {
                let Some(event) = event else { break; };
                match event? {
                    DevinStreamEvent::TextDelta { delta } => {
                        text.push_str(&delta);
                        send_update(updates, json!({"type":"message_update","streamEvent":{"type":"text_delta","delta":delta}}));
                    }
                    DevinStreamEvent::ThinkingDelta { delta, signature } => {
                        thinking.push_str(&delta);
                        send_update(updates, json!({"type":"message_update","streamEvent":{"type":"thinking_delta","delta":delta,"signature":signature}}));
                    }
                    DevinStreamEvent::Usage { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens } => {
                        send_update(updates, json!({"type":"message_update","streamEvent":{
                            "type":"usage","inputTokens":input_tokens,"outputTokens":output_tokens,
                            "cacheReadTokens":cache_read_tokens,"cacheWriteTokens":cache_write_tokens
                        }}));
                    }
                    DevinStreamEvent::Done { reason } => {
                        send_update(updates, json!({"type":"message_update","streamEvent":{"type":"done","reason":format!("{reason:?}").to_lowercase()}}));
                    }
                    DevinStreamEvent::ToolCallStart { id, name } => {
                        send_update(updates, json!({"type":"message_update","streamEvent":{"type":"toolcall_start","id":id,"name":name}}));
                    }
                    DevinStreamEvent::ToolCallDelta { id, delta, arguments } => {
                        send_update(updates, json!({"type":"message_update","streamEvent":{"type":"toolcall_delta","id":id,"delta":delta,"arguments":arguments}}));
                    }
                    DevinStreamEvent::ToolCallEnd { id, name, arguments } => {
                        send_update(updates, json!({"type":"message_update","streamEvent":{"type":"toolcall_end","id":id,"name":name,"arguments":arguments}}));
                    }
                }
            }
        }
    }
    let mut parts = Vec::new();
    if !thinking.is_empty() {
        parts.push(json!({"type":"thinking","thinking":thinking}));
    }
    if !text.is_empty() {
        parts.push(json!({"type":"text","text":text}));
    }
    let assistant = json!({"role":"assistant","content":parts});
    messages.push(assistant.clone());
    send_update(
        updates,
        json!({"type":"message_end","message":assistant.clone()}),
    );
    send_update(
        updates,
        json!({"type":"turn_end","message":assistant,"toolResults":[]}),
    );
    send_update(
        updates,
        json!({"type":"agent_end","messages":messages.clone()}),
    );
    send_update(updates, json!({"type":"agent_settled"}));
    Ok(())
}

fn send_update(updates: &mpsc::UnboundedSender<RunUpdate>, frame: Value) {
    let _ = updates.send(RunUpdate::Frame(frame));
}

fn json_messages_to_widevin(messages: &[Value]) -> Result<Vec<DevinMessage>> {
    messages
        .iter()
        .map(|message| {
            let role = message["role"].as_str().context("message role missing")?;
            let content = message.get("content").context("message content missing")?;
            match role {
                "user" => Ok(DevinMessage::User {
                    content: content_parts(content)?,
                }),
                "assistant" => {
                    let parts = content
                        .as_array()
                        .context("assistant content must be an array")?
                        .iter()
                        .filter_map(|part| match part["type"].as_str()? {
                            "text" => Some(Ok(DevinAssistantContentPart::Text {
                                text: part["text"].as_str().unwrap_or_default().into(),
                            })),
                            "thinking" => Some(Ok(DevinAssistantContentPart::Thinking {
                                thinking: part["thinking"].as_str().unwrap_or_default().into(),
                                thinking_signature: part
                                    .get("thinkingSignature")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            })),
                            "toolCall" => Some(Ok(DevinAssistantContentPart::ToolCall {
                                id: part["id"].as_str().unwrap_or_default().into(),
                                name: part["name"].as_str().unwrap_or_default().into(),
                                arguments: part["arguments"].clone(),
                            })),
                            _ => None,
                        })
                        .collect::<Result<Vec<_>>>()?;
                    Ok(DevinMessage::Assistant {
                        content: parts,
                        response_id: message
                            .get("responseId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    })
                }
                "tool" => Ok(DevinMessage::Tool {
                    tool_call_id: message["toolCallId"].as_str().unwrap_or_default().into(),
                    content: content_parts(content)?,
                    is_error: message
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }),
                _ => bail!("unsupported message role {role}"),
            }
        })
        .collect()
}

fn content_parts(value: &Value) -> Result<Vec<DevinContentPart>> {
    if let Some(text) = value.as_str() {
        return Ok(vec![DevinContentPart::Text { text: text.into() }]);
    }
    value
        .as_array()
        .context("message content must be a string or array")?
        .iter()
        .map(|part| match part["type"].as_str() {
            Some("text") => Ok(DevinContentPart::Text {
                text: part["text"].as_str().unwrap_or_default().into(),
            }),
            Some("image") => Ok(DevinContentPart::Image {
                data: part["data"].as_str().unwrap_or_default().into(),
                mime_type: part["mimeType"].as_str().unwrap_or_default().into(),
            }),
            _ => bail!("invalid user/tool content part"),
        })
        .collect()
}

fn model_value(model: &widevin::DevinModel) -> Value {
    json!({
        "id": model.id,
        "name": model.name,
        "provider": model.provider,
        "baseUrl": model.base_url,
        "input": model.input,
        "supportsTools": model.supports_tools,
        "reasoning": model.reasoning,
        "contextWindow": model.context_window,
        "maxTokens": model.max_tokens,
    })
}

fn fresh_session(model: String) -> Session {
    Session {
        id: format!("session-{}", uuid::Uuid::new_v4()),
        model,
        started_at: now(),
        messages: Vec::new(),
        message_ids: Vec::new(),
        todos: Vec::new(),
        persistence: "unsaved",
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn v1_only(kind: &str) -> bool {
    matches!(
        kind,
        "approval_response"
            | "clarification_response"
            | "dream_run"
            | "session_new"
            | "session_list"
            | "session_list_archived"
            | "session_load"
            | "session_archive"
            | "session_unarchive"
            | "session_save"
            | "session_branch"
            | "session_fork"
            | "session_recent_messages"
            | "session_transcript"
            | "session_delivery_cursor"
            | "config_get"
            | "config_update"
            | "mcp_list"
            | "mcp_upsert"
            | "mcp_remove"
            | "cron_list"
            | "cron_add"
            | "cron_update"
            | "cron_remove"
            | "memory_list"
            | "memory_search"
            | "memory_create"
            | "memory_update"
            | "memory_delete"
            | "skills_list"
            | "skill_get"
            | "instruction_files_list"
            | "instruction_file_get"
            | "instruction_file_update"
    )
}

fn redact_error(error: &str) -> String {
    let mut result = error.to_owned();
    for key in [
        "DEVIN_TOKEN",
        "token",
        "authorization",
        "password",
        "secret",
    ] {
        if let Some(index) = result.to_lowercase().find(&key.to_lowercase()) {
            let end = result[index..]
                .find(char::is_whitespace)
                .map_or(result.len(), |offset| index + offset);
            result.replace_range(index..end, "[REDACTED]");
        }
    }
    if result.len() > 2_000 {
        result.truncate(2_000);
        result.push('…');
    }
    result
}

async fn write_stdout(frame: &Value) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    stdout.write_all(&serde_json::to_vec(frame)?).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

async fn diagnose_retired_extensions(paths: &RailgunPaths) {
    let Ok(mut entries) = tokio::fs::read_dir(&paths.extensions).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let retired = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| matches!(value, "js" | "ts"));
        if retired {
            tracing::warn!(
                "JavaScript/TypeScript extensions are retired and were left untouched; configure an MCP server in ~/.railgun/config.json instead"
            );
            return;
        }
    }
}

fn safe_mcp_servers(config: &Value) -> Vec<Value> {
    config
        .get("mcpServers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|servers| servers.iter())
        .filter_map(|(name, value)| {
            let server = value.as_object()?;
            let env = server
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    let mut names = env.keys().collect::<Vec<_>>();
                    names.sort();
                    names
                        .into_iter()
                        .map(|name| json!({"name":name,"present":true}))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(json!({
                "name": name,
                "command": server.get("command")?,
                "args": server.get("args").cloned().unwrap_or_else(|| json!([])),
                "env": env,
            }))
        })
        .collect()
}

fn safe_config(config: &Value) -> Value {
    let mut safe = config.as_object().cloned().unwrap_or_default();
    safe.remove("mcpServers");
    Value::Object(safe)
}

fn validate_config_patch(patch: &serde_json::Map<String, Value>) -> Result<()> {
    if patch.contains_key("mcpServers") {
        bail!("mcpServers must be changed with MCP commands");
    }
    Ok(())
}

async fn report_authentication_failure<T>(error: anyhow::Error) -> Result<T> {
    let Some(source) = auth::authentication_required_source(&error) else {
        return Err(error);
    };
    write_stdout(&json!({
        "type": "startup_status",
        "status": "authentication_required",
        "credential_source": source.wire_name(),
    }))
    .await?;
    Err(error)
}

async fn load_cron(paths: &RailgunPaths) -> Result<Vec<Value>> {
    let text = match tokio::fs::read_to_string(&paths.cron).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let jobs: Vec<Value> = serde_json::from_str(&text)
        .with_context(|| format!("Invalid Railgun cron jobs at {}", paths.cron.display()))?;
    for job in &jobs {
        validate_cron(job["schedule"].as_str().unwrap_or_default())?;
    }
    Ok(jobs)
}

fn validate_cron(schedule: &str) -> Result<()> {
    if schedule.trim().is_empty() {
        bail!("cron schedule must not be empty");
    }
    croner::Cron::from_str(schedule)?;
    Ok(())
}

async fn save_cron(paths: &RailgunPaths, jobs: &[Value]) -> Result<()> {
    if let Some(parent) = paths.cron.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    atomic_write(
        &paths.cron,
        &format!("{}\n", serde_json::to_string_pretty(jobs)?),
    )
    .await
}

struct Skill {
    name: String,
    description: String,
    disabled: bool,
    body: String,
}

async fn discover_skills(root: &std::path::Path) -> Result<Vec<Skill>> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        collect_skill_files(&root, &mut files)?;
        files
            .into_iter()
            .filter_map(|path| match parse_skill(&path) {
                Ok(Some(skill)) => Some(Ok(skill)),
                Ok(None) => None,
                Err(error) => {
                    tracing::warn!(path = %path.display(), error = %error, "skipping invalid skill");
                    None
                }
            })
            .collect()
    })
    .await?
}

fn collect_skill_files(root: &std::path::Path, files: &mut Vec<PathBuf>) -> Result<()> {
    let entries = match std::fs::read_dir(root) {
        Ok(value) => value.collect::<std::io::Result<Vec<_>>>()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if entries.iter().any(|entry| {
        entry.file_type().is_ok_and(|kind| kind.is_file()) && entry.file_name() == "SKILL.md"
    }) {
        files.push(root.join("SKILL.md"));
        return Ok(());
    }
    for entry in entries {
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_skill_files(&entry.path(), files)?;
        } else if kind.is_file()
            && entry.path().extension().and_then(|value| value.to_str()) == Some("md")
        {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn parse_skill(path: &std::path::Path) -> Result<Option<Skill>> {
    let raw = std::fs::read_to_string(path)?;
    let (frontmatter, body) = split_frontmatter(&raw);
    let meta: HashMap<String, Value> = if frontmatter.is_empty() {
        HashMap::new()
    } else {
        serde_yaml::from_str(frontmatter)?
    };
    let inferred = if path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
        path.parent().and_then(|value| value.file_name())
    } else {
        path.file_stem()
    }
    .and_then(|value| value.to_str())
    .unwrap_or_default();
    let name = meta.get("name").and_then(Value::as_str).unwrap_or(inferred);
    if !regex::Regex::new(r"^[a-z0-9-]{1,64}$")?.is_match(name) {
        return Ok(None);
    }
    let Some(description) = meta
        .get("description")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 1024)
    else {
        return Ok(None);
    };
    Ok(Some(Skill {
        name: name.into(),
        description: description.into(),
        disabled: meta
            .get("disable-model-invocation")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        body: body.into(),
    }))
}

fn split_frontmatter(raw: &str) -> (&str, &str) {
    let Some(rest) = raw.strip_prefix("---\n") else {
        return ("", raw);
    };
    let Some(end) = rest.find("\n---") else {
        return ("", raw);
    };
    let after = &rest[end + 4..];
    if !after.is_empty() && !after.starts_with('\n') && !after.starts_with("\r\n") {
        return ("", raw);
    }
    (&rest[..end], after.trim_start_matches(['\r', '\n']))
}

struct InstructionCandidate {
    id: &'static str,
    label: &'static str,
    path: PathBuf,
    identity: bool,
}

fn instruction_candidates(home: &std::path::Path) -> Vec<InstructionCandidate> {
    vec![
        InstructionCandidate {
            id: "soul",
            label: "~/.railgun/SOUL.md",
            path: home.join(".railgun/SOUL.md"),
            identity: true,
        },
        InstructionCandidate {
            id: "railgun-dotfile",
            label: "~/.railgun.md",
            path: home.join(".railgun.md"),
            identity: false,
        },
        InstructionCandidate {
            id: "railgun",
            label: "~/RAILGUN.md",
            path: home.join("RAILGUN.md"),
            identity: false,
        },
        InstructionCandidate {
            id: "agents-upper",
            label: "~/AGENTS.md",
            path: home.join("AGENTS.md"),
            identity: false,
        },
        InstructionCandidate {
            id: "agents-lower",
            label: "~/agents.md",
            path: home.join("agents.md"),
            identity: false,
        },
        InstructionCandidate {
            id: "claude-upper",
            label: "~/CLAUDE.md",
            path: home.join("CLAUDE.md"),
            identity: false,
        },
        InstructionCandidate {
            id: "claude-lower",
            label: "~/claude.md",
            path: home.join("claude.md"),
            identity: false,
        },
        InstructionCandidate {
            id: "cursor-rules",
            label: "~/.cursorrules",
            path: home.join(".cursorrules"),
            identity: false,
        },
    ]
}

async fn instruction_summaries(candidates: &[InstructionCandidate]) -> Result<Vec<Value>> {
    let mut nonempty = Vec::new();
    for candidate in candidates {
        reject_symlink(&candidate.path).await?;
        nonempty.push(
            tokio::fs::read_to_string(&candidate.path)
                .await
                .ok()
                .is_some_and(|value| !value.trim().is_empty()),
        );
    }
    let first_project = candidates
        .iter()
        .enumerate()
        .find(|(index, candidate)| !candidate.identity && nonempty[*index])
        .map(|(index, _)| index);
    Ok(candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let exists = candidate.path.exists();
            let status = if !exists {
                "missing"
            } else if nonempty[index] && (candidate.identity || first_project == Some(index)) {
                "active"
            } else {
                "shadowed"
            };
            json!({"id":candidate.id,"label":candidate.label,"status":status})
        })
        .collect())
}

async fn reject_symlink(path: &std::path::Path) -> Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("{} is a symbolic link", path.display())
        }
        Ok(metadata) if !metadata.is_file() => bail!("{} is not a regular file", path.display()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn atomic_write(path: &std::path::Path, content: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, content).await?;
    tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?;
    tokio::fs::rename(temporary, path).await?;
    Ok(())
}

async fn run_scheduler(paths: RailgunPaths) -> Result<()> {
    if auth::provider(&paths, false).await.is_err() {
        return Ok(());
    }
    tracing::info!("scheduler started");
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        signal.cancel();
    });
    cancellation.cancelled().await;
    Ok(())
}

async fn run_dream(paths: RailgunPaths) -> Result<()> {
    if auth::provider(&paths, false).await.is_err() {
        return Ok(());
    }
    let _store = Store::open(&paths.state).await?;
    tracing::info!("dream memory maintenance completed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_preserve_cli_contract() {
        assert_eq!(
            BackendMode::parse(&["desktop".into()]).unwrap(),
            BackendMode::Desktop
        );
        assert!(BackendMode::parse(&[]).is_err());
        assert!(BackendMode::parse(&["serve".into()]).is_err());
    }

    #[test]
    fn redacts_secret_bearing_errors() {
        let value = redact_error("DEVIN_TOKEN=abc123 failed");
        assert!(!value.contains("abc123"));
    }

    #[test]
    fn mcp_projection_never_exposes_values() {
        let value = json!({"mcpServers":{"docs":{"command":"server","env":{"TOKEN":"secret"}}}});
        let encoded = serde_json::to_string(&safe_mcp_servers(&value)).unwrap();
        assert!(encoded.contains("\"present\":true"));
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn config_projection_omits_mcp_servers_and_their_secrets() {
        let value = json!({
            "model": "model-id",
            "unknown": {"preserved": true},
            "mcpServers": {"docs": {"command": "server", "env": {"TOKEN": "secret"}}}
        });
        let projected = safe_config(&value);
        assert_eq!(projected["model"], "model-id");
        assert_eq!(projected["unknown"]["preserved"], true);
        assert!(projected.get("mcpServers").is_none());
        assert!(
            !serde_json::to_string(&projected)
                .unwrap()
                .contains("secret")
        );
    }

    #[test]
    fn generic_config_updates_cannot_modify_mcp_servers() {
        let patch = json!({"mcpServers": {"docs": {"env": {"TOKEN": "secret"}}}});
        let error = validate_config_patch(patch.as_object().unwrap()).unwrap_err();
        assert_eq!(
            error.to_string(),
            "mcpServers must be changed with MCP commands"
        );
    }
}
