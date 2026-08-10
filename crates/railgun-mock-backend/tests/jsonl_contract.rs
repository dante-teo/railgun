use serde_json::{Value, json};
use std::process::Stdio;
use std::time::Instant;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{Duration, timeout},
};

struct MockProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Lines<BufReader<ChildStdout>>,
}

impl MockProcess {
    async fn start(scenario: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_railgun-mock-backend"))
            .arg(scenario)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("mock backend should start");
        let stdin = child.stdin.take().expect("mock stdin should be piped");
        let stdout = child.stdout.take().expect("mock stdout should be piped");
        Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout).lines(),
        }
    }

    async fn send(&mut self, frame: Value) {
        let stdin = self.stdin.as_mut().expect("mock stdin should be open");
        stdin
            .write_all(serde_json::to_string(&frame).unwrap().as_bytes())
            .await
            .unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();
    }

    async fn next_line(&mut self) -> String {
        timeout(Duration::from_secs(3), self.stdout.next_line())
            .await
            .expect("timed out waiting for mock output")
            .expect("mock stdout read should succeed")
            .expect("mock stdout closed unexpectedly")
    }

    async fn next(&mut self) -> Value {
        serde_json::from_str(&self.next_line().await).expect("mock output should be JSON")
    }

    async fn response(&mut self, id: &str) -> Value {
        loop {
            let frame = self.next().await;
            if frame["type"] == "response" && frame["id"] == id {
                return frame;
            }
        }
    }

    async fn stop(mut self) -> std::process::ExitStatus {
        self.stdin.take();
        match timeout(Duration::from_secs(6), self.child.wait()).await {
            Ok(result) => result.expect("mock process wait should succeed"),
            Err(_) => {
                self.child
                    .kill()
                    .await
                    .expect("mock process should be killed");
                panic!("mock process did not stop after stdin closed");
            }
        }
    }
}

