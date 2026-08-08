use crate::{
    auth::{self, Authenticated},
    config,
    paths::RailgunPaths,
    protocol::{CAPABILITIES, Command, VERSION},
    skills::{self, SkillInput},
    storage::{Session, Store},
    tools::{
        self, ApprovalMode, InteractionResponse, Interactions, ToolContext, is_protected_cron_job,
        visible_cron_jobs, with_internal_cron_jobs,
    },
    transcript,
};
use anyhow::{Context, Result, bail};
use chrono::{Timelike, Utc};
use futures_util::StreamExt;
use serde_json::{Map, Value, json};
use std::{path::PathBuf, str::FromStr, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, Semaphore, mpsc},
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
        todos: Vec<Value>,
        result: Result<(), String>,
    },
    CatalogRefresh {
        id: Option<String>,
        result: Result<Vec<widevin::DevinModel>, String>,
    },
}

/// Provider discovery never belongs on an interaction-critical command path.
/// The last good catalog remains authoritative for ordinary reads and model
/// validation while an explicit refresh runs in the background.
struct ModelCatalogCache {
    models: Vec<widevin::DevinModel>,
    refreshed_at: String,
    generation: u64,
    refreshing: bool,
    last_error: Option<String>,
}

impl ModelCatalogCache {
    fn new(models: Vec<widevin::DevinModel>) -> Self {
        Self {
            models,
            refreshed_at: now(),
            generation: 1,
            refreshing: false,
            last_error: None,
        }
    }

    fn response_data(&self) -> Value {
        let mut catalog = json!({
            "freshness": "cached",
            "refreshedAt": self.refreshed_at,
            "generation": self.generation,
            "refreshing": self.refreshing,
        });
        if let Some(error) = &self.last_error {
            catalog["lastError"] = Value::String(error.clone());
        }
        json!({
            "models": self.models.iter().map(model_value).collect::<Vec<_>>(),
            "catalog": catalog,
        })
    }

    fn replace(&mut self, models: Vec<widevin::DevinModel>) {
        self.models = models;
        self.refreshed_at = now();
        self.generation += 1;
        self.refreshing = false;
        self.last_error = None;
    }
}

