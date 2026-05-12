-- migrate:up
CREATE TABLE commits (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  oid TEXT NOT NULL,
  repository_id BIGINT NOT NULL REFERENCES repositories (id),
  committed_on DATE NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  additions INT,
  deletions INT,
  changed_files INT,
  message_headline TEXT,
  is_co_authored BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL CHECK (
    source IN ('live', 'self_backfill', 'external_import')
  ),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, oid)
);

CREATE INDEX idx_commits_account_date ON commits (account_id, committed_on);

CREATE INDEX idx_commits_repository_date ON commits (repository_id, committed_on);

-- migrate:down
DROP TABLE IF EXISTS commits;
