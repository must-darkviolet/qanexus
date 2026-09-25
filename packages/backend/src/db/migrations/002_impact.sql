-- Regression intelligence: change-impact reports, from pipeline runs and from
-- on-demand analysis of a ref range or uncommitted working-tree changes.
CREATE TABLE IF NOT EXISTS impact_reports (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  run_id                TEXT,
  source_kind           TEXT NOT NULL,
  base_ref              TEXT,
  head_ref              TEXT NOT NULL,
  report_json           TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impact_project ON impact_reports (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_impact_run ON impact_reports (run_id);
