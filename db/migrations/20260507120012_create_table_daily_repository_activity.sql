-- migrate:up
CREATE TABLE daily_repository_activity (
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  activity_on DATE NOT NULL,
  repository_id BIGINT NOT NULL REFERENCES repositories (id),
  commits INT NOT NULL DEFAULT 0,
  lines_added INT,
  lines_deleted INT,
  files_changed INT,
  prs_opened INT NOT NULL DEFAULT 0,
  prs_merged INT NOT NULL DEFAULT 0,
  prs_closed_unmerged INT NOT NULL DEFAULT 0,
  pr_reviews_total INT NOT NULL DEFAULT 0,
  pr_reviews_approved INT,
  pr_reviews_changes_requested INT,
  pr_reviews_commented INT,
  issues_opened INT NOT NULL DEFAULT 0,
  issues_closed INT NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (
    source IN ('live_rollup', 'self_backfill', 'external_import')
  ),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, activity_on, repository_id)
);

-- migrate:down
DROP TABLE IF EXISTS daily_repository_activity;
