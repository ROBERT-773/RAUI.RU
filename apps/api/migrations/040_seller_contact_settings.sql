ALTER TABLE users ADD COLUMN contact_mode text NOT NULL DEFAULT 'messages'
  CHECK (contact_mode IN ('messages','calls','both'));

-- Only confirmed numbers live here. Slot zero mirrors the verified login
-- number. An advertisement must still select its specific ID to show it.
CREATE TABLE seller_contact_phones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 2),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id,slot),
  UNIQUE (user_id,phone),
  UNIQUE (user_id,id)
);

ALTER TABLE listings ADD CONSTRAINT listings_id_seller_key UNIQUE (id,seller_id);
CREATE TABLE listing_contact_phones (
  listing_id uuid NOT NULL,
  seller_id uuid NOT NULL,
  phone_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position IN (1,2)),
  PRIMARY KEY (listing_id,position),
  UNIQUE (listing_id,phone_id),
  FOREIGN KEY (listing_id,seller_id) REFERENCES listings(id,seller_id) ON DELETE CASCADE,
  FOREIGN KEY (seller_id,phone_id) REFERENCES seller_contact_phones(user_id,id) ON DELETE CASCADE
);
CREATE INDEX listing_contact_phones_reference ON listing_contact_phones(seller_id,phone_id);

-- A contact challenge cannot confirm a login, change account identity or
-- open a session. Reissuing for a destination replaces the previous code.
CREATE TABLE seller_contact_phone_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_digest text NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  delivery text NOT NULL DEFAULT 'unknown' CHECK (delivery IN ('accepted','unknown','unavailable')),
  UNIQUE (user_id,phone)
);

INSERT INTO seller_contact_phones(user_id,phone,slot,verified_at)
  SELECT id,phone,0,phone_verified_at FROM users
  WHERE phone_verified_at IS NOT NULL AND phone ~ '^\+[1-9][0-9]{7,14}$';

CREATE FUNCTION sync_seller_primary_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Changing the login never silently retargets an existing selection.
  DELETE FROM seller_contact_phones WHERE user_id=NEW.id AND slot=0
    AND (NEW.phone_verified_at IS NULL OR phone IS DISTINCT FROM NEW.phone);
  IF NEW.phone_verified_at IS NOT NULL AND NEW.phone ~ '^\+[1-9][0-9]{7,14}$' THEN
    INSERT INTO seller_contact_phones(user_id,phone,slot,verified_at)
    VALUES (NEW.id,NEW.phone,0,NEW.phone_verified_at)
    ON CONFLICT (user_id,phone) DO UPDATE
      SET slot=0,verified_at=EXCLUDED.verified_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_sync_seller_primary AFTER INSERT OR UPDATE OF phone,phone_verified_at ON users
  FOR EACH ROW EXECUTE FUNCTION sync_seller_primary_contact();
