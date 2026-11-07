export const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  is_factory INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  repo_id TEXT REFERENCES repos(id),
  autonomy TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT,
  branch TEXT,
  worktree TEXT,
  session_id TEXT,
  driver TEXT,
  model TEXT,
  effort TEXT,
  driver_settings TEXT,
  assignee TEXT,
  postmortem_of TEXT,
  pre_approved_at TEXT,
  prerequisites TEXT,
  prerequisites_waived_at TEXT,
  acceptance TEXT,
  acceptance_checks TEXT,
  lookouts TEXT,
  report TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT,
  scheduled_at TEXT,
  follow_up_of TEXT,
  follow_up_finding INTEGER,
  started_at TEXT,
  finished_at TEXT
);
DROP INDEX IF EXISTS tasks_status;
-- Lets task lists and shipped counts filter and sort without reading rows: briefs and reports run to tens of KB.
CREATE INDEX IF NOT EXISTS tasks_status_times ON tasks(status, finished_at, created_at);
CREATE INDEX IF NOT EXISTS tasks_finished ON tasks(finished_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
-- The overview polls these two every few seconds. Its queries must spell each WHERE the same way, or SQLite skips the index.
CREATE INDEX IF NOT EXISTS events_activity ON events(ts, type) WHERE type IN ('note','tool','finding');
CREATE INDEX IF NOT EXISTS events_blocked ON events(task_id) WHERE type = 'blocked';
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  task_id TEXT,
  driver TEXT NOT NULL,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_status ON goals(status);
CREATE TABLE IF NOT EXISTS goal_tasks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  goal_id TEXT NOT NULL REFERENCES goals(id)
);
CREATE INDEX IF NOT EXISTS goal_tasks_goal ON goal_tasks(goal_id);
CREATE TABLE IF NOT EXISTS crew_schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  days_mask INTEGER NOT NULL,
  local_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  pre_approve INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  next_fire_at TEXT NOT NULL,
  last_fired_at TEXT,
  last_outcome TEXT
);
CREATE INDEX IF NOT EXISTS crew_schedules_due ON crew_schedules(enabled, next_fire_at);
-- Operators sign in to the dashboard. Passwords are scrypt hashes; session and invite tokens are kept only as SHA-256 digests.
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  password_changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  client TEXT
);
CREATE INDEX IF NOT EXISTS sessions_operator ON sessions(operator_id);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  role TEXT,
  name TEXT,
  operator_id TEXT REFERENCES operators(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS invites_operator ON invites(operator_id);
`;

/** Created by migrateCostsToRuns, so the first open can backfill it from older tasks. */
export const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  agent_id TEXT,
  driver TEXT NOT NULL,
  model TEXT,
  outcome TEXT NOT NULL DEFAULT 'running',
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, id);
CREATE INDEX IF NOT EXISTS runs_finished ON runs(finished_at);
`;
