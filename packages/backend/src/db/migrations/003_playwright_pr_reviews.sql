-- Playwright keeps a trace for failed tests; it is evidence like the video.
ALTER TABLE test_results ADD COLUMN trace_path TEXT;

-- Pull-request reviews: one row per reviewed head commit of a PR, linking the
-- pipeline run to the comment posted on GitHub.
CREATE TABLE IF NOT EXISTS pr_reviews (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  pr_number             INTEGER NOT NULL,
  repo_full_name        TEXT NOT NULL,
  title                 TEXT NOT NULL DEFAULT '',
  base_sha              TEXT,
  head_sha              TEXT NOT NULL,
  run_id                TEXT,
  status                TEXT NOT NULL,
  trigger               TEXT NOT NULL,
  comment_id            TEXT,
  comment_url           TEXT,
  summary_json          TEXT NOT NULL DEFAULT '{}',
  error                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_project ON pr_reviews (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr ON pr_reviews (project_id, pr_number, head_sha);
