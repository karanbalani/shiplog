-- migrate:up
CREATE TABLE profile_snapshots (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  captured_on DATE NOT NULL,
  followers_count INT,
  following_count INT,
  public_repos_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, captured_on)
);

-- migrate:down
DROP TABLE IF EXISTS profile_snapshots;
