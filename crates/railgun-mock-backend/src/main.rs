use anyhow::{Result, bail};
use chrono::Utc;
use railgun_backend::{protocol::CAPABILITIES, transcript};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    process::ExitCode,
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

mod scenario;

use scenario::Scenario;

#[derive(Clone)]
struct MockSession {
    id: String,
    model: String,
    started_at: String,
    started_at_local: String,
    messages: Vec<Value>,
    todos: Vec<Value>,
    persistence: &'static str,
    checkpoint_error: Option<String>,
    message_ids: Vec<i64>,
}

struct Mock {
    scenario: Scenario,
    active: MockSession,
    sessions: Vec<MockSession>,
    archived: Vec<(MockSession, String)>,
    config: Value,
    cron: Vec<Value>,
    memories: Vec<Value>,
    mcp: Map<String, Value>,
    next_session: i64,
    next_message_id: i64,
    next_cron: i64,
    next_memory: i64,
    next_prompt_token: u64,
    compacted_message_count: Option<usize>,
    pending_prompt: Option<ActivePrompt>,
    interaction: Option<ActiveInteraction>,
    instructions: Vec<Value>,
    skills: Vec<Value>,
    output: mpsc::UnboundedSender<OutputFrame>,
    cancelled_prompts: Arc<Mutex<HashSet<u64>>>,
    scheduled: mpsc::UnboundedSender<Scheduled>,
}

struct OutputFrame {
    value: Value,
    prompt_token: Option<u64>,
}

struct ActivePrompt {
    token: u64,
    id: Option<String>,
    steering: Vec<String>,
    follow_up: Vec<String>,
}

struct ActiveInteraction {
    kind: InteractionKind,
    request_id: String,
    prompt_id: Option<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum InteractionKind {
    Approval,
    Clarification,
}

enum QueueKind {
    Steering,
    FollowUp,
}

enum Scheduled {
    Emit { token: u64, frame: Value },
    Dequeue { token: u64, kind: QueueKind },
    Finish { token: u64, text: String },
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<u8> {
    let scenario_id = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "ready-idle".into());
    let Some(scenario) = Scenario::parse(&scenario_id) else {
        bail!("Unknown mock scenario: {scenario_id}");
    };
    if scenario == Scenario::AuthenticationRequired {
        write_fragmented_frame(&json!({
            "type":"startup_status",
            "status":"authentication_required",
            "credential_source":"file"
        }))
        .await?;
        tokio::time::sleep(Duration::from_millis(30)).await;
        return Ok(1);
    }
    if scenario == Scenario::CrashBeforeReady {
        eprintln!("mock backend crashed before readiness");
        tokio::time::sleep(Duration::from_millis(20)).await;
        return Ok(17);
    }

    let (output, mut frames) = mpsc::unbounded_channel::<OutputFrame>();
    let cancelled_prompts = Arc::new(Mutex::new(HashSet::new()));
    let writer_cancelled_prompts = cancelled_prompts.clone();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = frames.recv().await {
            if frame.prompt_token.is_some_and(|token| {
                writer_cancelled_prompts
                    .lock()
                    .expect("cancelled prompt lock poisoned")
                    .contains(&token)
            }) {
                continue;
            }
            let mut line = serde_json::to_vec(&frame.value)?;
            line.push(b'\n');
            let split = (line.len() / 2).max(1);
            stdout.write_all(&line[..split]).await?;
            stdout.flush().await?;
            tokio::time::sleep(Duration::from_millis(8)).await;
            stdout.write_all(&line[split..]).await?;
            stdout.flush().await?;
            tokio::time::sleep(Duration::from_millis(8)).await;
        }
        Ok::<_, anyhow::Error>(())
    });
    let (scheduled, mut actions) = mpsc::unbounded_channel();
    let mut mock = Mock::new(scenario, output, cancelled_prompts, scheduled);
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdin_closed = false;
    loop {
        tokio::select! {
            line = lines.next_line(), if !stdin_closed => {
                let Some(line) = line? else {
                    stdin_closed = true;
                    if mock.pending_prompt.is_none() || mock.interaction.is_some() {
                        break;
                    }
                    continue;
                };
                if mock.scenario == Scenario::MalformedOutput {
                    let mut stdout = tokio::io::stdout();
                    stdout.write_all(b"{malformed-json\n").await?;
                    stdout.flush().await?;
                    continue;
                }
                let command = match serde_json::from_str::<Value>(&line) {
                    Ok(Value::Object(value)) => value,
                    _ => {
                        mock.respond_error("unknown", None, "parse_error: invalid JSON");
                        continue;
                    }
                };
                let exit = mock.handle(command).await?;
                if let Some(code) = exit {
                    drop(mock.output);
                    writer.await??;
                    return Ok(code);
                }
            }
            action = actions.recv() => {
                if let Some(action) = action {
                    mock.handle_scheduled(action);
                    if stdin_closed && mock.pending_prompt.is_none() {
                        break;
                    }
                }
            }
        }
    }
    drop(mock.output);
    writer.await??;
    Ok(0)
}

impl Mock {
    fn new(
        scenario: Scenario,
        output: mpsc::UnboundedSender<OutputFrame>,
        cancelled_prompts: Arc<Mutex<HashSet<u64>>>,
        scheduled: mpsc::UnboundedSender<Scheduled>,
    ) -> Self {
        let sessions = saved_sessions();
        let next_message_id = 1_000
            + sessions
                .iter()
                .map(|session| session.messages.len() as i64)
                .sum::<i64>();
        Self {
            scenario,
            active: MockSession {
                id: "mock-session".into(),
                model: "mock-model".into(),
                started_at: "2026-07-14T09:00:00.000Z".into(),
                started_at_local: "7/14/2026, 5:00:00 PM".into(),
                messages: Vec::new(),
                todos: Vec::new(),
                persistence: "unsaved",
                checkpoint_error: None,
                message_ids: Vec::new(),
            },
            sessions,
            archived: Vec::new(),
            config: json!({
                "archiveRetentionDays":7,
                "model":"mock-model",
                "moaPresets":{"review":{
                    "referenceModels":[{"model":"mock-reference"}],
                    "aggregator":{"model":"mock-model"},
                    "referenceMaxTokens":4000
                }},
                "advisor":{"enabled":false,"model":"mock-reference"}
            }),
            cron: vec![
                json!({
                    "id":"mock-cron-morning",
                    "schedule":"0 9 * * 1-5",
                    "prompt":"Summarize the priorities for today",
                    "lastRun":null,
                    "requiredOutputs":[]
                }),
                json!({
                    "id":"mock-cron-review",
                    "schedule":"*/30 8-17 * * MON-FRI",
                    "prompt":"Review active work and flag blockers",
                    "lastRun":1_752_500_000_000_i64,
                    "requiredOutputs":["/tmp/private-contract"]
                }),
            ],
            memories: vec![
                json!({
                    "id":"memory-1",
                    "content":"Prefer concise implementation summaries",
                    "category":"preference",
                    "createdAt":1_720_000_005
                }),
                json!({"id":"memory-2","content":"Railgun is a native macOS app","category":"fact","createdAt":1_720_000_004}),
                json!({"id":"memory-3","content":"Use pnpm for JavaScript projects","category":"preference","createdAt":1_720_000_003}),
                json!({"id":"memory-4","content":"Knowledge imports Markdown and text notes","category":"fact","createdAt":1_720_000_002}),
                json!({"id":"memory-5","content":"Keep renderer filesystem access restricted","category":"fact","createdAt":1_720_000_001}),
            ],
            mcp: Map::from_iter([(
                "docs".into(),
                json!({
                    "command":"/opt/railgun/bin/docs-server",
                    "args":["--stdio","--format","markdown"],
                    "env":{"DOCS_TOKEN":"mock-stored-secret","REGION":"us-east-1"}
                }),
            )]),
            next_session: 1,
            next_message_id,
            next_cron: 1,
            next_memory: 6,
            next_prompt_token: 1,
            compacted_message_count: None,
            pending_prompt: None,
            interaction: None,
            instructions: instruction_files(true),
            skills: mock_skills(true),
            output,
            cancelled_prompts,
            scheduled,
        }
    }

    fn send(&self, frame: Value) {
        let _ = self.output.send(OutputFrame {
            value: frame,
            prompt_token: None,
        });
    }

    fn send_prompt(&self, token: u64, frame: Value) {
        let _ = self.output.send(OutputFrame {
            value: frame,
            prompt_token: Some(token),
        });
    }

    fn respond(&self, command: &str, id: Option<&str>, data: Option<Value>) {
        let mut frame = json!({"type":"response","command":command,"success":true});
        if let Some(id) = id {
            frame["id"] = Value::String(id.into());
        }
        if let Some(data) = data {
            frame["data"] = data;
        }
        self.send(frame);
    }

