-- migrate:up
CREATE TABLE organization_memberships (
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  organization_id BIGINT NOT NULL REFERENCES organizations (id),
  observed_on DATE NOT NULL,
  role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, organization_id, observed_on)
);

-- migrate:down
DROP TABLE IF EXISTS organization_memberships;
