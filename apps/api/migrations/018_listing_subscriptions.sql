CREATE TABLE listing_subscriptions (
 user_id uuid NOT NULL REFERENCES users(id),
 listing_id uuid NOT NULL REFERENCES listings(id),
 events text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 2 AND events <@ ARRAY['price_drop','availability']::text[]),
 channels text[] NOT NULL CHECK (cardinality(channels) BETWEEN 1 AND 2 AND channels <@ ARRAY['in_app','email']::text[]),
 frequency text NOT NULL CHECK (frequency IN ('immediate','daily')),
 consent_version text NOT NULL,
 consented_at timestamptz NOT NULL DEFAULT now(),
 disabled_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,listing_id)
);
CREATE INDEX listing_subscriptions_active_listing ON listing_subscriptions(listing_id) WHERE disabled_at IS NULL;
