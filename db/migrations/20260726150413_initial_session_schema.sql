-- migrate:up

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  todos_json TEXT NOT NULL,
  current_leaf_id INTEGER NULL,
  archived_at TEXT NULL
);
CREATE INDEX sessions_archived_at ON sessions(archived_at DESC, id DESC);

CREATE TABLE messages (
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
CREATE INDEX messages_session ON messages(session_id);
CREATE INDEX messages_parent ON messages(parent_id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE session_deliveries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  run_status TEXT NOT NULL CHECK (run_status IN ('completed', 'incomplete', 'failed')),
  delivered_at TEXT NOT NULL,
  read_at TEXT NULL
);
CREATE INDEX session_deliveries_delivered_at ON session_deliveries(delivered_at DESC, sequence DESC);

PRAGMA user_version = 7;


-- migrate:down

DROP TABLE IF EXISTS session_deliveries;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
