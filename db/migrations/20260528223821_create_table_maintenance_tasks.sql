-- migrate:up
CREATE TABLE maintenance_tasks (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  task_type TEXT NOT NULL CHECK (task_type IN ('repair_range')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'running',
      'retry_wait',
      'succeeded',
      'failed_permanent'
    )
  ),
  priority INT NOT NULL DEFAULT 0,
  target_from_on DATE NOT NULL,
  target_to_on DATE NOT NULL,
  reason TEXT,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (target_from_on <= target_to_on),
  CHECK (attempts >= 0),
  CHECK (max_attempts >= 1),
  UNIQUE (
    account_id,
    task_type,
    target_from_on,
    target_to_on
  )
);

CREATE INDEX idx_maintenance_tasks_status_due ON maintenance_tasks (status, next_run_at, priority, id);

-- migrate:down
DROP TABLE IF EXISTS maintenance_tasks;
