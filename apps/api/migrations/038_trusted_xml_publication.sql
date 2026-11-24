ALTER TABLE professional_feed_definitions
  ADD COLUMN publication_approved_at timestamptz,
  ADD COLUMN publication_approved_by uuid REFERENCES users(id),
  ADD COLUMN last_apply_run_id uuid REFERENCES professional_import_runs(id),
  ADD CONSTRAINT professional_link_approval CHECK (
    (publication_approved_at IS NULL) = (publication_approved_by IS NULL)
    AND (publication_approved_at IS NULL OR (
      active AND format='xml' AND transport @> '{"kind":"https","linkSlot":true}' AND schedule_cron IS NULL
    ))
  );
CREATE INDEX professional_trusted_xml_due ON professional_feed_definitions(next_run_at)
  WHERE publication_approved_at IS NOT NULL;
ALTER TABLE professional_import_runs ADD COLUMN source_version integer CHECK(source_version>0);
CREATE INDEX professional_versioned_runs ON professional_import_runs(feed_id, source_version, mode, created_at DESC, id DESC)
  WHERE source_version IS NOT NULL;
ALTER TABLE professional_import_items ADD COLUMN publication_result text
  CHECK(publication_result IS NULL OR (status='upserted' AND publication_result IN ('created','updated','unchanged')));
CREATE INDEX professional_feed_refs_folded ON professional_feed_records(feed_id,lower(external_reference));

ALTER TABLE media ADD COLUMN feed_photo_position integer CHECK (feed_photo_position >= 0);

-- A reservation is committed before storage writes. Publishing its media and retiring
-- the reservation share one transaction. An interrupted prepare becomes collectible.
CREATE TABLE professional_photo_cleanup (
  media_id uuid PRIMARY KEY,
  object_keys text[] NOT NULL CHECK (cardinality(object_keys) BETWEEN 1 AND 8),
  available_at timestamptz NOT NULL,
  cleaning boolean NOT NULL DEFAULT false
);
CREATE INDEX professional_photo_cleanup_due ON professional_photo_cleanup(available_at);

CREATE FUNCTION enqueue_removed_feed_photo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO professional_photo_cleanup(media_id,object_keys,available_at)
  VALUES(OLD.id, ARRAY[OLD.original_key] || ARRAY(
    SELECT v->>'key' FROM jsonb_each(OLD.variants) AS variant(k,v)
  ), clock_timestamp());
  RETURN OLD;
END;
$$;
CREATE TRIGGER removed_feed_photo_cleanup AFTER DELETE ON media
FOR EACH ROW WHEN (OLD.feed_photo_position IS NOT NULL)
EXECUTE FUNCTION enqueue_removed_feed_photo();
