-- migrate:up
CREATE TABLE repositories (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  stable_key TEXT NOT NULL UNIQUE,
  organization_id BIGINT REFERENCES organizations (id),
  owner_login TEXT NOT NULL,
  name TEXT,
  full_name TEXT,
  web_url TEXT,
  description TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'unknown')),
  is_fork BOOLEAN,
  is_archived BOOLEAN,
  primary_language TEXT,
  default_branch TEXT,
  external_created_at TIMESTAMPTZ,
  external_pushed_at TIMESTAMPTZ,
  first_seen_on DATE NOT NULL,
  last_seen_on DATE NOT NULL,
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE INDEX idx_repositories_organization ON repositories (organization_id);

CREATE INDEX idx_repositories_provider_owner ON repositories (provider, owner_login);

-- migrate:down
DROP TABLE IF EXISTS repositories;
