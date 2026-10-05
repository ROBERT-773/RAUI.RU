CREATE TABLE partner_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  token_digest text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  requests_per_minute integer NOT NULL DEFAULT 60 CHECK(requests_per_minute BETWEEN 1 AND 1000),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX partner_clients_org
  ON partner_clients(organization_id,active);

CREATE TABLE partner_client_usage (
  client_id uuid PRIMARY KEY REFERENCES partner_clients(id) ON DELETE CASCADE,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL
);
