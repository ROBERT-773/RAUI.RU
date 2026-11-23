CREATE TABLE phone_sign_in_challenges (
 id uuid PRIMARY KEY,
 user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 destination_digest text NOT NULL CHECK (destination_digest ~ '^[0-9a-f]{64}$'),
 browser_digest text NOT NULL CHECK (browser_digest ~ '^[0-9a-f]{64}$'),
 request_key_digest text NOT NULL CHECK (request_key_digest ~ '^[0-9a-f]{64}$'),
 code_digest text NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 used_at timestamptz,
 dispatch_state text NOT NULL DEFAULT 'pending'
   CHECK (dispatch_state IN ('pending','accepted','unavailable','unknown')),
 signup_digest text UNIQUE CHECK (signup_digest ~ '^[0-9a-f]{64}$'),
 signup_expires_at timestamptz,
 signup_used_at timestamptz,
 UNIQUE (browser_digest, request_key_digest),
 CHECK (expires_at > created_at),
 CHECK ((signup_digest IS NULL) = (signup_expires_at IS NULL)),
 CHECK (signup_digest IS NULL OR (user_id IS NULL AND used_at IS NOT NULL)),
 CHECK (signup_used_at IS NULL OR signup_digest IS NOT NULL)
);
CREATE INDEX phone_sign_in_challenges_expiry ON phone_sign_in_challenges(expires_at);
CREATE INDEX phone_sign_in_challenges_user ON phone_sign_in_challenges(user_id)
 WHERE user_id IS NOT NULL;

-- Unauthenticated requests reserve a destination budget before there is a user.
ALTER TABLE phone_otp_send_events ALTER COLUMN user_id DROP NOT NULL;