struct Coordinator {
    paths: RailgunPaths,
    authenticated: Authenticated,
    store: Store,
    config: Value,
    catalog: ModelCatalogCache,
    active: Session,
    initialized: bool,
    run: Option<ActiveRun>,
    output: mpsc::UnboundedSender<Value>,
    updates: mpsc::UnboundedSender<RunUpdate>,
    interactions: Interactions,
    session_approvals: Arc<Mutex<std::collections::HashSet<String>>>,
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
        catalog: ModelCatalogCache::new(models),
        active: fresh_session(model),
        initialized: false,
        run: None,
        output: output_tx,
        updates: update_tx,
        interactions: Interactions::default(),
        session_approvals: Arc::new(Mutex::new(std::collections::HashSet::new())),
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
                        coordinator.interactions.reject_all().await;
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

async fn discover_skills_for_run(
    root: &std::path::Path,
    explicit_invocation: bool,
) -> Result<Vec<skills::Skill>> {
    match skills::discover_async(root).await {
        Ok(discovered) => Ok(discovered),
        Err(error) if explicit_invocation => Err(error).context("unable to load requested skill"),
        Err(error) => {
            tracing::warn!(path = %root.display(), error = %error, "skill discovery unavailable for agent run");
            Ok(Vec::new())
        }
    }
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
            "get_available_models" => self.respond(
                "get_available_models",
                id,
                Some(self.catalog.response_data()),
            ),
            "refresh_model_catalog" => self.refresh_catalog(id),
            "prompt" => {
                self.start_prompt(id, command.string("message")?.to_owned())
                    .await?
            }
            "abort" => {
                if let Some(run) = &self.run {
                    run.cancellation.cancel();
                }
                self.interactions.reject_all().await;
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
                if !self
                    .catalog
                    .models
                    .iter()
                    .any(|candidate| candidate.id == model)
                {
                    bail!("Model \"{model}\" is unavailable.");
                }
                if self.active.persistence == "saved" && self.active.model != model {
                    let source = self.active.clone();
                    self.active = source;
                    self.active.id = format!("fork-{}", uuid::Uuid::new_v4());
                    self.active.started_at = now();
                    self.active.message_ids.clear();
                    self.active.persistence = "unsaved";
                    self.reset_session_approvals().await;
                }
                self.active.model = model;
                self.respond("set_model", id, Some(self.active_snapshot()));
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
                self.reset_session_approvals().await;
                self.respond(
                    "session_new",
                    id,
                    Some(json!({"sessionId": self.active.id, "activeSession": self.active_snapshot()})),
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
                self.reset_session_approvals().await;
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
                    self.reset_session_approvals().await;
                }
                self.respond(
                    &command.kind,
                    id,
                    Some(json!({
                        "sessionId": self.active.id,
                        "archivedSessionId": session_id,
                        "activeSession": self.active_snapshot(),
                    })),
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
                self.reset_session_approvals().await;
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
            "skills_list" | "skill_get" | "skill_create" | "skill_update" | "skill_delete" => {
                let data = self.handle_skills(&command).await?;
                self.respond(&command.kind, id, (!data.is_null()).then_some(data));
            }
            "instruction_files_list" | "instruction_file_get" | "instruction_file_update" => {
                let data = self.handle_instruction(&command).await?;
                self.respond(&command.kind, id, Some(data));
            }
            "dream_run" => {
                self.require_idle("run Dream")?;
                let result = run_dream_job(&self.store, &self.paths, &self.output).await?;
                self.respond("dream_run", id, Some(result));
            }
            "approval_response" => {
                self.interactions
                    .resolve(
                        command.string("requestId")?,
                        InteractionResponse::Approval(command.bool("approved")?),
                    )
                    .await?;
                self.respond("approval_response", id, None);
            }
            "clarification_response" => {
                self.interactions
                    .resolve(
                        command.string("requestId")?,
                        InteractionResponse::Clarification(command.string("answer")?.to_owned()),
                    )
                    .await?;
                self.respond("clarification_response", id, None);
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

    async fn reset_session_approvals(&self) {
        self.session_approvals.lock().await.clear();
    }

    async fn start_prompt(&mut self, id: Option<String>, message: String) -> Result<()> {
        if self.run.is_some() {
            bail!("agent is already running");
        }
        let explicit_invocation = message.starts_with("/skill:");
        let discovered_skills =
            discover_skills_for_run(&self.paths.skills, explicit_invocation).await?;
        let prompt = skills::expand_slash_invocation(&message, &discovered_skills)?
            .unwrap_or_else(|| message.clone());
        let available_skills = skills::available_skills_prompt(&discovered_skills);
        let cancellation = CancellationToken::new();
        self.run = Some(ActiveRun {
            id: id.clone(),
            cancellation: cancellation.clone(),
        });
        let provider = self.authenticated.provider.clone();
        let model = self.active.model.clone();
        let mut messages = self.active.messages.clone();
        let advisor_message = message.clone();
        let available_skills_for_run = available_skills.clone();
        let updates = self.updates.clone();
        let todos = Arc::new(Mutex::new(self.active.todos.clone()));
        let context = ToolContext {
            paths: self.paths.clone(),
            store: self.store.clone(),
            cancellation: cancellation.clone(),
            updates: self.output.clone(),
            todos: todos.clone(),
            interactions: Some(self.interactions.clone()),
            approvals: self.session_approvals.clone(),
            approval_mode: approval_mode_for(&self.config),
            user_intent: Some(message.clone()),
            delegation_depth: 0,
            delegation_slots: Arc::new(Semaphore::new(3)),
            provider: Some(provider.clone()),
            model: Some(model.clone()),
        };
        tokio::spawn(async move {
            let result = provider_turn(
                provider,
                model,
                &mut messages,
                AgentRunPrompt {
                    user: prompt,
                    available_skills: available_skills_for_run,
                },
                context,
                cancellation,
                &updates,
            )
            .await;
            let _ = updates.send(RunUpdate::Complete {
                id,
                messages,
                todos: todos.lock().await.clone(),
                result: result.map_err(|error| redact_error(&error.to_string())),
            });
        });
        if let Some(advisor_model) = self
            .config
            .get("advisor")
            .and_then(Value::as_object)
            .filter(|advisor| advisor.get("enabled").and_then(Value::as_bool) == Some(true))
            .and_then(|advisor| advisor.get("model").and_then(Value::as_str))
        {
            let provider = self.authenticated.provider.clone();
            let updates = self.updates.clone();
            let advisor_model = advisor_model.to_owned();
            tokio::spawn(async move {
                advisor_review(provider, advisor_model, advisor_message, updates).await;
            });
        }
        Ok(())
    }

    fn active_snapshot(&self) -> Value {
        json!({
            "sessionId": self.active.id,
            "model": self.active.model,
            "startedAt": self.active.started_at,
            "persistence": self.active.persistence,
        })
    }

    fn refresh_catalog(&mut self, id: Option<String>) {
        if self.catalog.refreshing {
            self.respond(
                "refresh_model_catalog",
                id,
                Some(self.catalog.response_data()),
            );
            return;
        }
        self.catalog.refreshing = true;
        let authenticated = self.authenticated.clone();
        let paths = self.paths.clone();
        let updates = self.updates.clone();
        tokio::spawn(async move {
            let result = auth::models(&authenticated, &paths)
                .await
                .map_err(|error| redact_error(&error.to_string()));
            let _ = updates.send(RunUpdate::CatalogRefresh { id, result });
        });
    }

    async fn handle_run_update(&mut self, update: RunUpdate) {
        match update {
            RunUpdate::Frame(frame) => self.send(frame),
            RunUpdate::CatalogRefresh { id, result } => match result {
                Ok(models) => {
                    self.catalog.replace(models);
                    self.respond(
                        "refresh_model_catalog",
                        id,
                        Some(self.catalog.response_data()),
                    );
                }
                Err(error) => {
                    self.catalog.refreshing = false;
                    self.catalog.last_error = Some(error.clone());
                    self.respond_error("refresh_model_catalog", id, error);
                }
            },
            RunUpdate::Complete {
                id,
                messages,
                todos,
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
                        self.active.todos = todos;
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
        let stored_jobs = load_cron(&self.paths).await?;
        let mut jobs = with_internal_cron_jobs(stored_jobs.clone());
        if jobs != stored_jobs {
            save_cron(&self.paths, &jobs).await?;
        }
        let result = match command.kind.as_str() {
            "cron_list" => {
                let visible_jobs = visible_cron_jobs(&jobs);
                let cursor = command
                    .fields
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let limit = command
                    .fields
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(visible_jobs.len() as u64) as usize;
                let page = visible_jobs
                    .iter()
                    .skip(cursor)
                    .take(limit)
                    .cloned()
                    .collect::<Vec<_>>();
                let mut data = json!({"jobs": page});
                if cursor + page.len() < visible_jobs.len() {
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
                if is_protected_cron_job(&job_id) {
                    bail!("cron job id is reserved");
                }
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
                if is_protected_cron_job(job_id) {
                    bail!("internal cron jobs cannot be changed");
                }
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
                if is_protected_cron_job(command.string("jobId")?) {
                    bail!("internal cron jobs cannot be removed");
                }
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
        let discovered = skills::discover_async(&self.paths.skills).await?;
        match command.kind.as_str() {
            "skills_list" => Ok(
                json!({"skills": discovered.iter().map(Self::skill_summary_value).collect::<Vec<_>>() }),
            ),
            "skill_get" => {
                let skill = discovered
                    .into_iter()
                    .find(|skill| skill.name == command.string("name").unwrap_or_default())
                    .context("skill not found")?;
                Ok(json!({"skill":Self::skill_value(&skill)}))
            }
            "skill_create" => {
                let skill =
                    skills::create(&self.paths.skills, &Self::skill_input(command)?).await?;
                Ok(json!({"skill":Self::skill_value(&skill)}))
            }
            "skill_update" => {
                let skill =
                    skills::update(&self.paths.skills, &Self::skill_input(command)?).await?;
                Ok(json!({"skill":Self::skill_value(&skill)}))
            }
            "skill_delete" => {
                skills::delete(&self.paths.skills, command.string("name")?).await?;
                Ok(Value::Null)
            }
            _ => unreachable!(),
        }
    }

    fn skill_summary_value(skill: &skills::Skill) -> Value {
        json!({
        "name": skill.name.clone(),
        "description": skill.description.clone(),
        "disableModelInvocation": skill.disabled,
        })
    }

    fn skill_value(skill: &skills::Skill) -> Value {
        let mut value = Self::skill_summary_value(skill);
        value["body"] = Value::String(skill.body.clone());
        value
    }

    fn skill_input(command: &Command) -> Result<SkillInput> {
        let body = command
            .fields
            .get("body")
            .and_then(Value::as_str)
            .context("invalid command: body must be a string")?;
        Ok(SkillInput {
            name: command.string("name")?.to_owned(),
            description: command.string("description")?.to_owned(),
            body: body.to_owned(),
            disabled: command
                .fields
                .get("disableModelInvocation")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
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

struct AgentRunPrompt {
    user: String,
    available_skills: String,
}

async fn provider_turn(
    provider: widevin::DevinProvider,
    model: String,
    messages: &mut Vec<Value>,
    prompt: AgentRunPrompt,
    tool_context: ToolContext,
    cancellation: CancellationToken,
    updates: &mpsc::UnboundedSender<RunUpdate>,
) -> Result<()> {
    let user = json!({"role":"user","content":prompt.user});
    messages.push(user.clone());
    send_update(updates, json!({"type":"agent_start"}));
    send_update(updates, json!({"type":"turn_start"}));
    let mut latest_usage = None;

    loop {
        send_update(
            updates,
            json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
        );
        let widevin_messages = json_messages_to_widevin(messages)?;
        let mut stream = provider.stream_chat(agent_request(
            model.clone(),
            widevin_messages,
            prompt.available_skills.clone(),
        ));
        let mut text = String::new();
        let mut thinking = String::new();
        let mut tool_calls = Vec::new();

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
                            latest_usage = Some((input_tokens, output_tokens));
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
                            tool_calls.push((id.clone(), name.clone(), arguments.clone()));
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
        parts.extend(tool_calls.iter().map(|(id, name, arguments)| {
            json!({"type":"toolCall","id":id,"name":name,"arguments":arguments})
        }));
        let assistant = json!({"role":"assistant","content":parts});
        messages.push(assistant.clone());
        send_update(
            updates,
            json!({"type":"message_end","message":assistant.clone()}),
        );

        if tool_calls.is_empty() || cancellation.is_cancelled() {
            break;
        }

        for (id, name, arguments) in tool_calls {
            send_update(
                updates,
                json!({"type":"tool_execution_start","toolCallId":id,"toolName":name,"args":arguments}),
            );
            let result = tools::execute(&name, &arguments, &tool_context).await;
            let (content, is_error) = match result {
                Ok(content) => (content, false),
                Err(error) => (redact_error(&error.to_string()), true),
            };
            messages
                .push(json!({"role":"tool","toolCallId":id,"content":content,"isError":is_error}));
            send_update(
                updates,
                json!({"type":"tool_execution_end","toolCallId":id,"toolName":name,"result":{"content":content,"isError":is_error}}),
            );
        }
    }

    send_update(
        updates,
        json!({"type":"turn_end","usage":latest_usage.map(|(input_tokens, output_tokens)| json!({"inputTokens":input_tokens,"outputTokens":output_tokens}))}),
    );
    send_update(
        updates,
        json!({"type":"agent_end","messages":messages.clone()}),
    );
    send_update(updates, json!({"type":"agent_settled"}));
    Ok(())
}

async fn advisor_review(
    provider: widevin::DevinProvider,
    model: String,
    message: String,
    updates: mpsc::UnboundedSender<RunUpdate>,
) {
    let request = DevinChatRequest {
        model,
        messages: vec![DevinMessage::User { content: vec![DevinContentPart::Text { text: message }] }],
        system_prompt: vec!["You are Railgun's private implementation advisor. Review the task for one concrete risk. If there is a useful note, call advise once with severity nit, concern, or blocker; otherwise return no tool call. Never produce more than one note.".into()],
        tools: tools::advisor_schemas(),
        ..Default::default()
    };
    let mut stream = provider.stream_chat(request);
    while let Some(event) = stream.next().await {
        let Ok(event) = event else {
            return;
        };
        if let DevinStreamEvent::ToolCallEnd {
            name, arguments, ..
        } = event
        {
            if name != "advise" {
                continue;
            }
            let Ok((severity, text)) = tools::advisory(&arguments) else {
                return;
            };
            let text = text
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            send_update(
                &updates,
                json!({"type":"message_start","message":{"role":"user","content":format!("<advisory severity=\"{severity}\">{text}</advisory>")}}),
            );
            return;
        }
    }
}

fn agent_request(
    model: String,
    messages: Vec<DevinMessage>,
    available_skills: String,
) -> DevinChatRequest {
    DevinChatRequest {
        model,
        messages,
        system_prompt: vec![
            "You are Railgun, a careful coding agent. You can read local files in the user's home directory with read_file. When the user supplies an absolute path there, call read_file before claiming the file is unavailable; never say a local path needs to be uploaded. Be concise, preserve user data, and report verification honestly.".into(),
            available_skills,
        ],
        tools: tools::schemas(),
        ..Default::default()
    }
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
            | "refresh_model_catalog"
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
            | "skill_create"
            | "skill_update"
            | "skill_delete"
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

fn approval_mode_for(config: &Value) -> ApprovalMode {
    match (
        config.get("approvalMode").and_then(Value::as_str),
        config.get("reviewerModel").and_then(Value::as_str),
    ) {
        (Some("off"), _) => ApprovalMode::Full,
        (Some("smart"), Some(reviewer_model)) if !reviewer_model.trim().is_empty() => {
            ApprovalMode::Smart {
                reviewer_model: reviewer_model.into(),
            }
        }
        _ => ApprovalMode::Manual,
    }
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

async fn scheduled_job_runtime(paths: &RailgunPaths) -> Result<(Authenticated, String)> {
    let authenticated = auth::background_provider(paths).await?;
    let config = config::load(paths).await?;
    let models = auth::models(&authenticated, paths).await?;
    let model = config
        .get("model")
        .and_then(Value::as_str)
        .filter(|id| models.iter().any(|candidate| candidate.id == *id))
        .map(str::to_owned)
        .or_else(|| models.first().map(|candidate| candidate.id.clone()))
        .context("Devin returned no available models")?;
    Ok((authenticated, model))
}

async fn run_scheduler(paths: RailgunPaths) -> Result<()> {
    let store = Store::open(&paths.state).await?;
    tracing::info!("scheduler started");
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        signal.cancel();
    });
    loop {
        if cancellation.is_cancelled() {
            break;
        }
        match load_cron(&paths).await {
            Ok(stored_jobs) => {
                let mut jobs = with_internal_cron_jobs(stored_jobs.clone());
                let timestamp = chrono::Local::now();
                let mut changed = jobs != stored_jobs;
                for job in &mut jobs {
                    if !cron_due(job, timestamp)? {
                        continue;
                    }
                    let result = if job["kind"] == "dream" {
                        let (output, _receiver) = mpsc::unbounded_channel();
                        run_dream_job(&store, &paths, &output)
                            .await
                            .map(|_| "completed")
                    } else {
                        let prompt = job["prompt"].as_str().unwrap_or_default().to_owned();
                        let job_id = job["id"].as_str().unwrap_or_default().to_owned();
                        match scheduled_job_runtime(&paths).await {
                            Ok((authenticated, model)) => {
                                run_scheduled_job(
                                    &authenticated,
                                    &model,
                                    &store,
                                    &paths,
                                    &job_id,
                                    &prompt,
                                    cancellation.clone(),
                                )
                                .await
                            }
                            Err(error) => Err(error),
                        }
                    };
                    let (status, error) = match result {
                        Ok(status) => (status, None),
                        Err(error) => ("failed", Some(redact_error(&error.to_string()))),
                    };
                    job["lastRun"] = json!(timestamp.timestamp_millis());
                    job["lastStatus"] = json!(status);
                    job["lastError"] = error.map(Value::String).unwrap_or(Value::Null);
                    if status == "completed" {
                        job["lastSuccess"] = json!(timestamp.timestamp_millis());
                    }
                    changed = true;
                }
                if changed {
                    save_cron(&paths, &jobs).await?;
                }
            }
            Err(error) => tracing::warn!(error = %error, "scheduler could not load cron jobs"),
        }
        tokio::select! { _ = cancellation.cancelled() => break, _ = tokio::time::sleep(next_minute_delay(chrono::Local::now())) => {} }
    }
    Ok(())
}

async fn run_dream(paths: RailgunPaths) -> Result<()> {
    if auth::background_provider(&paths).await.is_err() {
        return Ok(());
    }
    let store = Store::open(&paths.state).await?;
    let (output, _receiver) = mpsc::unbounded_channel();
    let summary = run_dream_job(&store, &paths, &output).await?;
    tracing::info!(?summary, "dream memory maintenance completed");
    Ok(())
}

fn cron_due<Tz: chrono::TimeZone>(job: &Value, now: chrono::DateTime<Tz>) -> Result<bool> {
    let schedule = job["schedule"]
        .as_str()
        .context("cron job schedule is missing")?;
    let matching = croner::Cron::from_str(schedule)?.is_time_matching(&now)?;
    let last_run = job["lastRun"].as_i64().unwrap_or(0);
    Ok(matching && last_run / 60_000 != now.timestamp_millis() / 60_000)
}

fn next_minute_delay<Tz: chrono::TimeZone>(now: chrono::DateTime<Tz>) -> std::time::Duration {
    let millis_until_next_minute =
        (59 - now.second()) as u64 * 1_000 + (1_000 - now.timestamp_subsec_millis() as u64);
    std::time::Duration::from_millis(millis_until_next_minute)
}

async fn run_scheduled_job(
    authenticated: &Authenticated,
    model: &str,
    store: &Store,
    paths: &RailgunPaths,
    job_id: &str,
    prompt: &str,
    cancellation: CancellationToken,
) -> Result<&'static str> {
    let mut session = fresh_session(model.to_owned());
    let available_skills =
        skills::available_skills_prompt(&discover_skills_for_run(&paths.skills, false).await?);
    session.id = format!("cron-{}", uuid::Uuid::new_v4());
    let (updates, mut receiver) = mpsc::unbounded_channel();
    let drain = tokio::spawn(async move { while receiver.recv().await.is_some() {} });
    let context = ToolContext {
        paths: paths.clone(),
        store: store.clone(),
        cancellation: cancellation.clone(),
        updates: mpsc::unbounded_channel().0,
        todos: Arc::new(Mutex::new(Vec::new())),
        interactions: None,
        approvals: Arc::new(Mutex::new(std::collections::HashSet::new())),
        approval_mode: ApprovalMode::Manual,
        user_intent: None,
        delegation_depth: 0,
        delegation_slots: Arc::new(Semaphore::new(3)),
        provider: Some(authenticated.provider.clone()),
        model: Some(model.to_owned()),
    };
    let outcome = provider_turn(
        authenticated.provider.clone(),
        model.to_owned(),
        &mut session.messages,
        AgentRunPrompt {
            user: prompt.to_owned(),
            available_skills,
        },
        context,
        cancellation,
        &updates,
    )
    .await;
    drop(updates);
    let _ = drain.await;
    let status = if outcome.is_ok()
        && session
            .messages
            .last()
            .is_some_and(|message| message["role"] == "assistant")
    {
        "completed"
    } else {
        "failed"
    };
    if outcome.is_err() {
        session.messages.push(
            json!({"role":"assistant","content":[{"type":"text","text":"Scheduled task failed."}]}),
        );
    }
    store
        .save_scheduled_session(&mut session, job_id, prompt, status)
        .await?;
    outcome?;
    Ok(status)
}

async fn run_dream_job(
    store: &Store,
    paths: &RailgunPaths,
    output: &mpsc::UnboundedSender<Value>,
) -> Result<Value> {
    let before = store.memories(None, 10_000).await?;
    if before.len() < 5 {
        let _ = output.send(json!({"type":"dream_progress","phase":"skipped","message":"Dream needs at least five memories."}));
        return Ok(
            json!({"status":"skipped","beforeCount":before.len(),"afterCount":before.len()}),
        );
    }
    let _ = output.send(
        json!({"type":"dream_progress","phase":"reviewing","message":"Reviewing saved memories."}),
    );
    let mut seen = std::collections::HashMap::<(String, String), Vec<String>>::new();
    for memory in &before {
        seen.entry((
            memory["category"].as_str().unwrap_or_default().into(),
            memory["content"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_lowercase(),
        ))
        .or_default()
        .push(memory["id"].as_str().unwrap_or_default().into());
    }
    let operations = seen.into_iter().filter(|(_, ids)| ids.len() > 1).map(|((category, content), ids)| json!({"action":"merge","ids":ids,"newContent":content,"category":category,"reason":"Exact duplicate memories"})).collect::<Vec<_>>();
    if !operations.is_empty() {
        let _ = output.send(json!({"type":"dream_progress","phase":"consolidating","message":"Consolidating duplicate memories."}));
        let context = ToolContext {
            paths: paths.clone(),
            store: store.clone(),
            cancellation: CancellationToken::new(),
            updates: output.clone(),
            todos: Arc::new(Mutex::new(Vec::new())),
            interactions: None,
            approvals: Arc::new(Mutex::new(std::collections::HashSet::new())),
            approval_mode: ApprovalMode::Manual,
            user_intent: None,
            delegation_depth: 0,
            delegation_slots: Arc::new(Semaphore::new(3)),
            provider: None,
            model: None,
        };
        tools::execute(
            "memory_consolidate",
            &json!({"operations":operations}),
            &context,
        )
        .await?;
    }
    let after = store.memories(None, 10_000).await?;
    let _ = output.send(json!({"type":"dream_progress","phase":"complete","message":"Memory consolidation complete."}));
    Ok(json!({"status":"completed","beforeCount":before.len(),"afterCount":after.len()}))
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

    #[tokio::test]
    async fn skill_scan_failures_are_best_effort_except_for_explicit_invocations() {
        let home = tempfile::tempdir().unwrap();
        let paths = RailgunPaths::for_user_home(home.path());
        tokio::fs::create_dir_all(&paths.home).await.unwrap();
        tokio::fs::write(&paths.skills, "not a directory")
            .await
            .unwrap();

        let ordinary = discover_skills_for_run(&paths.skills, false).await.unwrap();
        let explicit = discover_skills_for_run(&paths.skills, true)
            .await
            .unwrap_err();

        assert!(ordinary.is_empty());
        assert!(explicit.to_string().contains("requested skill"));
    }

    #[test]
    fn provider_request_advertises_every_restored_tool() {
        let available_skills =
            "<available_skills>\n  <skill><name>review</name></skill>\n</available_skills>";
        let request = agent_request("model".into(), Vec::new(), available_skills.into());
        assert_eq!(
            request.system_prompt.last().map(String::as_str),
            Some(available_skills)
        );
        assert_eq!(
            request
                .tools
                .into_iter()
                .map(|tool| tool.name)
                .collect::<Vec<_>>(),
            tools::TOOL_NAMES,
        );
    }

    #[test]
    fn scheduler_only_runs_a_matching_job_once_per_minute() {
        let now = chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 7, 28, 6, 24, 0).unwrap();
        let job = json!({"schedule":"* * * * *","lastRun":now.timestamp_millis()});
        assert!(!cron_due(&job, now).unwrap());
        let old = json!({"schedule":"* * * * *","lastRun":now.timestamp_millis() - 60_000});
        assert!(cron_due(&old, now).unwrap());
    }

    #[test]
    fn scheduler_waits_for_the_next_minute_boundary() {
        let now = chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 7, 28, 6, 24, 5)
            .unwrap()
            .with_nanosecond(250_000_000)
            .unwrap();
        assert_eq!(
            next_minute_delay(now),
            std::time::Duration::from_millis(54_750)
        );
    }

    #[test]
    fn scheduler_owns_a_hidden_protected_midnight_dream_job() {
        let user_job = json!({
            "id":"user-job",
            "schedule":"0 9 * * *",
            "prompt":"Morning review",
        });
        let jobs = with_internal_cron_jobs(vec![user_job.clone()]);
        let dream = jobs
            .iter()
            .find(|job| job["id"] == tools::INTERNAL_DREAM_JOB_ID)
            .unwrap();

        assert_eq!(dream["schedule"], "0 0 * * *");
        assert_eq!(dream["kind"], "dream");
        assert_eq!(dream["internal"], true);
        assert_eq!(visible_cron_jobs(&jobs), vec![user_job]);
        assert!(is_protected_cron_job(tools::INTERNAL_DREAM_JOB_ID));
    }

    #[tokio::test]
    async fn scheduler_requires_cached_authentication_without_starting_login() {
        let home = tempfile::tempdir().unwrap();
        let paths = RailgunPaths::for_user_home(home.path());

        let error = scheduled_job_runtime(&paths)
            .await
            .err()
            .expect("missing credentials should keep the scheduler idle");

        assert_eq!(
            auth::authentication_required_source(&error),
            Some(auth::CredentialSource::File)
        );
    }

    #[test]
    fn scheduler_rejects_second_granularity_schedules() {
        assert!(tools::validate_schedule("*/10 * * * * *").is_err());
        assert!(tools::validate_schedule("* * * * *").is_ok());
    }

    #[tokio::test]
    async fn dream_skips_small_memory_sets_and_consolidates_duplicates() {
        let home = tempfile::tempdir().unwrap();
        let paths = RailgunPaths::for_user_home(home.path());
        let store = Store::open(&paths.state).await.unwrap();
        let (output, mut events) = mpsc::unbounded_channel();
        let skipped = run_dream_job(&store, &paths, &output).await.unwrap();
        assert_eq!(
            skipped,
            json!({"status":"skipped","beforeCount":0,"afterCount":0})
        );
        for _ in 0..5 {
            store
                .create_memory("Prefer concise answers", "preference")
                .await
                .unwrap();
        }
        let completed = run_dream_job(&store, &paths, &output).await.unwrap();
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["beforeCount"], 5);
        assert_eq!(completed["afterCount"], 1);
        let phases = std::iter::from_fn(|| events.try_recv().ok())
            .map(|event| event["phase"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert!(phases.contains(&"skipped".into()));
        assert!(phases.contains(&"consolidating".into()));
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
    fn approval_mode_is_applied_to_the_next_desktop_run() {
        assert_eq!(
            approval_mode_for(&json!({"approvalMode": "off"})),
            ApprovalMode::Full
        );
        assert_eq!(
            approval_mode_for(&json!({"approvalMode": "smart", "reviewerModel": "reviewer"})),
            ApprovalMode::Smart {
                reviewer_model: "reviewer".into()
            }
        );
        assert_eq!(
            approval_mode_for(&json!({"approvalMode": "smart"})),
            ApprovalMode::Manual
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
