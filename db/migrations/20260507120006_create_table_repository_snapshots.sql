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

-- migrate:down
DROP TABLE IF EXISTS repository_snapshots;
