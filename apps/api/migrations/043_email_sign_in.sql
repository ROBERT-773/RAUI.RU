CREATE TABLE email_sign_in_challenges (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  destination_digest text NOT NULL CHECK(destination_digest ~ '^[0-9a-f]{64}$'),
  browser_digest text NOT NULL CHECK(browser_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  code_digest text NOT NULL CHECK(code_digest ~ '^[0-9a-f]{64}$'),
  eligible_at_request boolean NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at > created_at),
  attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  used_at timestamptz,
  UNIQUE(browser_digest,request_digest)
);
CREATE INDEX email_sign_in_sends ON email_sign_in_challenges(destination_digest,created_at);
CREATE INDEX email_sign_in_user ON email_sign_in_challenges(user_id) WHERE used_at IS NULL;
CREATE TABLE email_sign_in_failures (
  destination_digest text NOT NULL CHECK(destination_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_sign_in_guess_budget ON email_sign_in_failures(destination_digest,occurred_at);

-- Old application versions can rotate credentials as well. Invalidate in the
-- same transaction and preserve the tombstone used for idempotent retries.
CREATE FUNCTION expire_email_sign_in_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE email_sign_in_challenges SET used_at=clock_timestamp()
  WHERE user_id=NEW.id AND used_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER expire_email_sign_in_credentials
AFTER UPDATE OF email,email_verified_at,password_hash,active,role,registration_approval_state ON users
FOR EACH ROW WHEN (
  (OLD.email,OLD.email_verified_at,OLD.password_hash,OLD.active,OLD.role,OLD.registration_approval_state)
  IS DISTINCT FROM
  (NEW.email,NEW.email_verified_at,NEW.password_hash,NEW.active,NEW.role,NEW.registration_approval_state)
)
EXECUTE FUNCTION expire_email_sign_in_credentials();
