-- Daily in-app only. Existing immediate/email behavior and 001--019 stay intact.
CREATE TABLE listing_daily_candidates (
 id bigserial PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 listing_id uuid NOT NULL REFERENCES listings(id),
 subscription_version integer NOT NULL CHECK(subscription_version>0),
 listing_version integer NOT NULL CHECK(listing_version>0),
 kind text NOT NULL CHECK(kind IN ('subscription.listing.price_drop','subscription.listing.availability')),
 dedupe_key text NOT NULL CHECK(length(dedupe_key)>0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 UNIQUE(user_id,dedupe_key), UNIQUE(id,user_id),
 CHECK(expires_at>created_at)
);
CREATE INDEX listing_daily_candidates_pending ON listing_daily_candidates(user_id,created_at,id);
CREATE TRIGGER listing_daily_candidates_immutable BEFORE UPDATE OR DELETE ON listing_daily_candidates FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE listing_daily_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 release_day date NOT NULL,
 cutoff timestamptz NOT NULL,
 released_at timestamptz,
 UNIQUE(user_id,release_day), UNIQUE(id,user_id),
 CHECK(released_at IS NULL OR released_at>=cutoff)
);
CREATE FUNCTION protect_listing_daily_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Daily run is immutable'; END IF;
 IF OLD.released_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
    OR NEW.release_day<>OLD.release_day OR NEW.cutoff<>OLD.cutoff OR NEW.released_at IS NULL
 THEN RAISE EXCEPTION 'Daily run identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_daily_runs_protected BEFORE UPDATE OR DELETE ON listing_daily_runs FOR EACH ROW EXECUTE FUNCTION protect_listing_daily_run();
ALTER TABLE notifications ADD COLUMN captured_frequency text;
ALTER TABLE notifications ADD COLUMN daily_run_id uuid;
ALTER TABLE notifications ADD CONSTRAINT notifications_id_user_unique UNIQUE(id,user_id);
ALTER TABLE notifications ADD CONSTRAINT notifications_daily_run_user_fk FOREIGN KEY(daily_run_id,user_id) REFERENCES listing_daily_runs(id,user_id);
ALTER TABLE notifications ADD CONSTRAINT notifications_frequency_shape CHECK (
 (kind='message' AND captured_frequency IS NULL AND daily_run_id IS NULL)
 OR (kind<>'message' AND (
   (captured_frequency IS NULL AND daily_run_id IS NULL)
   OR (captured_frequency='immediate' AND captured_frequency IS NOT NULL AND daily_run_id IS NULL)
   OR (captured_frequency='daily' AND captured_frequency IS NOT NULL AND daily_run_id IS NOT NULL)
 ))
);
CREATE TABLE listing_daily_items (
 run_id uuid NOT NULL,
 user_id uuid NOT NULL,
 candidate_id bigint NOT NULL UNIQUE,
 notification_id bigint UNIQUE,
 outcome text NOT NULL CHECK(outcome IN ('released','skipped')),
 PRIMARY KEY(run_id,candidate_id),
 FOREIGN KEY(run_id,user_id) REFERENCES listing_daily_runs(id,user_id),
 FOREIGN KEY(candidate_id,user_id) REFERENCES listing_daily_candidates(id,user_id),
 FOREIGN KEY(notification_id,user_id) REFERENCES notifications(id,user_id),
 CHECK((outcome='released' AND notification_id IS NOT NULL) OR (outcome='skipped' AND notification_id IS NULL))
);
CREATE TRIGGER listing_daily_items_immutable BEFORE UPDATE OR DELETE ON listing_daily_items FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_listing_daily_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE released timestamptz;
BEGIN
 SELECT released_at INTO released FROM listing_daily_runs WHERE id=NEW.run_id AND user_id=NEW.user_id FOR UPDATE;
 IF NOT FOUND OR released IS NOT NULL THEN RAISE EXCEPTION 'Daily manifest is closed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_daily_items_open_run BEFORE INSERT ON listing_daily_items FOR EACH ROW EXECUTE FUNCTION protect_listing_daily_item_insert();
