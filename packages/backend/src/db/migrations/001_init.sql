-- ---------------------------------------------------------------------------
-- Autonomous AI QA Engineer - core schema
--
-- Written in a portable SQL subset so the same migration runs on PostgreSQL
-- (production) and embedded SQLite (local demo). JSON payloads are stored as
-- TEXT; booleans as INTEGER 0/1; timestamps as ISO-8601 TEXT.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  repo_url              TEXT NOT NULL,
  owner                 TEXT NOT NULL,
  repo                  TEXT NOT NULL,
  branch                TEXT NOT NULL DEFAULT 'main',
  commitish             TEXT,
  test_base_url         TEXT,
  is_private            INTEGER NOT NULL DEFAULT 0,
  -- AES-256-GCM encrypted; never returned over the API.
  github_token_enc      TEXT,
  credentials_enc       TEXT,
  last_analyzed_commit  TEXT,
  last_analyzed_at      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_repo_branch ON projects (repo_url, branch);

-- ---------------------------------------------------------------------------
-- Runs and their step-by-step progress
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  mode                  TEXT NOT NULL,
  status                TEXT NOT NULL,
  branch                TEXT NOT NULL,
  commit_sha            TEXT,
  previous_commit_sha   TEXT,
  started_at            TEXT NOT NULL,
  finished_at           TEXT,
  error                 TEXT,
  steps_json            TEXT NOT NULL DEFAULT '[]',
  counts_json           TEXT NOT NULL DEFAULT '{}',
  execution_json        TEXT,
  coverage_json         TEXT,
  ai_usage_json         TEXT,
  diff_json             TEXT,
  change_analysis_json  TEXT,
  report_id             TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id, started_at);

-- ---------------------------------------------------------------------------
-- Application knowledge model (spec section 6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  project_id            TEXT PRIMARY KEY,
  name                  TEXT NOT NULL DEFAULT '',
  purpose               TEXT NOT NULL DEFAULT '',
  domain                TEXT NOT NULL DEFAULT '',
  framework             TEXT NOT NULL DEFAULT 'unknown',
  architecture_json     TEXT NOT NULL DEFAULT '[]',
  open_questions_json   TEXT NOT NULL DEFAULT '[]',
  updated_at            TEXT NOT NULL,
  updated_commit        TEXT
);

