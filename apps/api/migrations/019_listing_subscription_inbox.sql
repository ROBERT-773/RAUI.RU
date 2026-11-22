ALTER TABLE notifications ALTER COLUMN thread_id DROP NOT NULL;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD COLUMN listing_id uuid REFERENCES listings(id);
ALTER TABLE notifications ADD COLUMN subscription_version integer;
ALTER TABLE notifications ADD COLUMN listing_version integer;
ALTER TABLE notifications ADD COLUMN dedupe_key text;
ALTER TABLE notifications ADD COLUMN payload jsonb;
ALTER TABLE notifications ADD CONSTRAINT notifications_shape_check CHECK (
 (kind='message' AND thread_id IS NOT NULL AND listing_id IS NULL
  AND subscription_version IS NULL AND listing_version IS NULL
  AND dedupe_key IS NULL AND payload IS NULL)
 OR
 (kind IN ('subscription.listing.price_drop','subscription.listing.availability')
  AND thread_id IS NULL AND listing_id IS NOT NULL
  AND subscription_version IS NOT NULL AND subscription_version>0
  AND listing_version IS NOT NULL AND listing_version>0
  AND dedupe_key IS NOT NULL AND length(dedupe_key)>0
  AND payload IS NOT NULL AND jsonb_typeof(payload)='object')
);
CREATE UNIQUE INDEX notifications_subscription_dedupe ON notifications(user_id,dedupe_key)
 WHERE kind IN ('subscription.listing.price_drop','subscription.listing.availability');
