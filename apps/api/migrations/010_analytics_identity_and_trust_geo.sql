-- Forward-only refinement. 009 and existing applied SQL stay byte-identical.
-- Phase 4C is not deployed: 010 follows 009 before enabling collection.
-- Stop on conflicting event identities; never delete or silently coalesce historical records.
CREATE UNIQUE INDEX analytics_event_identity ON analytics_events(event_key);
-- Candidate lookup uses ST_DWithin geography in meters, not guessed degree distances.
CREATE INDEX addresses_geography_trust ON addresses USING gist((point::geography));
