-- migrate:up
ALTER TABLE accounts
ADD COLUMN last_successful_collect_on DATE;

-- migrate:down
ALTER TABLE accounts
DROP COLUMN IF EXISTS last_successful_collect_on;
