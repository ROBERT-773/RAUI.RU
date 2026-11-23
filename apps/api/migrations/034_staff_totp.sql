CREATE TABLE staff_totp_factors (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 encrypted_secret text NOT NULL,
 enrollment_expires_at timestamptz NOT NULL,
 enrollment_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
 activated_at timestamptz,
 last_verified_step bigint CHECK (last_verified_step >= 0),
 CHECK ((activated_at IS NULL) = (last_verified_step IS NULL)),
 CHECK ((activated_at IS NULL) = (enrollment_session_id IS NOT NULL))
);

ALTER TABLE sessions
 ADD COLUMN staff_totp_factor_id uuid,
 ADD COLUMN staff_assured_until timestamptz,
 ADD CONSTRAINT sessions_staff_assurance_pair CHECK (
   (staff_totp_factor_id IS NULL) = (staff_assured_until IS NULL)
 );
