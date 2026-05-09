-- migrate:up
CREATE TABLE issues (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  external_id TEXT NOT NULL,
  repository_id BIGINT NOT NULL REFERENCES repositories (id),
  number INT NOT NULL,
  title TEXT,
  web_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  external_created_at TIMESTAMPTZ NOT NULL,
  external_closed_at TIMESTAMPTZ,
  source TEXT NOT NULL CHECK (
    source IN ('live', 'self_backfill', 'external_import')
  ),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, number),
  UNIQUE (account_id, external_id)
);

-- migrate:down
DROP TABLE IF EXISTS issues;
