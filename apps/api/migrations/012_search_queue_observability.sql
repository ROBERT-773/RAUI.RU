-- Additive, compatible with existing producers/workers. Historical migrations
-- remain immutable. Existing age is an approximation from last dirty update.
ALTER TABLE search_jobs ADD COLUMN enqueued_at timestamptz NOT NULL DEFAULT now();
UPDATE search_jobs SET enqueued_at=updated_at;

CREATE OR REPLACE FUNCTION dirty_search() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[]; sellers uuid[]; orgs uuid[];
BEGIN
 -- Avoid the generic multi-table lookup on the hot listing write path.
 -- Keep both identities for a primary-key change, including delete tombstones.
 IF TG_TABLE_NAME='listings' THEN
  INSERT INTO search_jobs(listing_id)
  SELECT DISTINCT candidate.id FROM unnest(ARRAY[
   (to_jsonb(NEW)->>'id')::uuid,(to_jsonb(OLD)->>'id')::uuid
  ]) AS candidate(id) WHERE candidate.id IS NOT NULL
  ON CONFLICT(listing_id) DO UPDATE SET revision=nextval('search_revision'),updated_at=now();
  RETURN NULL;
 END IF;
 ids := ARRAY[(to_jsonb(NEW)->>'id')::uuid,(to_jsonb(OLD)->>'id')::uuid];
 sellers := ARRAY[(to_jsonb(NEW)->>'user_id')::uuid,(to_jsonb(OLD)->>'user_id')::uuid];
 orgs := ARRAY[(to_jsonb(NEW)->>'organization_id')::uuid,(to_jsonb(OLD)->>'organization_id')::uuid];
 INSERT INTO search_jobs(listing_id)
 SELECT l.id FROM listings l JOIN properties p ON p.id=l.property_id
 WHERE (TG_TABLE_NAME='listings' AND l.id=ANY(ids))
 OR (TG_TABLE_NAME='properties' AND p.id=ANY(ids))
 OR (TG_TABLE_NAME='addresses' AND p.address_id=ANY(ids))
 OR (TG_TABLE_NAME='users' AND l.seller_id=ANY(ids))
 OR (TG_TABLE_NAME='organizations' AND l.organization_id=ANY(ids))
 OR (TG_TABLE_NAME='memberships' AND l.organization_id=ANY(orgs) AND l.seller_id=ANY(sellers))
 OR (TG_TABLE_NAME='floors' AND p.floor_id=ANY(ids))
 OR (TG_TABLE_NAME='buildings' AND p.building_id=ANY(ids))
 OR (TG_TABLE_NAME='listing_sources' AND l.source_id=ANY(ids))
 ON CONFLICT(listing_id) DO UPDATE SET revision=nextval('search_revision'),updated_at=now();
 IF TG_TABLE_NAME='listings' AND TG_OP='DELETE' THEN
  INSERT INTO search_jobs(listing_id) VALUES(OLD.id) ON CONFLICT(listing_id) DO UPDATE SET revision=nextval('search_revision'),updated_at=now();
 END IF;
 RETURN NULL;
END $$;
