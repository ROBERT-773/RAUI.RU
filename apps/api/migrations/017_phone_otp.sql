CREATE TABLE phone_otp_challenges (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 destination text NOT NULL,
 code_digest text NOT NULL,
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 used_at timestamptz,
 invalidated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dispatch_state text NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending','accepted','unavailable','unknown'))
);
CREATE INDEX phone_otp_challenges_user_created ON phone_otp_challenges(user_id,created_at);
CREATE TABLE phone_otp_send_events (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 destination_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX phone_otp_send_events_destination_created ON phone_otp_send_events(destination_digest,created_at);
CREATE INDEX phone_otp_send_events_user_created ON phone_otp_send_events(user_id,created_at);
