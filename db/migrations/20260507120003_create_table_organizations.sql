-- migrate:up
CREATE TABLE organizations (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_login TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  avatar_url TEXT,
  website_url TEXT,
  first_seen_on DATE NOT NULL,
  last_seen_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

-- migrate:down
DROP TABLE IF EXISTS organizations;
