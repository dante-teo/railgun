use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{collections::HashSet, path::Path, str::FromStr, time::Duration};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub model: String,
    pub started_at: String,
    pub messages: Vec<Value>,
    pub message_ids: Vec<i64>,
    pub todos: Vec<Value>,
    pub persistence: &'static str,
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        migrate_legacy(&pool).await?;
        MIGRATOR.run(&pool).await?;
        validate_schema(&pool).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
        }
        Ok(Self { pool })
    }

    pub async fn list_sessions(&self, archived: bool) -> Result<Vec<Value>> {
        let predicate = if archived {
            "s.archived_at IS NOT NULL"
        } else {
            "s.archived_at IS NULL"
        };
        let order = if archived {
            "s.archived_at DESC, s.id DESC"
        } else {
            "COALESCE(d.delivered_at, s.started_at) DESC, COALESCE(d.sequence, 0) DESC, s.id DESC"
        };
        let sql = format!(
            "SELECT s.id, s.model, s.started_at, s.archived_at, COUNT(m.id) AS message_count,
             d.job_id, d.title, d.run_status, d.read_at,
             (SELECT content_json FROM messages preview
              WHERE preview.session_id = s.id AND preview.role = 'user'
              ORDER BY preview.id ASC LIMIT 1) AS first_user_content
             FROM sessions s
             LEFT JOIN messages m ON m.session_id = s.id
             LEFT JOIN session_deliveries d ON d.session_id = s.id
             WHERE {predicate}
             GROUP BY s.id ORDER BY {order} LIMIT 500"
        );
        let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let delivery = delivery_value(&row)?;
            let first_user_preview = match row.try_get::<Option<String>, _>("title")? {
                Some(title) => title,
                None => preview_text(row.try_get("first_user_content")?),
            };
            let started_at: String = row.try_get("started_at")?;
            let mut value = json!({
                "id": id,
                "model": row.try_get::<String, _>("model")?,
                "startedAtLocal": local_time(&started_at),
                "messageCount": row.try_get::<i64, _>("message_count")?,
                "firstUserPreview": first_user_preview,
            });
            if let Some(delivery) = delivery {
                value["delivery"] = delivery;
            }
            if archived {
                value["archivedAt"] = Value::String(row.try_get::<String, _>("archived_at")?);
            }
            result.push(value);
        }
        Ok(result)
    }

    pub async fn load_session(&self, id: &str) -> Result<Option<Session>> {
        let row = sqlx::query(
            "SELECT id, model, started_at, todos_json, current_leaf_id, archived_at
             FROM sessions WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        if row.try_get::<Option<String>, _>("archived_at")?.is_some() {
            return Ok(None);
        }
        let leaf = row.try_get::<Option<i64>, _>("current_leaf_id")?;
        let message_rows = if let Some(leaf) = leaf {
            sqlx::query(
                "WITH RECURSIVE branch(id, role, content_json, tool_call_id, tool_error, response_id, parent_id) AS (
                   SELECT id, role, content_json, tool_call_id, tool_error, response_id, parent_id
                   FROM messages WHERE id = ? AND session_id = ?
                   UNION ALL
                   SELECT m.id, m.role, m.content_json, m.tool_call_id, m.tool_error, m.response_id, m.parent_id
                   FROM messages m JOIN branch b ON m.id = b.parent_id WHERE m.session_id = ?
                 )
                 SELECT id, role, content_json, tool_call_id, tool_error, response_id
                 FROM branch ORDER BY id ASC",
            )
            .bind(leaf)
            .bind(id)
            .bind(id)
            .fetch_all(&self.pool)
            .await?
        } else {
            Vec::new()
        };
        let mut messages = Vec::new();
        let mut message_ids = Vec::new();
        for message_row in message_rows {
            if message_row.try_get::<String, _>("role")? == "branch_summary" {
                continue;
            }
            message_ids.push(message_row.try_get("id")?);
            messages.push(decode_message(&message_row)?);
        }
        let todos_json: String = row.try_get("todos_json")?;
        let todos = serde_json::from_str::<Vec<Value>>(&todos_json)
            .with_context(|| format!("Saved session {id} is corrupt: malformed todo snapshot"))?;
        Ok(Some(Session {
            id: row.try_get("id")?,
            model: row.try_get("model")?,
            started_at: row.try_get("started_at")?,
            messages,
            message_ids,
            todos,
            persistence: "saved",
        }))
    }

    pub async fn save_session(&self, session: &mut Session) -> Result<()> {
        validate_transcript(&session.messages)?;
        let mut transaction = self.pool.begin().await?;
        let existing =
            sqlx::query("SELECT model, started_at, archived_at FROM sessions WHERE id = ?")
                .bind(&session.id)
                .fetch_optional(&mut *transaction)
                .await?;
        if let Some(row) = existing {
            if row.try_get::<Option<String>, _>("archived_at")?.is_some() {
                bail!("session {} is archived", session.id);
            }
            if row.try_get::<String, _>("model")? != session.model
                || row.try_get::<String, _>("started_at")? != session.started_at
            {
                bail!(
                    "Saved session {} is corrupt: checkpoint metadata does not match the saved session",
                    session.id
                );
            }
        } else {
            sqlx::query(
                "INSERT INTO sessions (id, model, started_at, todos_json)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&session.id)
            .bind(&session.model)
            .bind(&session.started_at)
            .bind(serde_json::to_string(&session.todos)?)
            .execute(&mut *transaction)
            .await?;
        }
        let stored = active_branch_rows(&mut transaction, &session.id).await?;
        let visible = stored
            .iter()
            .filter(|row| {
                row.try_get::<String, _>("role").ok().as_deref() != Some("branch_summary")
            })
            .collect::<Vec<_>>();
        if visible.len() > session.messages.len() {
            bail!(
                "Saved session {} is corrupt: checkpoint would discard saved messages",
                session.id
            );
        }
        for (index, row) in visible.iter().enumerate() {
            let stored_message = decode_message(row)?;
            if stored_message != session.messages[index] {
                bail!(
                    "Saved session {} is corrupt: checkpoint diverges at branch position {}",
                    session.id,
                    index
                );
            }
        }
        let mut parent = stored
            .last()
            .and_then(|row| row.try_get::<i64, _>("id").ok());
        for (ordinal, message) in session.messages.iter().enumerate().skip(visible.len()) {
            let encoded = encode_message(message)?;
            let result = sqlx::query(
                "INSERT INTO messages
                 (session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at, parent_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&session.id)
            .bind(ordinal as i64)
            .bind(encoded.role)
            .bind(encoded.content_json)
            .bind(encoded.tool_call_id)
            .bind(encoded.tool_error)
            .bind(encoded.response_id)
            .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .bind(parent)
            .execute(&mut *transaction)
            .await?;
            parent = Some(result.last_insert_rowid());
        }
        sqlx::query("UPDATE sessions SET current_leaf_id = ?, todos_json = ? WHERE id = ?")
            .bind(parent)
            .bind(serde_json::to_string(&session.todos)?)
            .bind(&session.id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        session.persistence = "saved";
        if let Some(saved) = self.load_session(&session.id).await? {
            session.message_ids = saved.message_ids;
        }
        Ok(())
    }

    pub async fn archive(&self, id: &str, archived: bool) -> Result<()> {
        let result = if archived {
            sqlx::query("UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
                .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                .bind(id)
                .execute(&self.pool)
                .await?
        } else {
            sqlx::query(
                "UPDATE sessions SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL",
            )
            .bind(id)
            .execute(&self.pool)
            .await?
        };
        if result.rows_affected() != 1 {
            bail!(
                "{} session {id} not found",
                if archived { "active" } else { "archived" }
            );
        }
        Ok(())
    }

    pub async fn branch(&self, session_id: &str, message_id: i64) -> Result<()> {
        let rows = sqlx::query(
            "WITH RECURSIVE branch(id, parent_id) AS (
              SELECT id, parent_id FROM messages
              WHERE id = (SELECT current_leaf_id FROM sessions WHERE id = ?) AND session_id = ?
              UNION ALL
              SELECT m.id, m.parent_id FROM messages m JOIN branch b ON m.id = b.parent_id
              WHERE m.session_id = ?
            ) SELECT id FROM branch",
        )
        .bind(session_id)
        .bind(session_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        if !rows
            .iter()
            .any(|row| row.try_get::<i64, _>("id").ok() == Some(message_id))
        {
            bail!("message {message_id} is not on the active branch of session {session_id}");
        }
        sqlx::query("UPDATE sessions SET current_leaf_id = ? WHERE id = ?")
            .bind(message_id)
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn fork(&self, session_id: &str) -> Result<String> {
        let Some(source) = self.load_session(session_id).await? else {
            bail!("session {session_id} not found");
        };
        let mut fork = source;
        fork.id = format!("fork-{}", uuid::Uuid::new_v4());
        fork.started_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        fork.message_ids.clear();
        let id = fork.id.clone();
        self.save_session(&mut fork).await?;
        Ok(id)
    }

    pub async fn recent_messages(&self, session_id: &str, limit: i64) -> Result<Vec<Value>> {
        let rows = sqlx::query(
            "WITH RECURSIVE branch(id, role, content_json, parent_id) AS (
               SELECT m.id, m.role, m.content_json, m.parent_id
               FROM messages m
               WHERE m.id = (SELECT current_leaf_id FROM sessions WHERE id = ?)
                 AND m.session_id = ?
               UNION ALL
               SELECT m.id, m.role, m.content_json, m.parent_id
               FROM messages m JOIN branch b ON m.id = b.parent_id
               WHERE m.session_id = ?
             )
             SELECT id, role, content_json FROM branch
             WHERE role <> 'branch_summary'
             ORDER BY id DESC LIMIT ?",
        )
        .bind(session_id)
        .bind(session_id)
        .bind(session_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .rev()
            .map(|row| {
                let raw: String = row.try_get("content_json")?;
                let content: Value = serde_json::from_str(&raw)?;
                Ok(json!({
                    "id": row.try_get::<i64, _>("id")?,
                    "role": row.try_get::<String, _>("role")?,
                    "preview": content_text(&content).chars().take(500).collect::<String>(),
                }))
            })
            .collect()
    }

    pub async fn delivery_cursor(&self) -> Result<i64> {
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0) FROM session_deliveries",
        )
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn save_scheduled_session(
        &self,
        session: &mut Session,
        job_id: &str,
        title: &str,
        status: &str,
    ) -> Result<()> {
        if !matches!(status, "completed" | "incomplete" | "failed") {
            bail!("invalid scheduled session status {status}");
        }
        self.save_session(session).await?;
        sqlx::query(
            "INSERT INTO session_deliveries (session_id, job_id, title, run_status, delivered_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&session.id)
        .bind(job_id)
        .bind(title)
        .bind(status)
        .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn memories(&self, query: Option<&str>, limit: i64) -> Result<Vec<Value>> {
        let rows = if let Some(query) = query {
            sqlx::query(
                "SELECT id, content, category, created_at FROM memories
                 WHERE content LIKE '%' || ? || '%' COLLATE NOCASE
                 ORDER BY created_at DESC, rowid DESC LIMIT ?",
            )
            .bind(query)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT id, content, category, created_at FROM memories
                 ORDER BY created_at DESC, rowid DESC LIMIT ?",
            )
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        };
        rows.into_iter()
            .map(|row| {
                Ok(json!({
                    "id": row.try_get::<String, _>("id")?,
                    "content": row.try_get::<String, _>("content")?,
                    "category": row.try_get::<String, _>("category")?,
                    "createdAt": row.try_get::<f64, _>("created_at")?,
                }))
            })
            .collect()
    }

    pub async fn create_memory(&self, content: &str, category: &str) -> Result<Value> {
        let memory = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "content": content,
            "category": category,
            "createdAt": Utc::now().timestamp_millis() as f64 / 1000.0,
        });
        sqlx::query("INSERT INTO memories (id, content, category, created_at) VALUES (?, ?, ?, ?)")
            .bind(memory["id"].as_str())
            .bind(content)
            .bind(category)
            .bind(memory["createdAt"].as_f64())
            .execute(&self.pool)
            .await?;
        Ok(memory)
    }

    pub async fn update_memory(
        &self,
        id: &str,
        content: Option<&str>,
        category: Option<&str>,
    ) -> Result<Option<Value>> {
        let existing =
            sqlx::query("SELECT content, category, created_at FROM memories WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        let Some(row) = existing else {
            return Ok(None);
        };
        let next_content = content
            .map(str::to_owned)
            .unwrap_or(row.try_get::<String, _>("content")?);
        let next_category = category
            .map(str::to_owned)
            .unwrap_or(row.try_get::<String, _>("category")?);
        sqlx::query("UPDATE memories SET content = ?, category = ? WHERE id = ?")
            .bind(&next_content)
            .bind(&next_category)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(Some(json!({
            "id": id,
            "content": next_content,
            "category": next_category,
            "createdAt": row.try_get::<f64, _>("created_at")?,
        })))
    }

    pub async fn delete_memory(&self, id: &str) -> Result<bool> {
        Ok(sqlx::query("DELETE FROM memories WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected()
            > 0)
    }
}

struct EncodedMessage {
    role: String,
    content_json: String,
    tool_call_id: Option<String>,
    tool_error: Option<i64>,
    response_id: Option<String>,
}

fn encode_message(message: &Value) -> Result<EncodedMessage> {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .context("message role is missing")?;
    if !matches!(role, "user" | "assistant" | "tool") {
        bail!("unsupported message role {role}");
    }
    let content = message
        .get("content")
        .context("message content is missing")?;
    Ok(EncodedMessage {
        role: role.to_owned(),
        content_json: serde_json::to_string(content)?,
        tool_call_id: message
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        tool_error: message
            .get("isError")
            .and_then(Value::as_bool)
            .map(i64::from),
        response_id: message
            .get("responseId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn decode_message(row: &sqlx::sqlite::SqliteRow) -> Result<Value> {
    let role: String = row.try_get("role")?;
    let raw: String = row.try_get("content_json")?;
    let content: Value = serde_json::from_str(&raw)?;
    let mut result = json!({"role": role, "content": content});
    if role == "tool" {
        result["toolCallId"] = Value::String(row.try_get::<String, _>("tool_call_id")?);
        if let Some(value) = row.try_get::<Option<i64>, _>("tool_error")? {
            result["isError"] = Value::Bool(value == 1);
        }
    } else if role == "assistant" {
        if let Some(value) = row.try_get::<Option<String>, _>("response_id")? {
            result["responseId"] = Value::String(value);
        }
    }
    Ok(result)
}

fn validate_transcript(messages: &[Value]) -> Result<()> {
    if messages.is_empty() {
        bail!("role sequence cannot be empty");
    }
    let mut expected = "user";
    let mut pending = Vec::<String>::new();
    let mut answered = HashSet::<String>::new();
    for (ordinal, message) in messages.iter().enumerate() {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "user" if expected == "user" => expected = "assistant",
            "assistant" if expected == "assistant" => {
                let calls = message
                    .get("content")
                    .and_then(Value::as_array)
                    .context("assistant content must be an array")?
                    .iter()
                    .filter(|part| part["type"] == "toolCall")
                    .map(|part| {
                        part.get("id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned)
                            .context("invalid assistant tool call id")
                    })
                    .collect::<Result<Vec<_>>>()?;
                let unique = calls.iter().collect::<HashSet<_>>();
                if unique.len() != calls.len() {
                    bail!("duplicate tool call id in message {ordinal}");
                }
                if let Some(id) = calls
                    .iter()
                    .find(|id| pending.contains(id) || answered.contains(*id))
                {
                    bail!("duplicate tool call id {id}");
                }
                pending = calls;
                expected = if pending.is_empty() { "user" } else { "tool" };
            }
            "tool" if expected == "tool" => {
                let id = message
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .context("invalid tool message")?;
                let Some(index) = pending.iter().position(|pending| pending == id) else {
                    bail!("invalid role sequence at message {ordinal}: unmatched tool result {id}");
                };
                pending.remove(index);
                answered.insert(id.to_owned());
                expected = if pending.is_empty() {
                    "assistant"
                } else {
                    "tool"
                };
            }
            _ => bail!("invalid role sequence at message {ordinal}: expected {expected}"),
        }
    }
    if expected != "user" {
        bail!("incomplete role sequence: expected {expected}");
    }
    Ok(())
}

async fn active_branch_rows<'a>(
    transaction: &mut Transaction<'a, Sqlite>,
    session_id: &str,
) -> Result<Vec<sqlx::sqlite::SqliteRow>> {
    Ok(sqlx::query(
        "WITH RECURSIVE branch(id, role, content_json, tool_call_id, tool_error, response_id, parent_id) AS (
          SELECT id, role, content_json, tool_call_id, tool_error, response_id, parent_id
          FROM messages
          WHERE id = (SELECT current_leaf_id FROM sessions WHERE id = ?) AND session_id = ?
          UNION ALL
          SELECT m.id, m.role, m.content_json, m.tool_call_id, m.tool_error, m.response_id, m.parent_id
          FROM messages m JOIN branch b ON m.id = b.parent_id WHERE m.session_id = ?
        )
        SELECT id, role, content_json, tool_call_id, tool_error, response_id
        FROM branch ORDER BY id ASC",
    )
    .bind(session_id)
    .bind(session_id)
    .bind(session_id)
    .fetch_all(&mut **transaction)
    .await?)
}

fn content_text(value: &Value) -> String {
    if let Some(value) = value.as_str() {
        return value.to_owned();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn preview_text(raw: Option<String>) -> String {
    let Some(raw) = raw else { return String::new() };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return String::new();
    };
    let collapsed = content_text(&value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() <= 71 {
        collapsed
    } else {
        format!(
            "{}…",
            collapsed.chars().take(70).collect::<String>().trim_end()
        )
    }
}

fn local_time(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|value| {
            value
                .with_timezone(&chrono::Local)
                .format("%-m/%-d/%Y, %-I:%M:%S %p")
                .to_string()
        })
        .unwrap_or_else(|_| value.to_owned())
}

fn delivery_value(row: &sqlx::sqlite::SqliteRow) -> Result<Option<Value>> {
    let Some(job_id) = row.try_get::<Option<String>, _>("job_id")? else {
        return Ok(None);
    };
    Ok(Some(json!({
        "kind": "scheduled",
        "jobId": job_id,
        "title": row.try_get::<String, _>("title")?,
        "status": row.try_get::<String, _>("run_status")?,
        "unread": row.try_get::<Option<String>, _>("read_at")?.is_none(),
    })))
}

async fn table_exists(pool: &SqlitePool, name: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .bind(name)
    .fetch_one(pool)
    .await?
        > 0)
}

async fn column_exists(
    transaction: &mut Transaction<'_, Sqlite>,
    table: &str,
    column: &str,
) -> Result<bool> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(&mut **transaction)
        .await?;
    Ok(rows
        .iter()
        .any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some(column)))
}

async fn migrate_legacy(pool: &SqlitePool) -> Result<()> {
    if !table_exists(pool, "sessions").await? {
        return Ok(());
    }
    let version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    if version > 7 {
        bail!("Session database schema {version} is newer than supported legacy schema 7");
    }
    for next in (version + 1)..=7 {
        let mut transaction = pool.begin().await?;
        match next {
            1 => {}
            2 => {
                sqlx::raw_sql(
                    "CREATE TABLE messages_v2 (
                      id INTEGER PRIMARY KEY,
                      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                      ordinal INTEGER NOT NULL,
                      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'branch_summary')),
                      content_json TEXT NOT NULL,
                      tool_call_id TEXT,
                      tool_error INTEGER CHECK (tool_error IN (0, 1)),
                      response_id TEXT,
                      created_at TEXT NOT NULL,
                      parent_id INTEGER NULL
                    );
                    INSERT INTO messages_v2 (session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at)
                    SELECT session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at
                    FROM messages ORDER BY session_id, ordinal;
                    DROP TABLE messages;
                    ALTER TABLE messages_v2 RENAME TO messages;
                    CREATE INDEX messages_session ON messages(session_id);
                    CREATE INDEX messages_parent ON messages(parent_id);
                    ALTER TABLE sessions ADD COLUMN current_leaf_id INTEGER NULL;
                    CREATE TABLE IF NOT EXISTS memories (
                      id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, created_at REAL NOT NULL
                    );",
                )
                .execute(&mut *transaction)
                .await?;
                wire_parent_chains(&mut transaction).await?;
            }
            3 => {
                if !column_exists(&mut transaction, "messages", "parent_id").await? {
                    sqlx::raw_sql(
                        "CREATE TABLE messages_v2 (
                          id INTEGER PRIMARY KEY,
                          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                          ordinal INTEGER NOT NULL,
                          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'branch_summary')),
                          content_json TEXT NOT NULL, tool_call_id TEXT,
                          tool_error INTEGER CHECK (tool_error IN (0, 1)),
                          response_id TEXT, created_at TEXT NOT NULL, parent_id INTEGER NULL
                        );
                        INSERT INTO messages_v2 (session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at)
                        SELECT session_id, ordinal, role, content_json, tool_call_id, tool_error, response_id, created_at
                        FROM messages ORDER BY session_id, ordinal;
                        DROP TABLE messages;
                        ALTER TABLE messages_v2 RENAME TO messages;
                        CREATE INDEX messages_session ON messages(session_id);
                        CREATE INDEX messages_parent ON messages(parent_id);
                        CREATE TABLE IF NOT EXISTS memories (
                          id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, created_at REAL NOT NULL
                        );",
                    )
                    .execute(&mut *transaction)
                    .await?;
                }
                if !column_exists(&mut transaction, "sessions", "current_leaf_id").await? {
                    sqlx::query("ALTER TABLE sessions ADD COLUMN current_leaf_id INTEGER NULL")
                        .execute(&mut *transaction)
                        .await?;
                }
                wire_parent_chains(&mut transaction).await?;
            }
            4 | 5 => {}
            6 => {
                if !column_exists(&mut transaction, "sessions", "archived_at").await? {
                    sqlx::raw_sql(
                        "ALTER TABLE sessions ADD COLUMN archived_at TEXT NULL;
                         CREATE INDEX sessions_archived_at ON sessions(archived_at DESC, id DESC);",
                    )
                    .execute(&mut *transaction)
                    .await?;
                }
            }
            7 => {
                sqlx::raw_sql(
                    "CREATE TABLE IF NOT EXISTS session_deliveries (
                      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
                      job_id TEXT NOT NULL, title TEXT NOT NULL,
                      run_status TEXT NOT NULL CHECK (run_status IN ('completed', 'incomplete', 'failed')),
                      delivered_at TEXT NOT NULL, read_at TEXT NULL
                    );
                    CREATE INDEX IF NOT EXISTS session_deliveries_delivered_at
                    ON session_deliveries(delivered_at DESC, sequence DESC);",
                )
                .execute(&mut *transaction)
                .await?;
            }
            _ => unreachable!(),
        }
        sqlx::query(&format!("PRAGMA user_version = {next}"))
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
    }
    Ok(())
}

