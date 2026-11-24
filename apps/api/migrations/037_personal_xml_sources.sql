-- Existing organization feeds retain their owner, records, configuration and run history.
ALTER TABLE professional_feed_definitions ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE professional_import_runs ALTER COLUMN organization_id DROP NOT NULL;
CREATE UNIQUE INDEX personal_feed_names ON professional_feed_definitions(created_by,name)
 WHERE organization_id IS NULL;
-- Identify previously connected link previews via their audit provenance.
-- Retain the history of every source, including older sources for the same slot.
WITH linked AS (
 SELECT f.id,row_number() OVER (PARTITION BY f.organization_id,f.transport->>'provider' ORDER BY f.created_at DESC,f.id DESC) AS recency
 FROM professional_feed_definitions f
 WHERE f.format='xml' AND f.schedule_cron IS NULL AND f.transport->>'kind'='https'
 AND f.transport->>'provider' IN ('yandex','avito','cian','domclick')
 AND EXISTS (SELECT 1 FROM audit_events a WHERE a.action='professional.feed.queued' AND
   a.data->>'source'='url' AND a.data->>'feedId'=f.id::text)
)
UPDATE professional_feed_definitions f SET transport=f.transport||'{"linkSlot":true}'::jsonb
 FROM linked l WHERE f.id=l.id AND l.recency=1;
CREATE UNIQUE INDEX professional_org_link_slots ON professional_feed_definitions(organization_id,(transport->>'provider'))
 WHERE organization_id IS NOT NULL AND transport->>'linkSlot'='true';
CREATE UNIQUE INDEX professional_personal_link_slots ON professional_feed_definitions(created_by,(transport->>'provider'))
 WHERE organization_id IS NULL AND transport->>'linkSlot'='true';

ALTER TABLE listing_sources ADD COLUMN personal_feed_owner_id uuid REFERENCES users(id);
ALTER TABLE listing_sources DROP CONSTRAINT listing_sources_check;
ALTER TABLE listing_sources ADD CONSTRAINT listing_sources_check CHECK (
 (kind='direct' AND organization_id IS NULL AND personal_feed_owner_id IS NULL)
 OR (kind IN ('agency','developer','feed','api') AND organization_id IS NOT NULL AND personal_feed_owner_id IS NULL)
 OR (kind='feed' AND organization_id IS NULL AND personal_feed_owner_id IS NOT NULL)
);
CREATE UNIQUE INDEX personal_listing_sources_external ON listing_sources(personal_feed_owner_id,external_reference)
 WHERE personal_feed_owner_id IS NOT NULL AND external_reference IS NOT NULL;
