CREATE TABLE professional_feed_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  format text NOT NULL CHECK(format IN ('json','csv','xml')),
  schedule_cron text,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  transport jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,name)
);

CREATE INDEX professional_feeds_org_active
  ON professional_feed_definitions(organization_id,active,created_at);

CREATE TABLE professional_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id uuid NOT NULL REFERENCES professional_feed_definitions(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL CHECK(mode IN ('dry_run','apply')),
  status text NOT NULL CHECK(status IN ('running','succeeded','failed','quarantined')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX professional_import_runs_feed
  ON professional_import_runs(feed_id,created_at DESC);

CREATE TABLE professional_import_items (
  run_id uuid NOT NULL REFERENCES professional_import_runs(id) ON DELETE CASCADE,
  external_reference text NOT NULL,
  property_id uuid REFERENCES properties(id),
  listing_id uuid REFERENCES listings(id),
  status text NOT NULL CHECK(status IN ('valid','invalid','upserted','quarantined')),
  payload jsonb NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,external_reference)
);

CREATE INDEX professional_import_items_listing
  ON professional_import_items(listing_id)
  WHERE listing_id IS NOT NULL;