async fn wire_parent_chains(transaction: &mut Transaction<'_, Sqlite>) -> Result<()> {
    let sessions = sqlx::query("SELECT id FROM sessions")
        .fetch_all(&mut **transaction)
        .await?;
    for session in sessions {
        let id: String = session.try_get("id")?;
        let messages = sqlx::query("SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC")
            .bind(&id)
            .fetch_all(&mut **transaction)
            .await?;
        let mut parent = None;
        for message in messages {
            let message_id: i64 = message.try_get("id")?;
            sqlx::query("UPDATE messages SET parent_id = ? WHERE id = ?")
                .bind(parent)
                .bind(message_id)
                .execute(&mut **transaction)
                .await?;
            parent = Some(message_id);
        }
        sqlx::query("UPDATE sessions SET current_leaf_id = ? WHERE id = ?")
            .bind(parent)
            .bind(id)
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

async fn validate_schema(pool: &SqlitePool) -> Result<()> {
    for table in ["sessions", "messages", "memories", "session_deliveries"] {
        if !table_exists(pool, table).await? {
            bail!("session database is missing required table {table}");
        }
    }
    let version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    if version != 7 {
        bail!("session database legacy schema version is {version}, expected 7");
    }
    let foreign_keys = sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
        .fetch_one(pool)
        .await?;
    if foreign_keys != 1 {
        bail!("session database foreign key enforcement is disabled");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create_legacy_database(path: &Path, version: i64) {
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        let schema = if version == 1 {
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY, model TEXT NOT NULL, started_at TEXT NOT NULL,
               todos_json TEXT NOT NULL
             );
             CREATE TABLE messages (
               session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               ordinal INTEGER NOT NULL,
               role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
               content_json TEXT NOT NULL, tool_call_id TEXT,
               tool_error INTEGER CHECK (tool_error IN (0, 1)),
               response_id TEXT, created_at TEXT NOT NULL,
               UNIQUE(session_id, ordinal)
             );
             CREATE INDEX messages_session_ordinal ON messages(session_id, ordinal);"
        } else {
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY, model TEXT NOT NULL, started_at TEXT NOT NULL,
               todos_json TEXT NOT NULL, current_leaf_id INTEGER NULL
             );
             CREATE TABLE messages (
               id INTEGER PRIMARY KEY,
               session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               ordinal INTEGER NOT NULL,
               role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'branch_summary')),
               content_json TEXT NOT NULL, tool_call_id TEXT,
               tool_error INTEGER CHECK (tool_error IN (0, 1)),
               response_id TEXT, created_at TEXT NOT NULL, parent_id INTEGER NULL
             );
             CREATE INDEX messages_session ON messages(session_id);
             CREATE INDEX messages_parent ON messages(parent_id);
             CREATE TABLE memories (
               id TEXT PRIMARY KEY, content TEXT NOT NULL,
               category TEXT NOT NULL, created_at REAL NOT NULL
             );"
        };
        sqlx::raw_sql(schema).execute(&pool).await.unwrap();
        if version >= 6 {
            sqlx::raw_sql(
                "ALTER TABLE sessions ADD COLUMN archived_at TEXT NULL;
                 CREATE INDEX sessions_archived_at ON sessions(archived_at DESC, id DESC);",
            )
            .execute(&pool)
            .await
            .unwrap();
        }
        if version >= 7 {
            sqlx::raw_sql(
                "CREATE TABLE session_deliveries (
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                   session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
                   job_id TEXT NOT NULL, title TEXT NOT NULL,
                   run_status TEXT NOT NULL CHECK (run_status IN ('completed', 'incomplete', 'failed')),
                   delivered_at TEXT NOT NULL, read_at TEXT NULL
                 );
                 CREATE INDEX session_deliveries_delivered_at
                 ON session_deliveries(delivered_at DESC, sequence DESC);",
            )
            .execute(&pool)
            .await
            .unwrap();
        }
        let leaf = if version == 1 {
            ""
        } else {
            ", current_leaf_id"
        };
        let leaf_value = if version == 1 { "" } else { ", 2" };
        sqlx::query(&format!(
            "INSERT INTO sessions (id, model, started_at, todos_json{leaf})
             VALUES ('legacy', 'legacy-model', '2026-01-01T00:00:00.000Z', '[]'{leaf_value})"
        ))
        .execute(&pool)
        .await
        .unwrap();
        if version == 1 {
            sqlx::raw_sql(
                "INSERT INTO messages
                   (session_id, ordinal, role, content_json, created_at)
                 VALUES
                   ('legacy', 0, 'user', '\"hello\"', '2026-01-01T00:00:00.000Z'),
                   ('legacy', 1, 'assistant', '[{\"type\":\"text\",\"text\":\"world\"}]',
                    '2026-01-01T00:00:01.000Z');",
            )
            .execute(&pool)
            .await
            .unwrap();
        } else {
            sqlx::raw_sql(
                "INSERT INTO messages
                   (id, session_id, ordinal, role, content_json, created_at, parent_id)
                 VALUES
                   (1, 'legacy', 0, 'user', '\"hello\"', '2026-01-01T00:00:00.000Z', NULL),
                   (2, 'legacy', 1, 'assistant', '[{\"type\":\"text\",\"text\":\"world\"}]',
                    '2026-01-01T00:00:01.000Z', 1);",
            )
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::raw_sql(
            "CREATE TABLE Notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
             INSERT INTO Notes(content) VALUES ('retired but retained');",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(&format!("PRAGMA user_version = {version}"))
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn fresh_database_has_sqlx_and_legacy_versions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.db");
        let store = Store::open(&path).await.unwrap();
        assert_eq!(store.delivery_cursor().await.unwrap(), 0);
        let ledger = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(ledger, 1);
    }

    #[tokio::test]
    async fn preserves_retired_notes_table() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.db");
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
             INSERT INTO notes(content) VALUES ('keep me');
             PRAGMA user_version = 0;",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        Store::open(&path).await.unwrap();
        let check = SqlitePool::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT content FROM notes")
                .fetch_one(&check)
                .await
                .unwrap(),
            "keep me"
        );
    }

    #[tokio::test]
    async fn upgrades_every_existing_legacy_version_without_losing_rows() {
        for version in 1..=7 {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(format!("legacy-{version}.db"));
            create_legacy_database(&path, version).await;

            let store = Store::open(&path).await.unwrap();
            let session = store.load_session("legacy").await.unwrap().unwrap();
            assert_eq!(session.messages.len(), 2, "legacy version {version}");
            assert_eq!(session.messages[0]["content"], "hello");
            assert_eq!(session.messages[1]["content"][0]["text"], "world");
            assert_eq!(
                sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                    .fetch_one(&store.pool)
                    .await
                    .unwrap(),
                7
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT content FROM Notes")
                    .fetch_one(&store.pool)
                    .await
                    .unwrap(),
                "retired but retained"
            );
        }
    }

    #[tokio::test]
    async fn preserves_dbmate_ledger_and_unknown_tables_during_sqlx_cutover() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dbmate.db");
        create_legacy_database(&path, 7).await;
        let pool = SqlitePool::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE schema_migrations (
               version TEXT PRIMARY KEY,
               applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             INSERT INTO schema_migrations(version) VALUES ('20260726150413');
             CREATE TABLE future_data (value TEXT NOT NULL);
             INSERT INTO future_data(value) VALUES ('keep');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let store = Store::open(&path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT version FROM schema_migrations")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            "20260726150413"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM future_data")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            "keep"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn rejects_newer_legacy_schemas_without_changing_the_version() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("newer.db");
        create_legacy_database(&path, 7).await;
        let pool = SqlitePool::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 8")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let error = match Store::open(&path).await {
            Ok(_) => panic!("newer schema unexpectedly opened"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("newer than supported legacy schema 7"));
        let check = SqlitePool::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&check)
                .await
                .unwrap(),
            8
        );
    }

    #[tokio::test]
    async fn failed_legacy_step_rolls_back_its_version_update() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("malformed.db");
        let pool = SqlitePool::connect_with(
            SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
                .unwrap()
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY, model TEXT NOT NULL,
               started_at TEXT NOT NULL, todos_json TEXT NOT NULL
             );
             PRAGMA user_version = 1;",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        assert!(Store::open(&path).await.is_err());
        let check = SqlitePool::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&check)
                .await
                .unwrap(),
            1
        );
        assert!(!table_exists(&check, "messages_v2").await.unwrap());
    }

    #[tokio::test]
    async fn tool_transcripts_round_trip_without_changing_persisted_json() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tools.db");
        let store = Store::open(&path).await.unwrap();
        let messages = vec![
            json!({"role":"user","content":"inspect both"}),
            json!({"role":"assistant","content":[
                {"type":"thinking","thinking":"I will inspect them.","thinkingSignature":"signed"},
                {"type":"toolCall","id":"call-a","name":"read_file","arguments":{"path":"a"}},
                {"type":"toolCall","id":"call-b","name":"read_file","arguments":{"path":"b"}}
            ],"responseId":"response-1"}),
            json!({"role":"tool","toolCallId":"call-b","content":[{"type":"text","text":"B"}]}),
            json!({"role":"tool","toolCallId":"call-a","content":"A","isError":false}),
            json!({"role":"assistant","content":[{"type":"text","text":"Done."}]}),
        ];
        let mut session = Session {
            id: "tool-session".into(),
            model: "model".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            messages: messages.clone(),
            message_ids: Vec::new(),
            todos: vec![json!({"id":"todo-1","content":"inspect","status":"completed"})],
            persistence: "unsaved",
        };

        store.save_session(&mut session).await.unwrap();
        let loaded = store.load_session(&session.id).await.unwrap().unwrap();
        assert_eq!(loaded.messages, messages);
        assert_eq!(loaded.todos, session.todos);
        assert_eq!(loaded.message_ids.len(), messages.len());
    }

    #[tokio::test]
    async fn recent_messages_only_projects_the_active_branch() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("branches.db"))
            .await
            .unwrap();
        let mut session = Session {
            id: "branch-session".into(),
            model: "model".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            messages: vec![
                json!({"role":"user","content":"root"}),
                json!({"role":"assistant","content":[{"type":"text","text":"branch point"}]}),
                json!({"role":"user","content":"abandoned user"}),
                json!({"role":"assistant","content":[{"type":"text","text":"abandoned answer"}]}),
            ],
            message_ids: Vec::new(),
            todos: Vec::new(),
            persistence: "unsaved",
        };
        store.save_session(&mut session).await.unwrap();

        store
            .branch(&session.id, session.message_ids[1])
            .await
            .unwrap();
        let mut active = store.load_session(&session.id).await.unwrap().unwrap();
        active
            .messages
            .push(json!({"role":"user","content":"replacement user"}));
        active.messages.push(
            json!({"role":"assistant","content":[{"type":"text","text":"replacement answer"}]}),
        );
        store.save_session(&mut active).await.unwrap();

        let recent = store.recent_messages(&session.id, 10).await.unwrap();
        let previews = recent
            .iter()
            .map(|message| message["preview"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            previews,
            [
                "root",
                "branch point",
                "replacement user",
                "replacement answer"
            ]
        );
    }

    #[tokio::test]
    async fn session_list_projects_first_user_preview_without_per_session_reads() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("sessions.db"))
            .await
            .unwrap();
        for (id, prompt) in [
            ("one", "  First   task prompt  "),
            ("two", "Second task prompt"),
        ] {
            let mut session = Session {
                id: id.into(),
                model: "model".into(),
                started_at: "2026-01-01T00:00:00.000Z".into(),
                messages: vec![
                    json!({"role":"user","content":prompt}),
                    json!({"role":"assistant","content":[{"type":"text","text":"Acknowledged"}]}),
                ],
                message_ids: Vec::new(),
                todos: Vec::new(),
                persistence: "unsaved",
            };
            store.save_session(&mut session).await.unwrap();
        }

        let summaries = store.list_sessions(false).await.unwrap();
        let previews = summaries
            .iter()
            .map(|summary| summary["firstUserPreview"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(previews.contains(&"First task prompt"));
        assert!(previews.contains(&"Second task prompt"));
    }

    #[tokio::test]
    async fn scheduled_sessions_are_persisted_as_deliveries() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("scheduled.db"))
            .await
            .unwrap();
        let mut session = Session {
            id: "cron-test".into(),
            model: "model".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            messages: vec![
                json!({"role":"user","content":"scheduled"}),
                json!({"role":"assistant","content":[{"type":"text","text":"done"}]}),
            ],
            message_ids: Vec::new(),
            todos: Vec::new(),
            persistence: "unsaved",
        };
        store
            .save_scheduled_session(&mut session, "daily", "scheduled", "completed")
            .await
            .unwrap();
        assert_eq!(store.delivery_cursor().await.unwrap(), 1);
        assert_eq!(
            store.list_sessions(false).await.unwrap()[0]["delivery"]["jobId"],
            "daily"
        );
    }

    #[test]
    fn transcript_validation_rejects_duplicate_and_unmatched_tool_results() {
        let duplicate = vec![
            json!({"role":"user","content":"run"}),
            json!({"role":"assistant","content":[
                {"type":"toolCall","id":"same","name":"one","arguments":{}},
                {"type":"toolCall","id":"same","name":"two","arguments":{}}
            ]}),
        ];
        assert!(
            validate_transcript(&duplicate)
                .unwrap_err()
                .to_string()
                .contains("duplicate tool call id")
        );

        let unmatched = vec![
            json!({"role":"user","content":"run"}),
            json!({"role":"assistant","content":[
                {"type":"toolCall","id":"expected","name":"one","arguments":{}}
            ]}),
            json!({"role":"tool","toolCallId":"different","content":"result"}),
        ];
        assert!(
            validate_transcript(&unmatched)
                .unwrap_err()
                .to_string()
                .contains("unmatched tool result")
        );
    }
}