    fn respond_error(&self, command: &str, id: Option<&str>, error: &str) {
        let mut frame = json!({"type":"response","command":command,"success":false,"error":error});
        if let Some(id) = id {
            frame["id"] = Value::String(id.into());
        }
        self.send(frame);
    }

    async fn handle(&mut self, command: Map<String, Value>) -> Result<Option<u8>> {
        let kind = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let id = command.get("id").and_then(Value::as_str).map(str::to_owned);
        if kind == "initialize" {
            if self.scenario == Scenario::HandshakeFailure {
                self.respond_error(&kind, id.as_deref(), "mock protocol mismatch");
            } else {
                if self.scenario == Scenario::DelayedStartup {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                } else {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"version":1,"capabilities":CAPABILITIES})),
                );
            }
            return Ok(None);
        }
        if self.scenario == Scenario::CommandRejection {
            self.respond_error(&kind, id.as_deref(), &format!("mock rejected {kind}"));
            return Ok(None);
        }
        match kind.as_str() {
            "get_state" => {
                if self.scenario == Scenario::DelayedStartup {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
                let message_count = self.compacted_message_count.unwrap_or_else(|| {
                    self.active.messages.len() + usize::from(self.pending_prompt.is_some())
                });
                let mut state = json!({
                        "running":self.pending_prompt.is_some(),
                        "model":self.active.model,
                        "messageCount":message_count,
                        "todos":self.active.todos,
                        "protocolVersion":1,
                        "sessionId":self.active.id,
                        "startedAt":self.active.started_at,
                        "persistence":self.active.persistence,
                    });
                if let Some(error) = &self.active.checkpoint_error {
                    state["checkpointError"] = Value::String(error.clone());
                }
                self.respond(&kind, id.as_deref(), Some(state));
                if self.scenario == Scenario::DisconnectAfterReady {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    return Ok(Some(23));
                }
            }
            "get_messages" => self.respond(
                &kind,
                id.as_deref(),
                Some(json!({"messages":self.active.messages})),
            ),
            "get_available_models" => self.respond(
                &kind,
                id.as_deref(),
                Some(json!({"models":if self.scenario == Scenario::EmptyModelCatalog {Vec::new()} else {mock_models()}})),
            ),
            "refresh_model_catalog" => self.respond(
                &kind,
                id.as_deref(),
                Some(json!({
                    "models": if self.scenario == Scenario::EmptyModelCatalog { Vec::new() } else { mock_models() },
                    "catalog": {"freshness":"cached", "generation":1, "refreshing":false},
                })),
            ),
            "session_list" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let sessions = if self.scenario == Scenario::EmptyStores {
                    Vec::new()
                } else {
                    self.sessions.iter().map(session_summary).collect()
                };
                self.respond(&kind, id.as_deref(), Some(json!({"sessions":sessions})));
            }
            "session_list_archived" => {
                let sessions = self
                    .archived
                    .iter()
                    .map(|(session, archived_at)| {
                        let mut value = session_summary(session);
                        value["archivedAt"] = Value::String(archived_at.clone());
                        value
                    })
                    .collect::<Vec<_>>();
                self.respond(&kind, id.as_deref(), Some(json!({"sessions":sessions})));
            }
            "session_delivery_cursor" => {
                self.respond(&kind, id.as_deref(), Some(json!({"cursor":0})));
            }
            "session_new" => {
                if !self.require_idle(
                    &kind,
                    id.as_deref(),
                    "cannot create a new session while agent is running",
                ) {
                    return Ok(None);
                }
                let session_id = format!("mock-new-{}", self.next_session);
                self.next_session += 1;
                self.active = MockSession {
                    id: session_id.clone(),
                    model: "mock-model".into(),
                    started_at: format!(
                        "2026-07-14T10:{:02}:00.000Z",
                        self.next_session.rem_euclid(60)
                    ),
                    started_at_local: "7/14/2026, 6:00:00 PM".into(),
                    messages: Vec::new(),
                    todos: Vec::new(),
                    persistence: "unsaved",
                    checkpoint_error: None,
                    message_ids: Vec::new(),
                };
                self.compacted_message_count = None;
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"sessionId":session_id})),
                );
            }
            "session_load" => {
                if !self.require_idle(
                    &kind,
                    id.as_deref(),
                    "cannot load a session while agent is running",
                ) {
                    return Ok(None);
                }
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                if command
                    .get("includeMessages")
                    .is_some_and(|value| !value.is_boolean())
                {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "invalid command: includeMessages must be a boolean",
                    );
                    return Ok(None);
                }
                let session_id = command
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let Some(session) = self
                    .sessions
                    .iter()
                    .find(|session| session.id == session_id)
                    .cloned()
                else {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!("session not found: {session_id}"),
                    );
                    return Ok(None);
                };
                self.active = session;
                self.compacted_message_count = None;
                let mut data = json!({"sessionId":session_id});
                if command.get("includeMessages").and_then(Value::as_bool) != Some(false) {
                    data["messages"] = Value::Array(self.active.messages.clone());
                }
                self.respond(&kind, id.as_deref(), Some(data));
            }
            "session_save" => {
                self.active.persistence = "saved";
                upsert_session(&mut self.sessions, self.active.clone());
                self.send(json!({"type":"session_saved","sessionId":self.active.id}));
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"sessionId":self.active.id})),
                );
            }
            "session_archive" => {
                if !self.require_idle(
                    &kind,
                    id.as_deref(),
                    "cannot archive a session while agent is running",
                ) {
                    return Ok(None);
                }
                let session_id = command["sessionId"].as_str().unwrap_or_default();
                let Some(index) = self
                    .sessions
                    .iter()
                    .position(|session| session.id == session_id)
                else {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!("active session {session_id} not found"),
                    );
                    return Ok(None);
                };
                if self.active.id == session_id && self.active.persistence != "saved" {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "active session must be saved before archiving",
                    );
                    return Ok(None);
                }
                let session = self.sessions.remove(index);
                self.archived.insert(0, (session, now()));
                if self.active.id == session_id {
                    self.active = fresh_active_session(
                        &format!("mock-new-{}", self.next_session),
                        "mock-model",
                    );
                    self.next_session += 1;
                    self.compacted_message_count = None;
                }
                self.respond(&kind, id.as_deref(), Some(json!({"sessionId":self.active.id})));
            }
            "session_unarchive" => {
                if !self.require_idle(
                    &kind,
                    id.as_deref(),
                    "cannot restore a session while agent is running",
                ) {
                    return Ok(None);
                }
                let session_id = command["sessionId"].as_str().unwrap_or_default();
                if let Some(index) = self.archived.iter().position(|(session, _)| session.id == session_id) {
                    let (session, _) = self.archived.remove(index);
                    self.sessions.insert(0, session);
                    self.respond(&kind, id.as_deref(), Some(json!({"sessionId":self.active.id})));
                } else {
                    self.respond_error(&kind, id.as_deref(), &format!("archived session {session_id} not found"));
                }
            }
            "session_transcript" => {
                if command.get("sessionId").and_then(Value::as_str)
                    != Some(self.active.id.as_str())
                {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "requested transcript does not match the active session",
                    );
                    return Ok(None);
                }
                if command.get("cursor").is_some_and(|value| {
                    value.as_i64().is_none_or(|cursor| cursor < 0)
                }) {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "invalid command: cursor must be a non-negative integer",
                    );
                    return Ok(None);
                }
                if command.get("limit").is_some_and(|value| {
                    value
                        .as_i64()
                        .is_none_or(|limit| !(1..=100).contains(&limit))
                }) {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "invalid command: limit must be an integer between 1 and 100",
                    );
                    return Ok(None);
                }
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(transcript::page(
                        &self.active.id,
                        &self.active.messages,
                        command.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize,
                        command.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize,
                        Some(&self.active.message_ids),
                        false,
                    )),
                );
            }
            "session_recent_messages" => {
                let messages = self
                    .active
                    .messages
                    .iter()
                    .zip(&self.active.message_ids)
                    .rev()
                    .take(command.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize)
                    .map(|(message, message_id)| json!({
                        "id":message_id,
                        "role":message["role"],
                        "preview":"mock message"
                    }))
                    .collect::<Vec<_>>();
                self.respond(&kind, id.as_deref(), Some(json!({"messages":messages})));
            }
            "session_fork" => {
                if !self.require_idle(
                    &kind,
                    id.as_deref(),
                    "cannot fork a session while agent is running",
                ) {
                    return Ok(None);
                }
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                if command
                    .get("includeMessages")
                    .is_some_and(|value| !value.is_boolean())
                {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "invalid command: includeMessages must be a boolean",
                    );
                    return Ok(None);
                }
                let source_id = command
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(&self.active.id);
                let Some(mut source) = self
                    .sessions
                    .iter()
                    .find(|session| session.id == source_id)
                    .cloned()
                else {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!("session not found: {source_id}"),
                    );
                    return Ok(None);
                };
                source.id = format!("mock-fork-{}", self.next_session);
                self.next_session += 1;
                source.started_at = now();
                source.started_at_local = "7/14/2026, 7:00:00 PM".into();
                source.message_ids = (0..source.messages.len())
                    .map(|_| {
                        let message_id = self.next_message_id;
                        self.next_message_id += 1;
                        message_id
                    })
                    .collect();
                self.active = source.clone();
                self.compacted_message_count = None;
                self.sessions.insert(0, source);
                let mut data = json!({"sessionId":self.active.id});
                if command.get("includeMessages").and_then(Value::as_bool) != Some(false) {
                    data["messages"] = Value::Array(self.active.messages.clone());
                }
                self.respond(&kind, id.as_deref(), Some(data));
            }
            "session_branch" => {
                if !self.require_idle(
                    &kind,
                    id.as_deref(),
                    "cannot branch a session while agent is running",
                ) {
                    return Ok(None);
                }
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                if command.get("messageId").and_then(Value::as_i64).is_none_or(|id| id < 1) {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "invalid command: messageId must be a positive integer",
                    );
                    return Ok(None);
                }
                if !command.get("summarize").is_some_and(Value::is_boolean)
                    || command
                        .get("includeMessages")
                        .is_some_and(|value| !value.is_boolean())
                {
                    self.respond_error(&kind, id.as_deref(), "invalid branch options");
                    return Ok(None);
                }
                if self.active.persistence != "saved" {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "active session must be saved before branching",
                    );
                    return Ok(None);
                }
                let message_id = command
                    .get("messageId")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                if let Some(index) = self
                    .active
                    .message_ids
                    .iter()
                    .position(|value| *value == message_id)
                {
                    if !branchable_message_ids(&self.active).contains(&message_id) {
                        self.respond_error(
                            &kind,
                            id.as_deref(),
                            &format!("message {message_id} is not a complete turn boundary"),
                        );
                        return Ok(None);
                    }
                    self.active.messages.truncate(index + 1);
                    self.active.message_ids.truncate(index + 1);
                    self.compacted_message_count = None;
                    upsert_session(&mut self.sessions, self.active.clone());
                    let start = self.active.messages.len().saturating_sub(10);
                    let recent = self
                        .active
                        .messages
                        .iter()
                        .zip(&self.active.message_ids)
                        .skip(start)
                        .map(|(message, message_id)| json!({
                            "id":message_id,
                            "role":message["role"],
                            "preview":"mock message"
                        }))
                        .collect::<Vec<_>>();
                    let mut data = json!({"recentMessages":recent});
                    if command.get("includeMessages").and_then(Value::as_bool) != Some(false) {
                        data["messages"] = Value::Array(self.active.messages.clone());
                    }
                    self.respond(&kind, id.as_deref(), Some(data));
                } else {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!("message {message_id} is not on the active branch"),
                    );
                }
            }
            "config_get" => self.respond(
                &kind,
                id.as_deref(),
                Some(json!({"config":self.config})),
            ),
            "config_update" => {
                let Some(patch) = command.get("patch").and_then(Value::as_object) else {
                    self.respond_error(&kind, id.as_deref(), "invalid config patch");
                    return Ok(None);
                };
                let config = self.config.as_object_mut().unwrap();
                for (key, value) in patch {
                    if key == "activeMoaPreset" && value.is_null() {
                        config.remove(key);
                    } else {
                        config.insert(key.clone(), value.clone());
                    }
                }
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"config":self.config})),
                );
            }
            "set_model" => {
                if self.pending_prompt.is_some() {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "cannot change model while agent is running",
                    );
                    return Ok(None);
                }
                let model = command["modelId"].as_str().unwrap_or_default();
                if !matches!(model, "mock-model" | "mock-reference") {
                    self.respond_error(&kind, id.as_deref(), "unknown model");
                } else if self.active.model == model {
                    self.respond(&kind, id.as_deref(), None);
                } else {
                    if self.active.persistence == "saved" {
                        self.active.id = format!("mock-model-fork-{}", self.next_session);
                        self.next_session += 1;
                        self.active.started_at = now();
                        self.active.started_at_local =
                            Utc::now().format("%-m/%-d/%Y, %-I:%M:%S %p").to_string();
                        self.active.persistence = "unsaved";
                        self.active.checkpoint_error = None;
                    }
                    self.active.model = model.into();
                    self.compacted_message_count = None;
                    self.respond(&kind, id.as_deref(), None);
                }
            }
            "mcp_list" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let servers = if self.scenario == Scenario::EmptyStores {
                    Vec::new()
                } else {
                    safe_mcp(&self.mcp)
                };
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"servers":servers})),
                )
            }
            "mcp_upsert" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let Some(name) = command["name"].as_str() else {
                    self.respond_error(&kind, id.as_deref(), "invalid MCP server");
                    return Ok(None);
                };
                let Some(executable) = command["command"].as_str() else {
                    self.respond_error(&kind, id.as_deref(), "invalid MCP server");
                    return Ok(None);
                };
                let previous = self
                    .mcp
                    .get(name)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let mut env = previous
                    .get("env")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(patch) = command.get("env").and_then(Value::as_object) {
                    for (key, value) in patch {
                        if value.is_null() {
                            env.remove(key);
                        } else if value.is_string() {
                            env.insert(key.clone(), value.clone());
                        }
                    }
                }
                let args = command
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .filter_map(Value::as_str)
                            .map(|arg| Value::String(arg.into()))
                            .collect::<Vec<_>>()
                    })
                    .map(Value::Array)
                    .unwrap_or_else(|| {
                        previous
                            .get("args")
                            .cloned()
                            .unwrap_or_else(|| json!([]))
                    });
                self.mcp.insert(
                    name.into(),
                    json!({
                        "command":executable,
                        "args":args,
                        "env":env
                    }),
                );
                let server = safe_mcp(&self.mcp)
                    .into_iter()
                    .find(|server| server["name"] == name);
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"server":server})),
                );
            }
            "mcp_remove" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let name = command["name"].as_str().unwrap_or_default();
                if self.mcp.remove(name).is_none() {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!("MCP server not found: {name}"),
                    );
                } else {
                    self.respond(&kind, id.as_deref(), None);
                }
            }
            "cron_list" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let available = if self.scenario == Scenario::EmptyStores {
                    Vec::new()
                } else {
                    self.cron.clone()
                };
                if !command.contains_key("cursor")
                    && !command.contains_key("limit")
                    && !command.contains_key("editableOnly")
                    && !command.contains_key("maxPromptLength")
                {
                    self.respond(
                        &kind,
                        id.as_deref(),
                        Some(json!({"jobs":available})),
                    );
                } else {
                    let cursor = command
                        .get("cursor")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    let limit = command
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(available.len() as u64) as usize;
                    let page = available
                        .iter()
                        .skip(cursor)
                        .take(limit)
                        .cloned()
                        .collect::<Vec<_>>();
                    if let Some(maximum) =
                        command.get("maxPromptLength").and_then(Value::as_u64)
                        && page.iter().any(|job| {
                            job["prompt"]
                                .as_str()
                                .is_some_and(|prompt| prompt.len() > maximum as usize)
                        })
                    {
                        self.respond_error(
                            &kind,
                            id.as_deref(),
                            &format!("cron job prompt exceeds requested limit of {maximum}"),
                        );
                        return Ok(None);
                    }
                    let jobs = if command.get("editableOnly").and_then(Value::as_bool)
                        == Some(true)
                    {
                        page.iter()
                            .map(|job| {
                                json!({
                                    "id":job["id"],
                                    "schedule":job["schedule"],
                                    "prompt":job["prompt"]
                                })
                            })
                            .collect::<Vec<_>>()
                    } else {
                        page
                    };
                    let mut data = json!({"jobs":jobs});
                    if cursor + jobs.len() < available.len() {
                        data["nextCursor"] = json!(cursor + jobs.len());
                    }
                    self.respond(&kind, id.as_deref(), Some(data));
                }
            }
            "cron_add" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let schedule = command["schedule"].as_str().and_then(normalize_cron);
                let prompt = command["prompt"]
                    .as_str()
                    .map(str::trim)
                    .filter(|prompt| !prompt.is_empty());
                let (Some(schedule), Some(prompt)) = (schedule, prompt) else {
                    self.respond_error(&kind, id.as_deref(), "invalid cron job");
                    return Ok(None);
                };
                let job = json!({
                    "id":format!("mock-cron-{}",self.next_cron),
                    "schedule":schedule,
                    "prompt":prompt,
                    "lastRun":null,
                    "requiredOutputs":[]
                });
                self.next_cron += 1;
                self.cron.push(job.clone());
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(cron_job_response(&command, &job)),
                );
            }
            "cron_update" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let job_id = command["jobId"].as_str().unwrap_or_default();
                let Some(index) = self.cron.iter().position(|job| job["id"] == job_id)
                else {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!("cron job not found: {job_id}"),
                    );
                    return Ok(None);
                };
                let patch = command["patch"].as_object();
                let schedule = patch
                    .and_then(|patch| patch.get("schedule"))
                    .and_then(Value::as_str)
                    .and_then(normalize_cron);
                let prompt = patch
                    .and_then(|patch| patch.get("prompt"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|prompt| !prompt.is_empty());
                let (Some(schedule), Some(prompt)) = (schedule, prompt) else {
                    self.respond_error(&kind, id.as_deref(), "invalid cron update");
                    return Ok(None);
                };
                self.cron[index]["schedule"] = Value::String(schedule);
                self.cron[index]["prompt"] = Value::String(prompt.into());
                let job = self.cron[index].clone();
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(cron_job_response(&command, &job)),
                );
            }
            "cron_remove" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let length = self.cron.len();
                self.cron.retain(|job| job["id"] != command["jobId"]);
                if self.cron.len() == length {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!(
                            "cron job not found: {}",
                            command["jobId"].as_str().unwrap_or_default()
                        ),
                    );
                } else {
                    self.respond(&kind, id.as_deref(), None);
                }
            }
            "memory_list" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let memories = if self.scenario == Scenario::EmptyStores {
                    Vec::new()
                } else {
                    self.memories.iter().take(100).cloned().collect()
                };
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"memories":memories})),
                )
            }
            "memory_search" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let query = command["query"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase();
                let memories = if self.scenario == Scenario::EmptyStores {
                    Vec::new()
                } else {
                    self.memories
                        .iter()
                        .filter(|memory| {
                            memory["content"]
                                .as_str()
                                .unwrap_or_default()
                                .to_lowercase()
                                .contains(&query)
                        })
                        .take(100)
                        .cloned()
                        .collect::<Vec<_>>()
                };
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"memories":memories})),
                );
            }
            "memory_create" => {
                let memory = json!({
                    "id":format!("memory-{}",self.next_memory),
                    "content":command["content"],
                    "category":command["category"],
                    "createdAt":Utc::now().timestamp_millis() as f64 / 1000.0
                });
                self.next_memory += 1;
                self.memories.insert(0, memory.clone());
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"memory":memory})),
                );
            }
            "memory_update" => {
                let memory_id = command["memoryId"].as_str().unwrap_or_default();
                if let Some(memory) = self
                    .memories
                    .iter_mut()
                    .find(|memory| memory["id"] == memory_id)
                {
                    if let Some(patch) = command["patch"].as_object() {
                        for (key, value) in patch {
                            memory[key] = value.clone();
                        }
                    }
                    let memory = memory.clone();
                    self.respond(
                        &kind,
                        id.as_deref(),
                        Some(json!({"memory":memory})),
                    );
                } else {
                    self.respond_error(&kind, id.as_deref(), "memory not found");
                }
            }
            "memory_delete" => {
                self.memories
                    .retain(|memory| memory["id"] != command["memoryId"]);
                self.respond(&kind, id.as_deref(), None);
            }
            "skills_list" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let skills = if self.scenario == Scenario::EmptyStores {
                    Vec::new()
                } else {
                    self.skills
                        .iter()
                        .cloned()
                        .map(|mut skill| {
                            skill.as_object_mut().unwrap().remove("body");
                            skill
                        })
                        .collect()
                };
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"skills":skills})),
                )
            }
            "skill_get" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let skill = if self.scenario == Scenario::EmptyStores {
                    None
                } else {
                    self.skills
                        .iter()
                        .cloned()
                        .into_iter()
                        .find(|skill| skill["name"] == command["name"])
                };
                if let Some(skill) = skill {
                    self.respond(
                        &kind,
                        id.as_deref(),
                        Some(json!({"skill":skill})),
                    );
                } else {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        &format!(
                            "skill not found: {}",
                            command["name"].as_str().unwrap_or_default()
                        ),
                    );
                }
            }
            "skill_create" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let name = command["name"].as_str().unwrap_or_default();
                if self.skills.iter().any(|skill| skill["name"] == name) {
                    self.respond_error(&kind, id.as_deref(), "skill already exists");
                    return Ok(None);
                }
                let skill = json!({
                    "name": name,
                    "description": command["description"],
                    "disableModelInvocation": command
                        .get("disableModelInvocation")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    "body": command["body"],
                });
                self.skills.push(skill.clone());
                self.respond(&kind, id.as_deref(), Some(json!({"skill":skill})));
            }
            "skill_update" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let name = command["name"].as_str().unwrap_or_default();
                let Some(index) = self.skills.iter().position(|skill| skill["name"] == name) else {
                    self.respond_error(&kind, id.as_deref(), "skill not found");
                    return Ok(None);
                };
                let updated = {
                    let skill = &mut self.skills[index];
                    skill["description"] = command["description"].clone();
                    skill["body"] = command["body"].clone();
                    skill["disableModelInvocation"] = json!(command
                        .get("disableModelInvocation")
                        .and_then(Value::as_bool)
                        .unwrap_or(false));
                    skill.clone()
                };
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"skill":updated})),
                );
            }
            "skill_delete" => {
                if self.fail_store(&kind, id.as_deref()) {
                    return Ok(None);
                }
                let name = command["name"].as_str().unwrap_or_default();
                let before = self.skills.len();
                self.skills.retain(|skill| skill["name"] != name);
                if self.skills.len() == before {
                    self.respond_error(&kind, id.as_deref(), "skill not found");
                } else {
                    self.respond(&kind, id.as_deref(), None);
                }
            }
            "instruction_files_list" => {
                let files = self
                    .instructions
                    .iter()
                    .cloned()
                    .map(|mut file| {
                        file.as_object_mut().unwrap().remove("content");
                        file
                    })
                    .collect::<Vec<_>>();
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"files":files})),
                );
            }
            "instruction_file_get" | "instruction_file_update" => {
                let Some(index) = self
                    .instructions
                    .iter()
                    .position(|file| file["id"] == command["fileId"])
                else {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "unknown instruction file id",
                    );
                    return Ok(None);
                };
                if kind == "instruction_file_update" {
                    self.instructions[index]["content"] = command
                        .get("content")
                        .cloned()
                        .unwrap_or_else(|| Value::String(String::new()));
                    self.instructions[index]["status"] = Value::String("active".into());
                }
                self.respond(
                    &kind,
                    id.as_deref(),
                    Some(json!({"file":self.instructions[index].clone()})),
                );
            }
            "compact" => {
                if self.pending_prompt.is_some() {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "cannot compact while agent is running",
                    );
                } else if self.active.messages.is_empty() {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "cannot compact empty history",
                    );
                } else {
                    let delay = if self.scenario == Scenario::SlowCompaction {
                        600
                    } else {
                        10
                    };
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    self.compacted_message_count = Some(1);
                    self.respond(&kind, id.as_deref(), None);
                }
            }
            "dream_run" => {
                if self.pending_prompt.is_some() {
                    self.respond_error(
                        &kind,
                        id.as_deref(),
                        "cannot run Dream while agent is running",
                    );
                    return Ok(None);
                }
                let before = self.memories.len();
                if before < 5 {
                    self.send(json!({"type":"dream_progress","stage":"skipped","memoryCount":before}));
                    self.respond(
                        &kind,
                        id.as_deref(),
                        Some(json!({
                            "status":"skipped",
                            "beforeCount":before,
                            "afterCount":before
                        })),
                    );
                } else {
                    self.send(json!({"type":"dream_progress","stage":"reviewing","memoryCount":before}));
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    self.send(json!({"type":"dream_progress","stage":"consolidating","memoryCount":before}));
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    self.send(json!({"type":"dream_progress","stage":"promoting","memoryCount":before}));
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    self.send(json!({"type":"dream_progress","stage":"complete","memoryCount":self.memories.len()}));
                    self.respond(
                        &kind,
                        id.as_deref(),
                        Some(json!({
                            "status":"completed",
                            "beforeCount":before,
                            "afterCount":self.memories.len()
                        })),
                    );
                }
            }
            "prompt" => self.prompt(id, command["message"].as_str().unwrap_or_default()),
            "approval_response" | "clarification_response" => {
                self.resolve_interaction(&kind, id, &command)
            }
            "abort" => {
                if let Some(prompt) = self.pending_prompt.take() {
                    self.cancelled_prompts
                        .lock()
                        .expect("cancelled prompt lock poisoned")
                        .insert(prompt.token);
                    self.interaction = None;
                    self.send(json!({"type":"queue_update","steering":[],"followUp":[]}));
                    self.send(json!({"type":"agent_end","messages":[]}));
                    self.checkpoint_mock_turn("The mock request was stopped.");
                    self.respond("prompt", prompt.id.as_deref(), None);
                }
                self.respond(&kind, id.as_deref(), None);
            }
            "steer" | "follow_up" => self.enqueue(&kind, id, &command),
            "set_auto_compaction" => self.respond(&kind, id.as_deref(), None),
            _ => self.respond_error(&kind,id.as_deref(),&format!("unknown command: {kind}")),
        }
        Ok(None)
    }

    fn require_idle(&self, kind: &str, id: Option<&str>, error: &str) -> bool {
        if self.pending_prompt.is_some() {
            self.respond_error(kind, id, error);
            return false;
        }
        true
    }

    fn fail_store(&self, kind: &str, id: Option<&str>) -> bool {
        if self.scenario != Scenario::StoreError {
            return false;
        }
        self.respond_error(kind, id, &format!("mock store error: {kind}"));
        true
    }

    fn prompt(&mut self, id: Option<String>, message: &str) {
        if self.pending_prompt.is_some() {
            self.respond_error("prompt", id.as_deref(), "agent is already running");
            return;
        }
        let token = self.next_prompt_token;
        self.next_prompt_token += 1;
        self.active
            .messages
            .push(json!({"role":"user","content":message}));
        self.active.message_ids.push(self.next_message_id);
        self.next_message_id += 1;
        self.active.persistence = "unsaved";
        self.active.checkpoint_error = None;
        self.compacted_message_count = None;
        self.pending_prompt = Some(ActivePrompt {
            token,
            id: id.clone(),
            steering: Vec::new(),
            follow_up: Vec::new(),
        });
        self.send_prompt(token, json!({"type":"agent_start"}));
        match self.scenario {
            Scenario::Approval => {
                self.interaction = Some(ActiveInteraction {
                    kind: InteractionKind::Approval,
                    request_id: "mock-approval-1".into(),
                    prompt_id: id,
                });
                self.send(json!({"type":"approval_request","requestId":"mock-approval-1","command":"sudo mock-command"}));
            }
            Scenario::Clarification | Scenario::ClarificationFreeText => {
                self.interaction = Some(ActiveInteraction {
                    kind: InteractionKind::Clarification,
                    request_id: "mock-clarification-1".into(),
                    prompt_id: id,
                });
                self.send(json!({
                    "type":"clarification_request",
                    "requestId":"mock-clarification-1",
                    "question":"What should the mock use?"
                }));
            }
            Scenario::ClarificationChoice => {
                self.interaction = Some(ActiveInteraction {
                    kind: InteractionKind::Clarification,
                    request_id: "mock-clarification-1".into(),
                    prompt_id: id,
                });
                self.send(json!({
                    "type":"clarification_request",
                    "requestId":"mock-clarification-1",
                    "question":"Which option should the mock use?",
                    "choices":["Use the fast path","Use the safe path"]
                }));
            }
            Scenario::AgentActivity => self.schedule_agent_activity(token),
            _ => self.schedule_standard_prompt(token, message),
        }
    }

    fn resolve_interaction(
        &mut self,
        kind: &str,
        id: Option<String>,
        command: &Map<String, Value>,
    ) {
        let expected = if kind == "approval_response" {
            InteractionKind::Approval
        } else {
            InteractionKind::Clarification
        };
        let Some(interaction) = self.interaction.take() else {
            self.respond_error(
                kind,
                id.as_deref(),
                "unknown or mismatched interaction request",
            );
            return;
        };
        if interaction.kind != expected
            || command.get("requestId").and_then(Value::as_str)
                != Some(interaction.request_id.as_str())
        {
            self.interaction = Some(interaction);
            self.respond_error(
                kind,
                id.as_deref(),
                "unknown or mismatched interaction request",
            );
            return;
        }
        self.pending_prompt = None;
        let denied = kind == "approval_response"
            && command.get("approved").and_then(Value::as_bool) != Some(true);
        self.checkpoint_mock_turn(if denied {
            "The mock shell command was denied."
        } else {
            "The mock interaction was resolved."
        });
        self.respond(kind, id.as_deref(), None);
        self.send(json!({"type":"agent_end","messages":[]}));
        if denied {
            self.respond_error(
                "prompt",
                interaction.prompt_id.as_deref(),
                "shell command denied",
            );
        } else {
            self.respond("prompt", interaction.prompt_id.as_deref(), None);
        }
    }

    fn finish_prompt(&mut self, token: u64, text: &str) {
        let Some(prompt) = self.pending_prompt.take() else {
            return;
        };
        if prompt.token != token {
            self.pending_prompt = Some(prompt);
            return;
        }
        self.checkpoint_mock_turn(text);
        self.respond("prompt", prompt.id.as_deref(), None);
    }

    fn checkpoint_mock_turn(&mut self, text: &str) {
        self.active
            .messages
            .push(json!({"role":"assistant","content":[{"type":"text","text":text}]}));
        self.active.message_ids.push(self.next_message_id);
        self.next_message_id += 1;
        if self.scenario == Scenario::StoreError {
            self.active.persistence = "error";
            self.active.checkpoint_error = Some("mock checkpoint write failed".into());
        } else {
            self.active.persistence = "saved";
            self.active.checkpoint_error = None;
        }
        if !self
            .sessions
            .iter()
            .any(|session| session.id == self.active.id)
        {
            self.sessions.insert(0, self.active.clone());
        }
    }

    fn enqueue(&mut self, kind: &str, id: Option<String>, command: &Map<String, Value>) {
        let message = command
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let Some(prompt) = self.pending_prompt.as_mut() else {
            self.respond_error(kind, id.as_deref(), "Agent is not running");
            return;
        };
        if message.is_empty() {
            self.respond_error(kind, id.as_deref(), "message is required");
            return;
        }
        let token = prompt.token;
        if kind == "steer" {
            prompt.steering.push(message.into());
        } else {
            prompt.follow_up.push(message.into());
        }
        self.send_queue_update();
        self.respond(kind, id.as_deref(), None);
        self.schedule_action(
            Scheduled::Emit {
                token,
                frame: json!({"type":"message_start","message":{"role":"user","content":message}}),
            },
            24,
        );
        self.schedule_action(
            Scheduled::Dequeue {
                token,
                kind: if kind == "steer" {
                    QueueKind::Steering
                } else {
                    QueueKind::FollowUp
                },
            },
            26,
        );
    }

    fn send_queue_update(&self) {
        if let Some(prompt) = &self.pending_prompt {
            self.send_prompt(
                prompt.token,
                json!({
                    "type":"queue_update",
                    "steering":prompt.steering,
                    "followUp":prompt.follow_up
                }),
            );
        }
    }

    fn schedule_standard_prompt(&self, token: u64, message: &str) {
        for (delay, frame) in [
            (
                10,
                json!({"type":"message_update","streamEvent":{"type":"text_delta","delta":format!("## Mock response\n\nReceived **{message}**.\n\n")}}),
            ),
            (
                12,
                json!({"type":"message_update","streamEvent":{"type":"text_delta","delta":"| Mode | Status |\n| --- | --- |\n| desktop | ready |\n\n"}}),
            ),
            (
                14,
                json!({"type":"message_update","streamEvent":{"type":"text_delta","delta":"```ts\nconst streamed = true;\n```"}}),
            ),
        ] {
            self.schedule_action(Scheduled::Emit { token, frame }, delay);
        }
        if self.scenario != Scenario::Cancellation {
            self.schedule_action(Scheduled::Emit { token, frame: json!({"type":"message_end","message":{"role":"assistant","content":"mock markdown response"}}) }, 70);
            self.schedule_action(Scheduled::Emit { token, frame: json!({"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[],"usage":{"inputTokens":1200,"outputTokens":300}}) }, 90);
            self.schedule_action(
                Scheduled::Emit {
                    token,
                    frame: json!({"type":"agent_end","messages":[]}),
                },
                120,
            );
        }
        self.schedule_action(
            Scheduled::Finish {
                token,
                text: format!("Mock response received {message}."),
            },
            if self.scenario == Scenario::Cancellation {
                5_000
            } else {
                140
            },
        );
    }

    fn schedule_agent_activity(&mut self, token: u64) {
        let todos = vec![
            json!({"id":"inspect","content":"Inspect activity","status":"completed"}),
            json!({"id":"verify","content":"Verify UI","status":"in_progress"}),
        ];
        self.active.todos = todos.clone();
        let events = vec![
            json!({"type":"tool_execution_start","toolCallId":"todo-1","toolName":"todo","args":{"todos":[]}}),
            json!({"type":"subagent_start","goal":"Inspect the desktop activity path","index":0,"count":2}),
            json!({"type":"subagent_start","goal":"Verify the dashboard interaction states","index":1,"count":2}),
            json!({"type":"tool_execution_start","toolCallId":"read-1","toolName":"read_file","args":{"path":"README.md"}}),
            json!({"type":"tool_execution_start","toolCallId":"shell-1","toolName":"run_shell","args":{"command":"exit 1"}}),
            json!({"type":"moa_reference_start","index":0,"count":1,"model":"mock-reference"}),
            json!({"type":"tool_execution_end","toolCallId":"read-1","toolName":"read_file","result":{"toolCallId":"read-1","content":"Read README","isError":false}}),
            json!({"type":"tool_execution_end","toolCallId":"shell-1","toolName":"run_shell","result":{"toolCallId":"shell-1","content":"exit code 1","isError":true}}),
            json!({"type":"tool_execution_end","toolCallId":"todo-1","toolName":"todo","result":{"toolCallId":"todo-1","content":serde_json::to_string(&json!({"todos":todos})).unwrap(),"isError":false}}),
            json!({"type":"moa_reference_end","index":0,"model":"mock-reference","text":"Use accessible disclosure controls."}),
            json!({"type":"moa_aggregating","aggregator":"mock-aggregator","refCount":1}),
            json!({"type":"message_start","message":{"role":"user","content":"<advisory severity=\"nit\">Keep status text visible.</advisory>"}}),
            json!({"type":"subagent_end","goal":"Inspect the desktop activity path","index":0,"result":"Activity path inspected."}),
            json!({"type":"message_start","message":{"role":"user","content":"<advisory severity=\"concern\">Keep the detail popover keyboard accessible.</advisory>"}}),
            json!({"type":"subagent_end","goal":"Verify the dashboard interaction states","index":1,"result":"Dashboard interaction states verified."}),
            json!({"type":"message_start","message":{"role":"user","content":"<advisory severity=\"blocker\">Do not render advisor notes in the transcript.</advisory>"}}),
            json!({"type":"message_update","streamEvent":{"type":"text_delta","delta":"Activity sequence complete."}}),
            json!({"type":"message_end","message":{"role":"assistant","content":"Activity sequence complete."}}),
            json!({"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[],"usage":{"inputTokens":1200,"outputTokens":300}}),
            json!({"type":"agent_end","messages":[]}),
        ];
        for (index, frame) in events.into_iter().enumerate() {
            self.schedule_action(Scheduled::Emit { token, frame }, 10 + index as u64 * 10);
        }
        self.schedule_action(
            Scheduled::Finish {
                token,
                text: "Activity sequence complete.".into(),
            },
            240,
        );
    }

    fn schedule_action(&self, action: Scheduled, delay_ms: u64) {
        let scheduled = self.scheduled.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = scheduled.send(action);
        });
    }

    fn handle_scheduled(&mut self, action: Scheduled) {
        match action {
            Scheduled::Emit { token, frame } => {
                if self
                    .pending_prompt
                    .as_ref()
                    .is_some_and(|prompt| prompt.token == token)
                {
                    self.send_prompt(token, frame);
                }
            }
            Scheduled::Dequeue { token, kind } => {
                let Some(prompt) = self.pending_prompt.as_mut() else {
                    return;
                };
                if prompt.token != token {
                    return;
                }
                let queue = match kind {
                    QueueKind::Steering => &mut prompt.steering,
                    QueueKind::FollowUp => &mut prompt.follow_up,
                };
                if !queue.is_empty() {
                    queue.remove(0);
                }
                self.send_queue_update();
            }
            Scheduled::Finish { token, text } => self.finish_prompt(token, &text),
        }
    }
}

fn saved_sessions() -> Vec<MockSession> {
    let mut next_message_id = 1_000_i64;
    let mut assign_ids = |count: usize| {
        (0..count)
            .map(|_| {
                let id = next_message_id;
                next_message_id += 1;
                id
            })
            .collect::<Vec<_>>()
    };

    let complex = complex_task_messages();
    let paginated = (1..=101)
        .flat_map(|index| {
            [
                json!({"role":"user","content":format!("Long-history prompt {index}")}),
                json!({"role":"assistant","content":[{"type":"text","text":format!("Long-history response {index}")}]}),
            ]
        })
        .collect::<Vec<_>>();
    let rich = vec![
        json!({"role":"user","content":"Build a rich session history for desktop QA"}),
        json!({"role":"assistant","content":[
            {"type":"thinking","thinking":"This private reasoning must never render","thinkingSignature":"mock-private-signature"},
            {"type":"text","text":"# Desktop QA plan\n\nI’ll exercise **session restoration**, Markdown, todos, and scrolling.\n\n- Resume the saved session\n- Verify the toolbar title\n- Confirm private tool data is absent"}
        ]}),
        json!({"role":"user","content":"Include a code example and a status table"}),
        json!({"role":"assistant","content":[{"type":"toolCall","id":"rich-tool-1","name":"read_file","arguments":{"path":"/private/mock/path","token":"must-not-cross-boundary"}}]}),
        json!({"role":"tool","toolCallId":"rich-tool-1","content":"sensitive raw provider payload","isError":false}),
        json!({"role":"assistant","content":[{"type":"text","text":"Here is the renderer check:\n\n```ts\nconst restored = transcript.every(message => message.role === \"tool\" || message.text.length > 0);\n```\n\n| Area | Expected |\n| --- | --- |\n| Transcript | Rich text restored |\n| Tool activity | Visible |\n| Todos | Visible |"}]}),
        json!({"role":"user","content":"What edge cases should I click through?"}),
        json!({"role":"assistant","content":[{"type":"text","text":"Try filtering by `rich`, `mock-model`, and the full session ID. Then switch sessions, start a new chat, and return here. Also resize the sidebar and inspector to stress the layout."}]}),
        json!({"role":"user","content":"Add enough content to verify transcript scrolling."}),
        json!({"role":"assistant","content":[{"type":"text","text":"Scroll verification paragraph one: restored messages retain their original order.\n\nParagraph two: the transcript should begin near the latest message while remaining keyboard accessible.\n\nParagraph three: checkpoint status should read Saved immediately after resume.\n\nParagraph four: no thinking signatures, tool arguments, or tool-result payloads should appear anywhere in the renderer."}]}),
    ];
    let recent = vec![
        json!({"role":"user","content":"Polish the desktop session navigator"}),
        json!({"role":"assistant","content":[
            {"type":"thinking","thinking":"private mock thought","thinkingSignature":"secret"},
            {"type":"toolCall","id":"call-1","name":"read_file","arguments":{"path":"secret"}},
            {"type":"text","text":"The navigator is ready to review."}
        ]}),
        json!({"role":"tool","toolCallId":"call-1","content":"raw tool output must stay private","isError":false}),
    ];
    let older = vec![
        json!({"role":"user","content":"Audit keyboard navigation"}),
        json!({"role":"assistant","content":[{"type":"text","text":"Keyboard navigation is covered."}]}),
    ];

    vec![
        MockSession {
            id: "mock-session-complex-task".into(),
            model: "mock-model".into(),
            started_at: "2026-07-14T09:55:00.000Z".into(),
            started_at_local: "7/14/2026, 5:55:00 PM".into(),
            message_ids: assign_ids(complex.len()),
            messages: complex,
            todos: vec![
                json!({"id":"complex-map","content":"Map retry behavior and reproduction path","status":"completed"}),
                json!({"id":"complex-implement","content":"Bound retries and clean up cancellation","status":"completed"}),
                json!({"id":"complex-ui","content":"Expose an actionable paused state","status":"completed"}),
                json!({"id":"complex-verify","content":"Run focused and full desktop verification","status":"completed"}),
            ],
            persistence: "saved",
            checkpoint_error: None,
        },
        MockSession {
            id: "mock-session-paginated-history".into(),
            model: "mock-model".into(),
            started_at: "2026-07-14T09:30:00.000Z".into(),
            started_at_local: "7/14/2026, 5:30:00 PM".into(),
            message_ids: assign_ids(paginated.len()),
            messages: paginated,
            todos: Vec::new(),
            persistence: "saved",
            checkpoint_error: None,
        },
        MockSession {
            id: "mock-session-rich-history".into(),
            model: "mock-model".into(),
            started_at: "2026-07-14T08:45:00.000Z".into(),
            started_at_local: "7/14/2026, 4:45:00 PM".into(),
            message_ids: assign_ids(rich.len()),
            messages: rich,
            todos: vec![
                json!({"id":"rich-done","content":"Restore textual conversation history","status":"completed"}),
                json!({"id":"rich-active","content":"Inspect the rich transcript visually","status":"in_progress"}),
                json!({"id":"rich-next","content":"Test filtering and session switching","status":"pending"}),
                json!({"id":"rich-cancelled","content":"Render raw tool payloads","status":"cancelled"}),
            ],
            persistence: "saved",
            checkpoint_error: None,
        },
        MockSession {
            id: "mock-session-recent".into(),
            model: "mock-model".into(),
            started_at: "2026-07-14T08:30:00.000Z".into(),
            started_at_local: "7/14/2026, 4:30:00 PM".into(),
            message_ids: assign_ids(recent.len()),
            messages: recent,
            todos: vec![
                json!({"id":"mock-todo","content":"Verify restored session UI","status":"in_progress"}),
            ],
            persistence: "saved",
            checkpoint_error: None,
        },
        MockSession {
            id: "mock-session-older".into(),
            model: "mock-reference".into(),
            started_at: "2026-07-13T05:15:00.000Z".into(),
            started_at_local: "7/13/2026, 1:15:00 PM".into(),
            message_ids: assign_ids(older.len()),
            messages: older,
            todos: Vec::new(),
            persistence: "saved",
            checkpoint_error: None,
        },
    ]
}

fn complex_task_messages() -> Vec<Value> {
    let mut messages = vec![json!({
        "role":"user",
        "at":1_784_496_000_000_i64,
        "content":"The background sync panel retries forever after a transient API failure. Trace the retry behavior, fix it, and leave the repository in a verified state."
    })];
    push_tool_use(
        &mut messages,
        "complex-tool-001",
        "list_directory",
        json!({"path":"apps/macos/Sources"}),
        "RailgunCore/\nRailgunServices/\nRailgunUI/\nRailgunX/\n",
    );
    push_tool_use(
        &mut messages,
        "complex-tool-002",
        "read_file",
        json!({"path":"apps/macos/Sources/RailgunServices/BackgroundAutomation.swift"}),
        "The retry loop has no maximum attempt count.",
    );
    push_tool_use(
        &mut messages,
        "complex-tool-003",
        "write_file",
        json!({"path":"apps/macos/Sources/RailgunServices/BackgroundAutomation.swift","patch":"cap retries at three with exponential backoff"}),
        "Updated the background automation service.",
    );
    push_tool_use(
        &mut messages,
        "complex-tool-004",
        "write_file",
        json!({"path":"apps/macos/Tests/RailgunXTests/BackgroundAutomationTests.swift","patch":"cover exhausted retries"}),
        "Added native regression coverage.",
    );
    messages.push(json!({"role":"assistant","at":1_784_496_021_000_i64,"content":[{"type":"text","text":"The retry loop has no terminal state, so I added bounded, retry-aware polling and an explicit paused state. The second read confirmed the obsolete module is gone; the replacement path is now covered."}]}));
    messages.push(json!({"role":"user","content":"Keep the retry responsive, but don’t let one broken connection spin forever or hide the error."}));
    push_tool_use(
        &mut messages,
        "complex-tool-012",
        "read_file",
        json!({"path":"apps/macos/Sources/RailgunUI/TaskShell.swift"}),
        "The native task shell shows the retry state and recovery action.",
    );
    messages.push(json!({"role":"assistant","content":[{"type":"text","text":"Retries now stop after the configured limit, preserve the error detail, and offer a single manual recovery action instead of silently scheduling another attempt."}]}));
    messages.push(json!({"role":"user","content":"Before you run everything, check whether the timeout cleanup can leak when the user closes the window mid-retry."}));
    push_tool_use(
        &mut messages,
        "complex-tool-018",
        "read_file",
        json!({"path":"apps/macos/Sources/RailgunServices/BackgroundAutomation.swift"}),
        "The scheduled retry needs cancellation-safe cleanup.",
    );
    push_tool_use(
        &mut messages,
        "complex-tool-019",
        "write_file",
        json!({"path":"apps/macos/Sources/RailgunServices/BackgroundAutomation.swift","patch":"clear scheduled retry on cancellation"}),
        "Updated the native service.",
    );
    push_tool_use(
        &mut messages,
        "complex-tool-020",
        "run_shell_command",
        json!({"command":"./apps/macos/scripts/validate-project.sh"}),
        "PASS native validation",
    );
    messages.push(json!({"role":"assistant","content":[{"type":"text","text":"Good catch. The retry timer outlived the panel’s unsubscribe path, so I tightened the cancellation guard and added a regression test for disposal during the backoff window."}]}));
    messages.push(json!({"role":"user","content":"Check the surrounding contracts too. I don’t want the new status to break preload validation or session restoration."}));
    push_tool_use(
        &mut messages,
        "complex-tool-023",
        "run_shell_command",
        json!({"command":"pnpm run typecheck && pnpm run test"}),
        "PASS TypeScript verification",
    );
    push_tool_use(
        &mut messages,
        "complex-tool-024",
        "run_shell_command",
        json!({"command":"git diff --check"}),
        "No whitespace errors.",
    );
    messages.push(json!({"role":"assistant","content":[{"type":"text","text":"The new state crosses the shared schema, main-process service, and renderer only. The IPC boundary and saved-session projection both validate it without a persistence migration."}]}));
    messages.push(json!({"role":"user","content":"Did you test the visual copy as well as the state transition?"}));
    push_tool_use(
        &mut messages,
        "complex-tool-029",
        "run_shell_command",
        json!({"command":"./apps/macos/scripts/validate-project.sh"}),
        "PASS native test suite",
    );
    messages.push(json!({"role":"assistant","content":[{"type":"text","text":"Yes. The panel now says “Sync paused after 3 attempts” and offers a single manual Retry action. It preserves the last error in the detail text without exposing transport internals."}]}));
    messages.push(
        json!({"role":"user","content":"Summarize the task and call out any remaining risk."}),
    );
    messages.push(json!({"role":"assistant","content":[{"type":"text","text":"Implemented bounded, retry-aware polling for background automation with cancellation-safe backoff and focused native coverage."}]}));
    messages
}

fn push_tool_use(messages: &mut Vec<Value>, id: &str, name: &str, arguments: Value, result: &str) {
    messages.push(json!({"role":"assistant","content":[{"type":"toolCall","id":id,"name":name,"arguments":arguments}]}));
    messages.push(json!({"role":"tool","toolCallId":id,"content":result,"isError":false}));
}

fn session_summary(session: &MockSession) -> Value {
    json!({"id":session.id,"model":session.model,"startedAtLocal":session.started_at_local,"messageCount":session.messages.len(),"firstUserPreview":session.messages.iter().find(|message|message["role"]=="user").and_then(|message|message["content"].as_str()).unwrap_or_default().chars().take(500).collect::<String>()})
}

fn branchable_message_ids(session: &MockSession) -> std::collections::HashSet<i64> {
    let mut result = std::collections::HashSet::new();
    let mut cursor = 0;
    loop {
        let page = transcript::page(
            &session.id,
            &session.messages,
            cursor,
            100,
            Some(&session.message_ids),
            false,
        );
        for message in page["messages"].as_array().into_iter().flatten() {
            if message["role"] != "tool" && message["branchable"] == true {
                if let Some(message_id) = message["messageId"].as_i64() {
                    result.insert(message_id);
                }
            }
        }
        let Some(next) = page["nextCursor"].as_u64() else {
            break;
        };
        cursor = next as usize;
    }
    result
}

fn normalize_cron(schedule: &str) -> Option<String> {
    let normalized = schedule.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.split(' ').count() != 5 || croner::Cron::from_str(&normalized).is_err() {
        return None;
    }
    Some(normalized)
}

fn cron_job_response(command: &Map<String, Value>, job: &Value) -> Value {
    if command.get("includeJob").and_then(Value::as_bool) == Some(false) {
        json!({"jobId":job["id"]})
    } else {
        json!({"job":job})
    }
}

fn mock_models() -> Vec<Value> {
    vec![
        json!({"id":"mock-model","name":"Mock Model","provider":"devin","baseUrl":"https://mock.invalid","input":["text","image"],"supportsTools":true,"reasoning":true,"contextWindow":200000,"maxTokens":16000}),
        json!({"id":"mock-reference","name":"Mock Reference","provider":"devin","baseUrl":"https://mock.invalid","input":["text"],"supportsTools":true,"reasoning":false,"contextWindow":100000,"maxTokens":8000}),
    ]
}

fn safe_mcp(servers: &Map<String, Value>) -> Vec<Value> {
    servers
        .iter()
        .map(|(name, server)| {
            let mut env = server["env"]
                .as_object()
                .map(|env| {
                    env.keys()
                        .map(|name| json!({"name":name,"present":true}))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            env.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            json!({"name":name,"command":server["command"],"args":server["args"],"env":env})
        })
        .collect()
}

fn mock_skills(body: bool) -> Vec<Value> {
    [
        json!({"name":"desktop-testing","description":"Test desktop flows with deterministic fixtures.","disableModelInvocation":false,"body":"# Desktop testing\n\nUse deterministic scenarios and assert renderer-safe boundaries."}),
        json!({"name":"release-checklist","description":"Review release readiness without automatic model invocation.","disableModelInvocation":true,"body":"# Release checklist\n\nVerify tests, packaging, and release notes."}),
    ]
    .into_iter()
    .map(|mut skill| {
        if !body {
            skill.as_object_mut().unwrap().remove("body");
        }
        skill
    })
    .collect()
}

fn instruction_files(content: bool) -> Vec<Value> {
    [
        ("soul", "~/.railgun/SOUL.md", "active"),
        ("railgun-dotfile", "~/.railgun.md", "active"),
        ("railgun", "~/RAILGUN.md", "missing"),
        ("agents-upper", "~/AGENTS.md", "shadowed"),
        ("agents-lower", "~/agents.md", "missing"),
        ("claude-upper", "~/CLAUDE.md", "missing"),
        ("claude-lower", "~/claude.md", "missing"),
        ("cursor-rules", "~/.cursorrules", "missing"),
    ]
    .into_iter()
    .map(|(id, label, status)| {
        let mut value = json!({"id":id,"label":label,"status":status});
        if content {
            value["content"] = Value::String(match id {
                "soul" => "# Soul\n\nBe clear and practical.\n".into(),
                "railgun-dotfile" => "# Global instructions\n\nUse focused changes.\n".into(),
                "agents-upper" => "# Agent instructions\n".into(),
                _ => String::new(),
            });
        }
        value
    })
    .collect()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn fresh_active_session(id: &str, model: &str) -> MockSession {
    MockSession {
        id: id.into(),
        model: model.into(),
        started_at: now(),
        started_at_local: Utc::now().format("%-m/%-d/%Y, %-I:%M:%S %p").to_string(),
        messages: Vec::new(),
        todos: Vec::new(),
        persistence: "unsaved",
        checkpoint_error: None,
        message_ids: Vec::new(),
    }
}
fn upsert_session(sessions: &mut Vec<MockSession>, session: MockSession) {
    if let Some(index) = sessions.iter().position(|value| value.id == session.id) {
        sessions[index] = session
    } else {
        sessions.insert(0, session)
    }
}
async fn write_fragmented_frame(frame: &Value) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    let mut line = serde_json::to_vec(frame)?;
    line.push(b'\n');
    let split = (line.len() / 2).max(1);
    stdout.write_all(&line[..split]).await?;
    stdout.flush().await?;
    tokio::time::sleep(Duration::from_millis(8)).await;
    stdout.write_all(&line[split..]).await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_mock(
        scenario: &str,
    ) -> (
        Mock,
        mpsc::UnboundedReceiver<OutputFrame>,
        mpsc::UnboundedReceiver<Scheduled>,
    ) {
        let (output, frames) = mpsc::unbounded_channel();
        let (scheduled, actions) = mpsc::unbounded_channel();
        let cancelled_prompts = Arc::new(Mutex::new(HashSet::new()));
        (
            Mock::new(
                Scenario::parse(scenario).expect("test scenario should be registered"),
                output,
                cancelled_prompts,
                scheduled,
            ),
            frames,
            actions,
        )
    }

    fn drain_frames(frames: &mut mpsc::UnboundedReceiver<OutputFrame>) -> Vec<Value> {
        let mut result = Vec::new();
        while let Ok(frame) = frames.try_recv() {
            result.push(frame.value);
        }
        result
    }

    #[test]
    fn mcp_secrets_are_redacted() {
        let (mock, _, _) = test_mock("ready-idle");
        assert!(
            !serde_json::to_string(&safe_mcp(&mock.mcp))
                .unwrap()
                .contains("mock-stored-secret")
        );
    }

    #[test]
    fn saved_fixture_corpus_matches_the_retired_mock() {
        let sessions = saved_sessions();
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            [
                "mock-session-complex-task",
                "mock-session-paginated-history",
                "mock-session-rich-history",
                "mock-session-recent",
                "mock-session-older",
            ]
        );
        assert_eq!(sessions[0].messages.len(), 34);
        assert_eq!(sessions[1].messages.len(), 202);
        assert_eq!(sessions[2].messages.len(), 10);
        assert_eq!(sessions[3].messages.len(), 3);
        assert_eq!(sessions[4].messages.len(), 2);
        assert_eq!(sessions[0].todos.len(), 4);
        assert_eq!(sessions[2].todos.len(), 4);
        assert_eq!(
            sessions[2].messages[3]["content"][0]["arguments"]["token"],
            "must-not-cross-boundary"
        );
    }

    #[tokio::test]
    async fn paginated_transcript_and_branch_boundaries_cover_all_pages() {
        let (mut mock, mut frames, _) = test_mock("ready-idle");
        mock.handle(
            json!({"id":"load","type":"session_load","sessionId":"mock-session-paginated-history"})
                .as_object()
                .unwrap()
                .clone(),
        )
        .await
        .unwrap();
        let _ = drain_frames(&mut frames);
        mock.handle(
            json!({"id":"page","type":"session_transcript","sessionId":"mock-session-paginated-history","cursor":0,"limit":100})
                .as_object()
                .unwrap()
                .clone(),
        )
        .await
        .unwrap();
        let page = drain_frames(&mut frames).pop().unwrap();
        assert_eq!(page["data"]["messages"].as_array().unwrap().len(), 100);
        assert_eq!(page["data"]["nextCursor"], 100);
        assert_eq!(branchable_message_ids(&mock.active).len(), 101);
    }

    #[tokio::test]
    async fn mcp_upsert_patches_and_redacts_environment_values() {
        let (mut mock, mut frames, _) = test_mock("ready-idle");
        mock.handle(
            json!({
                "id":"mcp",
                "type":"mcp_upsert",
                "name":"docs",
                "command":"/new/server",
                "env":{"DOCS_TOKEN":null,"NEW_SECRET":"hidden"}
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .await
        .unwrap();
        let response = drain_frames(&mut frames).pop().unwrap();
        assert_eq!(response["data"]["server"]["command"], "/new/server");
        assert_eq!(response["data"]["server"]["args"][0], "--stdio");
        let encoded = serde_json::to_string(&response).unwrap();
        assert!(encoded.contains("NEW_SECRET"));
        assert!(!encoded.contains("hidden"));
        assert!(!encoded.contains("DOCS_TOKEN"));
    }

    #[tokio::test]
    async fn prompt_queue_activity_and_cancellation_frames_are_not_collapsed() {
        let (mut mock, mut frames, mut actions) = test_mock("cancellation");
        mock.prompt(Some("prompt".into()), "work");
        mock.enqueue(
            "steer",
            Some("steer".into()),
            json!({"message":"redirect"}).as_object().unwrap(),
        );
        tokio::time::sleep(Duration::from_millis(35)).await;
        while let Ok(action) = actions.try_recv() {
            mock.handle_scheduled(action);
        }
        let frames_before_abort = drain_frames(&mut frames);
        assert!(
            frames_before_abort
                .iter()
                .any(|frame| frame["type"] == "queue_update" && frame["steering"][0] == "redirect")
        );
        assert!(
            frames_before_abort
                .iter()
                .any(|frame| frame["type"] == "message_start"
                    && frame["message"]["content"] == "redirect")
        );

        mock.handle(
            json!({"id":"abort","type":"abort"})
                .as_object()
                .unwrap()
                .clone(),
        )
        .await
        .unwrap();
        let aborted = drain_frames(&mut frames);
        assert_eq!(
            aborted
                .iter()
                .filter_map(|frame| frame["type"].as_str())
                .collect::<Vec<_>>(),
            ["queue_update", "agent_end", "response", "response"]
        );
        assert_eq!(
            mock.active.messages.last().unwrap()["content"][0]["text"],
            "The mock request was stopped."
        );
    }

    #[tokio::test]
    async fn running_session_errors_take_precedence_over_store_failures() {
        let (mut mock, mut frames, _) = test_mock("store-error");
        mock.prompt(Some("prompt".into()), "work");
        let _ = drain_frames(&mut frames);
        mock.handle(
            json!({
                "id":"load",
                "type":"session_load",
                "sessionId":"mock-session-recent"
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .await
        .unwrap();
        let response = drain_frames(&mut frames).pop().unwrap();
        assert_eq!(
            response["error"],
            "cannot load a session while agent is running"
        );
    }
}
