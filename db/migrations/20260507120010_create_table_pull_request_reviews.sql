-- migrate:up
CREATE TABLE pull_request_reviews (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  external_id TEXT NOT NULL,
  pull_request_id BIGINT REFERENCES pull_requests (id),
  repository_id BIGINT NOT NULL REFERENCES repositories (id),
  state TEXT NOT NULL CHECK (
    state IN (
      'APPROVED',
      'CHANGES_REQUESTED',
      'COMMENTED',
      'DISMISSED',
      'PENDING'
    )
  ),
  submitted_at TIMESTAMPTZ NOT NULL,
  submitted_on DATE NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN ('live', 'self_backfill', 'external_import')
  ),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

CREATE INDEX idx_pull_request_reviews_account_date ON pull_request_reviews (account_id, submitted_on);

-- migrate:down
DROP TABLE IF EXISTS pull_request_reviews;