CREATE TABLE IF NOT EXISTS features (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  key                   TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  evidence_level        TEXT NOT NULL DEFAULT 'inferred',
  routes_json           TEXT NOT NULL DEFAULT '[]',
  components_json       TEXT NOT NULL DEFAULT '[]',
  files_json            TEXT NOT NULL DEFAULT '[]',
  apis_json             TEXT NOT NULL DEFAULT '[]',
  entities_json         TEXT NOT NULL DEFAULT '[]',
  first_seen_commit     TEXT,
  last_seen_commit      TEXT,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_features_key ON features (project_id, key);

CREATE TABLE IF NOT EXISTS app_map (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  kind                  TEXT NOT NULL,   -- route | component | api | entity | role | permission | state_machine | validation | user_flow | navigation
  key                   TEXT NOT NULL,
  payload_json          TEXT NOT NULL,
  file                  TEXT,
  feature_key           TEXT,
  commit_sha            TEXT,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_map_key ON app_map (project_id, kind, key);
CREATE INDEX IF NOT EXISTS idx_app_map_feature ON app_map (project_id, feature_key);
CREATE INDEX IF NOT EXISTS idx_app_map_file ON app_map (project_id, file);

CREATE TABLE IF NOT EXISTS business_rules (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  rule_key              TEXT NOT NULL,        -- BR-001 etc., stable per project
  feature_key           TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'other',
  status                TEXT NOT NULL DEFAULT 'weakly_inferred',
  confidence            REAL NOT NULL DEFAULT 0.5,
  evidence_json         TEXT NOT NULL DEFAULT '[]',
  observed_json         TEXT NOT NULL DEFAULT '[]',
  inferred_json         TEXT NOT NULL DEFAULT '[]',
  unknown_json          TEXT NOT NULL DEFAULT '[]',
  related_routes_json   TEXT NOT NULL DEFAULT '[]',
  related_apis_json     TEXT NOT NULL DEFAULT '[]',
  related_files_json    TEXT NOT NULL DEFAULT '[]',
  approval_state        TEXT NOT NULL DEFAULT 'ai_generated',
  dedupe_hash           TEXT NOT NULL,
  first_seen_commit     TEXT,
  last_seen_commit      TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_key ON business_rules (project_id, rule_key);
CREATE INDEX IF NOT EXISTS idx_rules_dedupe ON business_rules (project_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_rules_feature ON business_rules (project_id, feature_key);

-- ---------------------------------------------------------------------------
-- Scenarios, tests and traceability
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scenarios (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  scenario_key          TEXT NOT NULL,        -- SC-001 etc.
  feature_key           TEXT NOT NULL,
  category              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  preconditions_json    TEXT NOT NULL DEFAULT '[]',
  steps_json            TEXT NOT NULL DEFAULT '[]',
  expected_result       TEXT NOT NULL DEFAULT '',
  business_rules_json   TEXT NOT NULL DEFAULT '[]',
  evidence_json         TEXT NOT NULL DEFAULT '[]',
  confidence            REAL NOT NULL DEFAULT 0.5,
  priority              TEXT NOT NULL DEFAULT 'medium',
  role                  TEXT,
  dedupe_hash           TEXT NOT NULL,
  covered_by_existing   TEXT,                 -- path of a pre-existing spec that already covers it
  approval_state        TEXT NOT NULL DEFAULT 'ai_generated',
  is_obsolete           INTEGER NOT NULL DEFAULT 0,
  obsolete_reason       TEXT,
  first_seen_commit     TEXT,
  last_seen_commit      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scenarios_key ON scenarios (project_id, scenario_key);
CREATE INDEX IF NOT EXISTS idx_scenarios_dedupe ON scenarios (project_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_scenarios_feature ON scenarios (project_id, feature_key);

CREATE TABLE IF NOT EXISTS generated_tests (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  spec_file             TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'spec',  -- spec | page_object | fixture | support
  feature_key           TEXT NOT NULL DEFAULT '',
  scenario_keys_json    TEXT NOT NULL DEFAULT '[]',
  content               TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'generated', -- generated | existing
  approval_state        TEXT NOT NULL DEFAULT 'ai_generated',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  last_run_id           TEXT,
  last_outcome          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tests_file ON generated_tests (project_id, spec_file);
CREATE INDEX IF NOT EXISTS idx_tests_feature ON generated_tests (project_id, feature_key);

-- Source file -> feature -> business rule -> scenario -> test (spec section 9)
CREATE TABLE IF NOT EXISTS traceability (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  source_file           TEXT NOT NULL,
  feature_key           TEXT,
  business_rule_key     TEXT,
  scenario_key          TEXT,
  spec_file             TEXT,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_file ON traceability (project_id, source_file);
CREATE INDEX IF NOT EXISTS idx_trace_scenario ON traceability (project_id, scenario_key);
CREATE INDEX IF NOT EXISTS idx_trace_spec ON traceability (project_id, spec_file);

-- ---------------------------------------------------------------------------
-- Execution results, failures and evidence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_results (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  spec_file             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  full_title            TEXT NOT NULL,
  scenario_key          TEXT,
  outcome               TEXT NOT NULL,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  attempts              INTEGER NOT NULL DEFAULT 1,
  error_message         TEXT,
  error_stack           TEXT,
  screenshots_json      TEXT NOT NULL DEFAULT '[]',
  video_path            TEXT,
  console_logs_json     TEXT NOT NULL DEFAULT '[]',
  network_logs_json     TEXT NOT NULL DEFAULT '[]',
  dom_snapshot          TEXT,
  commit_sha            TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_run ON test_results (run_id);
CREATE INDEX IF NOT EXISTS idx_results_scenario ON test_results (project_id, scenario_key);
CREATE INDEX IF NOT EXISTS idx_results_outcome ON test_results (project_id, outcome);

CREATE TABLE IF NOT EXISTS failures (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  test_result_id        TEXT NOT NULL,
  spec_file             TEXT NOT NULL,
  test_title            TEXT NOT NULL,
  scenario_key          TEXT,
  business_rule_key     TEXT,
  commit_sha            TEXT,
  occurred_at           TEXT NOT NULL,
  error_message         TEXT NOT NULL,
  classification        TEXT,
  confidence            REAL,
  root_cause            TEXT,
  recommended_action    TEXT,
  requires_human_review INTEGER NOT NULL DEFAULT 1,
  resolution            TEXT NOT NULL DEFAULT 'open',
  observed_json         TEXT NOT NULL DEFAULT '[]',
  inferred_json         TEXT NOT NULL DEFAULT '[]',
  unknown_json          TEXT NOT NULL DEFAULT '[]',
  evidence_json         TEXT NOT NULL DEFAULT '{}',
  culprit_files_json    TEXT NOT NULL DEFAULT '[]',
  signature             TEXT NOT NULL,
  occurrence_count      INTEGER NOT NULL DEFAULT 1,
  is_flaky              INTEGER NOT NULL DEFAULT 0,
  analyzed_by_ai        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_failures_signature ON failures (project_id, signature);
CREATE INDEX IF NOT EXISTS idx_failures_run ON failures (run_id);
CREATE INDEX IF NOT EXISTS idx_failures_resolution ON failures (project_id, resolution);

CREATE TABLE IF NOT EXISTS evidence (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  subject_type          TEXT NOT NULL,   -- test_result | failure | scenario | business_rule | exploration
  subject_id            TEXT NOT NULL,
  kind                  TEXT NOT NULL,   -- screenshot | video | console_log | network_log | dom | diff | source | ai_analysis
  path                  TEXT,
  content               TEXT,
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_subject ON evidence (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence (run_id);

CREATE TABLE IF NOT EXISTS healing_proposals (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  failure_id            TEXT NOT NULL,
  target_file           TEXT NOT NULL,
  old_locator           TEXT NOT NULL,
  proposed_locator      TEXT NOT NULL,
  strategy              TEXT NOT NULL DEFAULT 'css',
  confidence            REAL NOT NULL DEFAULT 0,
  rationale             TEXT NOT NULL DEFAULT '',
  diff                  TEXT NOT NULL DEFAULT '',
  evidence_json         TEXT NOT NULL DEFAULT '[]',
  approval_state        TEXT NOT NULL DEFAULT 'ai_generated',
  applied_at            TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healing_failure ON healing_proposals (failure_id);

-- ---------------------------------------------------------------------------
-- Repository memory (spec section 7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repo_snapshots (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  commit_sha            TEXT NOT NULL,
  previous_commit_sha   TEXT,
  analyzed_at           TEXT NOT NULL,
  file_hashes_json      TEXT NOT NULL DEFAULT '{}',
  architecture_json     TEXT NOT NULL DEFAULT '{}',
  static_analysis_json  TEXT NOT NULL DEFAULT '{}',
  run_id                TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_commit ON repo_snapshots (project_id, commit_sha);

CREATE TABLE IF NOT EXISTS repo_changes (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  from_commit           TEXT,
  to_commit             TEXT NOT NULL,
  path                  TEXT NOT NULL,
  previous_path         TEXT,
  status                TEXT NOT NULL,
  additions             INTEGER NOT NULL DEFAULT 0,
  deletions             INTEGER NOT NULL DEFAULT 0,
  impact_json           TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_run ON repo_changes (run_id);
CREATE INDEX IF NOT EXISTS idx_changes_path ON repo_changes (project_id, path);

-- Free-form, retrievable QA memory. Kept small and scoped so retrieval never
-- needs to send the whole database to a model (spec section 24).
CREATE TABLE IF NOT EXISTS memory_entries (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  scope                 TEXT NOT NULL,   -- application | qa | repository | failure
  subject               TEXT NOT NULL,   -- feature key, file path, test name, ...
  kind                  TEXT NOT NULL,   -- known_behavior | accepted_failure | flaky_test | fixed_bug | note
  summary               TEXT NOT NULL,
  detail_json           TEXT NOT NULL DEFAULT '{}',
  keywords              TEXT NOT NULL DEFAULT '',
  confidence            REAL NOT NULL DEFAULT 0.5,
  commit_sha            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_lookup ON memory_entries (project_id, scope, subject);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_entries (project_id, kind);

-- ---------------------------------------------------------------------------
-- AI cache and cost control (spec section 26)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key             TEXT PRIMARY KEY,
  project_id            TEXT,
  agent                 TEXT NOT NULL,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  response_json         TEXT NOT NULL,
  prompt_tokens         INTEGER NOT NULL DEFAULT 0,
  completion_tokens     INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  hit_count             INTEGER NOT NULL DEFAULT 0,
  last_hit_at           TEXT
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT,
  run_id                TEXT,
  agent                 TEXT NOT NULL,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  prompt_tokens         INTEGER NOT NULL DEFAULT 0,
  completion_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd    REAL NOT NULL DEFAULT 0,
  cached                INTEGER NOT NULL DEFAULT 0,
  failed                INTEGER NOT NULL DEFAULT 0,
  error                 TEXT,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_run ON ai_usage (run_id);
CREATE INDEX IF NOT EXISTS idx_usage_project ON ai_usage (project_id, created_at);

-- Per-file analysis cache: unchanged files are never re-sent to the model.
CREATE TABLE IF NOT EXISTS file_analysis_cache (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  path                  TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  analysis_json         TEXT NOT NULL,
  commit_sha            TEXT,
  created_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_cache ON file_analysis_cache (project_id, path, content_hash);

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  generated_at          TEXT NOT NULL,
  commit_sha            TEXT,
  summary_json          TEXT NOT NULL DEFAULT '{}',
  html_path             TEXT,
  json_path             TEXT,
  markdown_path         TEXT,
  pdf_path              TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_run ON reports (run_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version               TEXT PRIMARY KEY,
  applied_at            TEXT NOT NULL
);
