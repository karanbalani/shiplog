-- migrate:up
CREATE TABLE error_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

CREATE INDEX idx_error_events_created_at ON error_events (created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS error_events;
