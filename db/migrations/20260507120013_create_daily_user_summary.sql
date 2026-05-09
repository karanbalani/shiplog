-- migrate:up
CREATE TABLE daily_user_summary (
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  activity_on DATE NOT NULL,
  total_commit_contributions INT,
  total_pull_request_contributions INT,
  total_pull_request_review_contributions INT,
  total_issue_contributions INT,
  restricted_contributions_count INT,
  source TEXT NOT NULL CHECK (
    source IN ('live', 'self_backfill', 'external_import')
  ),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, activity_on)
);

-- migrate:down
DROP TABLE IF EXISTS daily_user_summary;
