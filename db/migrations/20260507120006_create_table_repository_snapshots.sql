-- migrate:up
CREATE TABLE repository_snapshots (
  id BIGSERIAL PRIMARY KEY,
  repository_id BIGINT NOT NULL REFERENCES repositories (id),
  captured_on DATE NOT NULL,
  star_count INT,
  fork_count INT,
  is_archived BOOLEAN,
  visibility TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, captured_on)
);

CREATE TABLE repository_backfill_state (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  repository_id BIGINT NOT NULL REFERENCES repositories (id),
  backfill_through_on DATE NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'running',
      'retry_wait',
      'succeeded',
      'skipped_permanent',
      'failed_permanent',
      'blocked_auth'
    )
  ),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, repository_id, backfill_through_on)
);

CREATE INDEX idx_repository_backfill_state_account_status ON repository_backfill_state (account_id, status, backfill_through_on);

-- migrate:down
DROP TABLE IF EXISTS repository_backfill_state;

DROP TABLE IF EXISTS repository_snapshots;