#[tokio::test]
async fn model_selection_updates_the_active_task_and_future_default() {
    let mut mock = MockProcess::start("ready-idle").await;

    mock.send(json!({"id":"models","type":"get_available_models"}))
        .await;
    let models = mock.response("models").await;
    assert_eq!(models["data"]["models"][0]["name"], "Mock Model");
    assert_eq!(models["data"]["models"][1]["name"], "Mock Reference");

    mock.send(json!({
        "id":"active",
        "type":"set_model",
        "modelId":"mock-reference"
    }))
    .await;
    assert_eq!(mock.response("active").await["success"], true);

    mock.send(json!({"id":"state","type":"get_state"})).await;
    let state = mock.response("state").await;
    assert_eq!(state["data"]["model"], "mock-reference");
    assert!(state["data"]["latestUsage"].is_null());

    mock.send(json!({
        "id":"default",
        "type":"config_update",
        "patch":{"model":"mock-reference"}
    }))
    .await;
    assert_eq!(
        mock.response("default").await["data"]["config"]["model"],
        "mock-reference"
    );

    mock.send(json!({"id":"config","type":"config_get"})).await;
    assert_eq!(
        mock.response("config").await["data"]["config"]["model"],
        "mock-reference"
    );
    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn saved_sessions_pagination_and_private_projection_match_the_jsonl_contract() {
    let mut mock = MockProcess::start("ready-idle").await;
    mock.send(json!({"id":"init","type":"initialize","version":1}))
        .await;
    let initialized = mock.response("init").await;
    assert_eq!(initialized["data"]["version"], 1);
    assert_eq!(
        initialized["data"]["capabilities"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
    assert!(
        initialized["data"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability == "model_catalog.refresh")
    );

    mock.send(json!({"id":"refresh-models","type":"refresh_model_catalog"}))
        .await;
    let refreshed = mock.response("refresh-models").await;
    assert!(refreshed["success"].as_bool().unwrap());
    assert!(!refreshed["data"]["models"].as_array().unwrap().is_empty());

    mock.send(json!({"id":"state","type":"get_state"})).await;
    let state = mock.response("state").await;
    assert_eq!(state["data"]["persistence"], "unsaved");
    assert_eq!(
        state["data"]["latestUsage"],
        json!({"inputTokens":72000,"outputTokens":8000})
    );
    assert!(state["data"].get("checkpointError").is_none());

    mock.send(json!({"id":"list","type":"session_list"})).await;
    let sessions = mock.response("list").await;
    assert_eq!(
        sessions["data"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "mock-session-agent-activity",
            "mock-session-complex-task",
            "mock-session-paginated-history",
            "mock-session-rich-history",
            "mock-session-recent",
            "mock-session-older",
        ]
    );
    assert_eq!(sessions["data"]["sessions"][0]["messageCount"], 2);
    assert_eq!(sessions["data"]["sessions"][1]["messageCount"], 34);
    assert_eq!(sessions["data"]["sessions"][2]["messageCount"], 202);
    assert!(
        sessions["data"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|session| session["lastMessageAt"].as_str().is_some())
    );

    mock.send(json!({
        "id":"load-page",
        "type":"session_load",
        "sessionId":"mock-session-paginated-history",
        "includeMessages":false
    }))
    .await;
    let loaded = mock.response("load-page").await;
    assert!(loaded["data"].get("messages").is_none());
    mock.send(json!({"id":"loaded-state","type":"get_state"}))
        .await;
    let loaded_state = mock.response("loaded-state").await;
    assert_eq!(
        loaded_state["data"]["latestUsage"],
        json!({"inputTokens":165000,"outputTokens":20000})
    );
    mock.send(json!({
        "id":"page",
        "type":"session_transcript",
        "sessionId":"mock-session-paginated-history",
        "cursor":0,
        "limit":100
    }))
    .await;
    let page = mock.response("page").await;
    assert_eq!(page["data"]["messages"].as_array().unwrap().len(), 100);
    assert_eq!(page["data"]["nextCursor"], 100);
    assert_eq!(page["data"]["messages"][0]["messageId"], 1036);

    mock.send(json!({
        "id":"load-rich",
        "type":"session_load",
        "sessionId":"mock-session-rich-history",
        "includeMessages":false
    }))
    .await;
    mock.response("load-rich").await;
    mock.send(json!({
        "id":"rich",
        "type":"session_transcript",
        "sessionId":"mock-session-rich-history"
    }))
    .await;
    let rich = mock.response("rich").await;
    let projected = serde_json::to_string(&rich).unwrap();
    assert!(!projected.contains("mock-private-signature"));
    assert!(!projected.contains("must-not-cross-boundary"));
    assert!(!projected.contains("sensitive raw provider payload"));

    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn cancellation_purges_prompt_frames_and_preserves_terminal_order() {
    let mut mock = MockProcess::start("cancellation").await;
    mock.send(json!({"id":"prompt","type":"prompt","message":"Keep working"}))
        .await;
    assert_eq!(mock.next().await["type"], "agent_start");

    mock.send(json!({"id":"steer","type":"steer","message":"Change direction"}))
        .await;
    mock.send(json!({"id":"follow","type":"follow_up","message":"Then verify"}))
        .await;
    mock.send(json!({"id":"abort","type":"abort"})).await;

    let mut frames = Vec::new();
    loop {
        let frame = mock.next().await;
        let done = frame["type"] == "response" && frame["id"] == "abort";
        frames.push(frame);
        if done {
            break;
        }
    }
    let terminal = &frames[frames.len() - 4..];
    assert_eq!(terminal[0]["type"], "queue_update");
    assert_eq!(terminal[0]["steering"], json!([]));
    assert_eq!(terminal[0]["followUp"], json!([]));
    assert_eq!(terminal[1]["type"], "agent_end");
    assert_eq!(terminal[2]["command"], "prompt");
    assert_eq!(terminal[2]["id"], "prompt");
    assert_eq!(terminal[3]["command"], "abort");
    let terminal_start = frames.len() - 4;
    assert!(
        frames[terminal_start..]
            .iter()
            .all(|frame| frame["type"] != "message_update")
    );

    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn skills_list_get_create_update_and_delete_match_the_jsonl_contract() {
    let mut mock = MockProcess::start("ready-idle").await;

    mock.send(json!({"id":"list","type":"skills_list"})).await;
    let listed = mock.response("list").await;
    assert_eq!(listed["success"], true);
    assert!(
        listed["data"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|skill| {
                skill.get("body").is_none()
                    && skill.get("name").is_some()
                    && skill.get("description").is_some()
            })
    );

    mock.send(json!({"id":"get","type":"skill_get","name":"desktop-testing"}))
        .await;
    let fetched = mock.response("get").await;
    assert_eq!(
        fetched["data"]["skill"]["body"],
        "# Desktop testing\n\nUse deterministic scenarios and assert renderer-safe boundaries."
    );

    mock.send(json!({
        "id":"create",
        "type":"skill_create",
        "name":"contract-skill",
        "description":"Contract coverage",
        "body":"Run the contract.",
        "disableModelInvocation":true
    }))
    .await;
    let created = mock.response("create").await;
    assert_eq!(created["data"]["skill"]["name"], "contract-skill");
    assert_eq!(created["data"]["skill"]["disableModelInvocation"], true);

    mock.send(json!({
        "id":"update",
        "type":"skill_update",
        "name":"contract-skill",
        "description":"Updated contract coverage",
        "body":"Run the updated contract.",
        "disableModelInvocation":false
    }))
    .await;
    let updated = mock.response("update").await;
    assert_eq!(
        updated["data"]["skill"]["description"],
        "Updated contract coverage"
    );
    assert_eq!(
        updated["data"]["skill"]["body"],
        "Run the updated contract."
    );

    mock.send(json!({"id":"delete","type":"skill_delete","name":"contract-skill"}))
        .await;
    assert_eq!(mock.response("delete").await["success"], true);
    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn interactions_validate_correlation_and_settle_the_original_prompt() {
    let mut mock = MockProcess::start("approval").await;
    mock.send(json!({"id":"prompt","type":"prompt","message":"Run it"}))
        .await;
    assert_eq!(mock.next().await["type"], "agent_start");
    let request = mock.next().await;
    assert_eq!(request["type"], "approval_request");
    assert_eq!(request["requestId"], "mock-approval-1");
    assert_eq!(request["command"], "sudo mock-command");

    mock.send(json!({
        "id":"wrong",
        "type":"approval_response",
        "requestId":"wrong-id",
        "approved":true
    }))
    .await;
    let wrong = mock.response("wrong").await;
    assert_eq!(wrong["success"], false);
    assert_eq!(wrong["error"], "unknown or mismatched interaction request");

    mock.send(json!({
        "id":"approve",
        "type":"approval_response",
        "requestId":"mock-approval-1",
        "approved":true
    }))
    .await;
    assert_eq!(mock.response("approve").await["success"], true);
    assert_eq!(mock.next().await["type"], "agent_end");
    let settled = mock.next().await;
    assert_eq!(settled["command"], "prompt");
    assert_eq!(settled["id"], "prompt");
    assert_eq!(settled["success"], true);

    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn store_errors_compaction_and_mcp_redaction_retain_retired_mock_semantics() {
    let mut failed_store = MockProcess::start("store-error").await;
    failed_store
        .send(json!({"id":"state","type":"get_state"}))
        .await;
    let initial = failed_store.response("state").await;
    assert_eq!(initial["data"]["persistence"], "unsaved");
    assert!(initial["data"].get("checkpointError").is_none());
    failed_store
        .send(json!({"id":"list","type":"memory_list"}))
        .await;
    assert_eq!(failed_store.response("list").await["success"], false);
    failed_store
        .send(json!({
            "id":"create",
            "type":"memory_create",
            "content":"still mutable",
            "category":"fact"
        }))
        .await;
    assert_eq!(failed_store.response("create").await["success"], true);
    assert!(failed_store.stop().await.success());

    let mut mock = MockProcess::start("ready-idle").await;
    mock.send(json!({
        "id":"load",
        "type":"session_load",
        "sessionId":"mock-session-recent"
    }))
    .await;
    mock.response("load").await;
    mock.send(json!({"id":"compact","type":"compact"})).await;
    assert_eq!(mock.response("compact").await["success"], true);
    mock.send(json!({"id":"state","type":"get_state"})).await;
    assert_eq!(mock.response("state").await["data"]["messageCount"], 1);
    mock.send(json!({"id":"messages","type":"get_messages"}))
        .await;
    assert_eq!(
        mock.response("messages").await["data"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    mock.send(json!({
        "id":"mcp",
        "type":"mcp_upsert",
        "name":"docs",
        "command":"/new/server",
        "args":["--new",7,"--safe"],
        "env":{"DOCS_TOKEN":null,"NEW_SECRET":"must-not-render"}
    }))
    .await;
    let mcp = mock.response("mcp").await;
    assert_eq!(mcp["data"]["server"]["args"], json!(["--new", "--safe"]));
    let encoded = serde_json::to_string(&mcp).unwrap();
    assert!(encoded.contains("NEW_SECRET"));
    assert!(!encoded.contains("must-not-render"));
    assert!(!encoded.contains("DOCS_TOKEN"));

    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn startup_failure_scenarios_keep_their_frames_and_exit_codes() {
    let mut authentication = MockProcess::start("authentication-required").await;
    let startup = authentication.next().await;
    assert_eq!(startup["type"], "startup_status");
    assert_eq!(startup["status"], "authentication_required");
    authentication.stdin.take();
    assert_eq!(authentication.child.wait().await.unwrap().code(), Some(1));

    let mut malformed = MockProcess::start("malformed-output").await;
    malformed
        .send(json!({"id":"init","type":"initialize","version":1}))
        .await;
    assert_eq!(malformed.next_line().await, "{malformed-json");
    assert!(malformed.stop().await.success());

    let mut crashed = MockProcess::start("crash-before-ready").await;
    crashed.stdin.take();
    assert_eq!(crashed.child.wait().await.unwrap().code(), Some(17));
}

#[tokio::test]
async fn every_remaining_scenario_exercises_its_distinct_process_contract() {
    let mut delayed = MockProcess::start("delayed-startup").await;
    let started = Instant::now();
    delayed
        .send(json!({"id":"init","type":"initialize","version":1}))
        .await;
    assert_eq!(delayed.response("init").await["success"], true);
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert!(delayed.stop().await.success());

    let mut rejected = MockProcess::start("command-rejection").await;
    rejected
        .send(json!({"id":"state","type":"get_state"}))
        .await;
    let response = rejected.response("state").await;
    assert_eq!(response["success"], false);
    assert_eq!(response["error"], "mock rejected get_state");
    assert!(rejected.stop().await.success());

    let mut handshake = MockProcess::start("handshake-failure").await;
    handshake
        .send(json!({"id":"init","type":"initialize","version":1}))
        .await;
    let response = handshake.response("init").await;
    assert_eq!(response["success"], false);
    assert_eq!(response["error"], "mock protocol mismatch");
    assert!(handshake.stop().await.success());

    let mut disconnected = MockProcess::start("disconnect-after-ready").await;
    disconnected
        .send(json!({"id":"state","type":"get_state"}))
        .await;
    assert_eq!(disconnected.response("state").await["success"], true);
    assert_eq!(
        timeout(Duration::from_secs(2), disconnected.child.wait())
            .await
            .unwrap()
            .unwrap()
            .code(),
        Some(23)
    );

    let mut empty = MockProcess::start("empty-stores").await;
    for (id, command, field) in [
        ("sessions", "session_list", "sessions"),
        ("memories", "memory_list", "memories"),
        ("cron", "cron_list", "jobs"),
        ("mcp", "mcp_list", "servers"),
        ("skills", "skills_list", "skills"),
    ] {
        empty.send(json!({"id":id,"type":command})).await;
        assert_eq!(
            empty.response(id).await["data"][field]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
    assert!(empty.stop().await.success());

    let mut models = MockProcess::start("empty-model-catalog").await;
    models
        .send(json!({"id":"models","type":"get_available_models"}))
        .await;
    assert!(
        models.response("models").await["data"]["models"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(models.stop().await.success());

    let mut compact = MockProcess::start("slow-compaction").await;
    compact
        .send(json!({
            "id":"load",
            "type":"session_load",
            "sessionId":"mock-session-recent"
        }))
        .await;
    compact.response("load").await;
    let started = Instant::now();
    compact.send(json!({"id":"compact","type":"compact"})).await;
    assert_eq!(compact.response("compact").await["success"], true);
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert!(compact.stop().await.success());
}

#[tokio::test]
async fn agent_activity_emits_streamed_subagent_updates_in_the_complete_ordered_timeline() {
    let mut mock = MockProcess::start("agent-activity").await;
    mock.send(json!({"id":"prompt","type":"prompt","message":"Show activity"}))
        .await;
    let start = mock.next().await;
    assert_eq!(start["type"], "agent_start");
    let run_id = start["runId"].as_str().unwrap().to_owned();

    let mut event_types = Vec::new();
    loop {
        let frame = mock.next().await;
        if frame["type"] == "response" && frame["id"] == "prompt" {
            break;
        }
        if (frame["type"] == "message_start" && frame["message"]["role"] == "user")
            || frame["type"] == "agent_end"
        {
            assert_eq!(frame["runId"], run_id);
        }
        event_types.push(frame["type"].as_str().unwrap().to_owned());
    }
    assert_eq!(
        event_types,
        [
            "tool_execution_start",
            "subagent_start",
            "subagent_start",
            "tool_execution_start",
            "tool_execution_start",
            "moa_reference_start",
            "tool_execution_end",
            "tool_execution_end",
            "tool_execution_end",
            "moa_reference_end",
            "moa_aggregating",
            "message_start",
            "subagent_update",
            "subagent_update",
            "subagent_end",
            "message_start",
            "subagent_update",
            "subagent_update",
            "subagent_end",
            "message_start",
            "message_update",
            "message_end",
            "turn_end",
            "agent_end",
        ]
    );
    mock.send(json!({"id":"state","type":"get_state"})).await;
    assert_eq!(
        mock.response("state").await["data"]["todos"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn agent_activity_starts_automatically_during_initial_state_hydration() {
    let mut mock = MockProcess::start("agent-activity").await;
    mock.send(json!({"id":"state","type":"get_state"})).await;

    let state = mock.next().await;
    assert_eq!(state["type"], "response");
    assert_eq!(state["id"], "state");
    assert_eq!(state["data"]["running"], false);
    let start = mock.next().await;
    assert_eq!(start["type"], "agent_start");
    assert!(start["runId"].as_str().is_some());

    let mut event_types = Vec::new();
    loop {
        let frame = mock.next().await;
        let event_type = frame["type"].as_str().unwrap();
        event_types.push(event_type.to_owned());
        if event_type == "agent_end" {
            break;
        }
    }
    assert!(event_types.contains(&"subagent_update".to_owned()));
    assert_eq!(event_types.last().map(String::as_str), Some("agent_end"));

    tokio::time::sleep(Duration::from_millis(100)).await;
    mock.send(json!({"id":"settled","type":"get_state"})).await;
    let settled = mock.response("settled").await;
    assert_eq!(settled["data"]["running"], false);
    assert_eq!(settled["data"]["todos"].as_array().unwrap().len(), 2);
    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn ready_idle_activity_demo_task_plays_when_loaded_and_hydrated() {
    let mut mock = MockProcess::start("ready-idle").await;
    mock.send(json!({
        "id":"open",
        "type":"session_load",
        "sessionId":"mock-session-agent-activity",
        "includeMessages":false
    }))
    .await;
    assert_eq!(mock.response("open").await["success"], true);

    mock.send(json!({"id":"state","type":"get_state"})).await;
    let state = mock.next().await;
    assert_eq!(state["id"], "state");
    assert_eq!(state["data"]["todos"].as_array().unwrap().len(), 2);
    let start = mock.next().await;
    assert_eq!(start["type"], "agent_start");
    let run_id = start["runId"].as_str().unwrap().to_owned();

    let mut saw_advisor = false;
    let mut streamed_subagent_updates = 0;
    loop {
        let frame = mock.next().await;
        match frame["type"].as_str().unwrap() {
            "message_start" if frame["message"]["role"] == "user" => {
                assert_eq!(frame["runId"], run_id);
                saw_advisor = true;
            }
            "subagent_update" => streamed_subagent_updates += 1,
            "agent_end" => {
                assert_eq!(frame["runId"], run_id);
                break;
            }
            _ => {}
        }
    }
    assert!(saw_advisor);
    assert_eq!(streamed_subagent_updates, 4);
    assert!(mock.stop().await.success());
}

#[tokio::test]
async fn clarification_variants_keep_free_text_and_bounded_choice_shapes() {
    for (scenario, expected_question, expected_choices) in [
        (
            "clarification",
            "What should the mock use?",
            None::<Vec<&str>>,
        ),
        (
            "clarification-free-text",
            "What should the mock use?",
            None::<Vec<&str>>,
        ),
        (
            "clarification-choice",
            "Which option should the mock use?",
            Some(vec!["Use the fast path", "Use the safe path"]),
        ),
    ] {
        let mut mock = MockProcess::start(scenario).await;
        mock.send(json!({"id":"prompt","type":"prompt","message":"Choose"}))
            .await;
        assert_eq!(mock.next().await["type"], "agent_start");
        let request = mock.next().await;
        assert_eq!(request["type"], "clarification_request");
        assert_eq!(request["requestId"], "mock-clarification-1");
        assert_eq!(request["question"], expected_question);
        match expected_choices {
            Some(choices) => assert_eq!(request["choices"], json!(choices)),
            None => assert!(request.get("choices").is_none()),
        }
        mock.send(json!({
            "id":"answer",
            "type":"clarification_response",
            "requestId":"mock-clarification-1",
            "answer":"Use the safe path"
        }))
        .await;
        assert_eq!(mock.response("answer").await["success"], true);
        assert_eq!(mock.next().await["type"], "agent_end");
        assert_eq!(mock.next().await["id"], "prompt");
        assert!(mock.stop().await.success());
    }
}
