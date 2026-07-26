CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  todos_json TEXT NOT NULL,
  current_leaf_id INTEGER NULL,
  archived_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS sessions_archived_at ON sessions(archived_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS messages (
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
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_deliveries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  run_status TEXT NOT NULL CHECK (run_status IN ('completed', 'incomplete', 'failed')),
  delivered_at TEXT NOT NULL,
  read_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS session_deliveries_delivered_at
  ON session_deliveries(delivered_at DESC, sequence DESC);

PRAGMA user_version = 7;
