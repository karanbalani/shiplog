-- migrate:up
CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL CHECK (
    provider IN ('github', 'gitlab', 'bitbucket', 'gitea')
  ),
  external_login TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT,
  external_created_at TIMESTAMPTZ NOT NULL,
  first_seen_on DATE NOT NULL,
  last_successful_collect_on DATE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider),
  UNIQUE (provider, external_id),
  UNIQUE (provider, external_login)
);

CREATE INDEX idx_accounts_user ON accounts (user_id);

-- migrate:down
DROP TABLE IF EXISTS accounts;
