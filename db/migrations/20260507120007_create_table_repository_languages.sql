-- migrate:up
CREATE TABLE repository_languages (
  id BIGSERIAL PRIMARY KEY,
  repository_id BIGINT NOT NULL REFERENCES repositories (id),
  captured_on DATE NOT NULL,
  language TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  percentage NUMERIC(7, 4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, captured_on, language)
);

-- migrate:down
DROP TABLE IF EXISTS repository_languages;
