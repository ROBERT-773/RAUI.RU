-- Expand-only operations for the Phase 4B schema; historical rows remain intact.
ALTER TABLE professional_feed_definitions ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE professional_feed_definitions ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX professional_feed_schedule ON professional_feed_definitions(next_run_at) WHERE active AND schedule_cron IS NOT NULL;
CREATE TABLE professional_import_jobs (
 run_id uuid PRIMARY KEY REFERENCES professional_import_runs(id), payload jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','dead')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, last_error text
);
CREATE INDEX professional_import_jobs_claim ON professional_import_jobs(available_at) WHERE state IN ('pending','running');
CREATE TABLE professional_feed_records (
 feed_id uuid NOT NULL REFERENCES professional_feed_definitions(id), external_reference text NOT NULL,
 listing_id uuid NOT NULL UNIQUE REFERENCES listings(id), property_id uuid NOT NULL REFERENCES properties(id),
 source_id uuid NOT NULL UNIQUE REFERENCES listing_sources(id), fingerprint text,
 last_run_id uuid REFERENCES professional_import_runs(id), PRIMARY KEY(feed_id,external_reference)
);
-- Trace old manually imported sources without changing source IDs or property identities.
INSERT INTO professional_feed_records(feed_id,external_reference,listing_id,property_id,source_id)
 SELECT f.id,COALESCE(s.metadata->>'externalReference',s.external_reference),l.id,l.property_id,s.id
 FROM professional_feed_definitions f JOIN listing_sources s ON s.metadata->>'feedId'=f.id::text AND s.organization_id=f.organization_id
 JOIN listings l ON l.source_id=s.id AND l.organization_id=f.organization_id
 WHERE s.kind='feed' AND s.external_reference IS NOT NULL
 ON CONFLICT DO NOTHING;
ALTER TABLE notification_deliveries ADD COLUMN lease_token uuid;
ALTER TABLE partner_clients ADD COLUMN expires_at timestamptz;
CREATE INDEX professional_records_property ON professional_feed_records(property_id);
