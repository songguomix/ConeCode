-- Initial schema for the self-hosted GitHub reply bot.
-- Applied in filename order by src/server/db/migrate.ts.

CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reply_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  github_repo_id INTEGER NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_settings (
  repo_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  on_issue_opened INTEGER NOT NULL DEFAULT 0,
  on_issue_labeled INTEGER NOT NULL DEFAULT 0,
  on_pr_opened INTEGER NOT NULL DEFAULT 0,
  on_pr_labeled INTEGER NOT NULL DEFAULT 0,
  on_mention INTEGER NOT NULL DEFAULT 0,
  auto_post_enabled INTEGER NOT NULL DEFAULT 0,
  require_approval INTEGER NOT NULL DEFAULT 1,
  trigger_labels TEXT NOT NULL DEFAULT '[]',
  mention_trigger_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_trigger_roles TEXT NOT NULL DEFAULT 'maintainer',
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 10,
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
  quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
  quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
  quiet_hours_timezone TEXT NOT NULL DEFAULT 'UTC',
  max_reply_chars INTEGER NOT NULL DEFAULT 2000,
  max_context_comments INTEGER NOT NULL DEFAULT 10,
  max_changed_files INTEGER NOT NULL DEFAULT 20,
  template_id INTEGER,
  store_event_payload INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 1,
  generator_provider TEXT NOT NULL DEFAULT 'template',
  retention_days INTEGER NOT NULL DEFAULT 30,
  default_reply_language TEXT NOT NULL DEFAULT 'auto',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE,
  dedupe_key TEXT UNIQUE,
  event_type TEXT NOT NULL,
  action TEXT NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'other',
  labels TEXT NOT NULL DEFAULT '[]',
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  issue_number INTEGER,
  pr_number INTEGER,
  actor_login TEXT NOT NULL,
  actor_is_bot INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reason TEXT,
  context_summary TEXT,
  event_payload TEXT,
  generated_reply TEXT,
  edited_reply TEXT,
  posted_comment_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_created ON runs(repo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  repo_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);
