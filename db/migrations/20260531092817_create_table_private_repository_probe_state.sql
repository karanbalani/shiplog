-- migrate:up
CREATE TABLE private_repository_probe_state (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  repository_external_id TEXT NOT NULL,
  backfill_through_on DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'matched', 'no_match')),
  commit_year INTEGER,
  commit_cursor TEXT,
  completed_commit_years TEXT NOT NULL DEFAULT '',
  matched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (
    account_id,
    repository_external_id,
    backfill_through_on
  )
);

CREATE INDEX idx_private_repository_probe_state_account_status ON private_repository_probe_state (account_id, status, backfill_through_on);

-- migrate:down
DROP TABLE IF EXISTS private_repository_probe_state;
