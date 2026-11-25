-- Existing sessions continue to require the current password.
ALTER TABLE sessions ADD COLUMN password_change_until timestamptz;

CREATE FUNCTION expire_session_password_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sessions SET password_change_until = NULL
  WHERE user_id = NEW.id AND password_change_until IS NOT NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER expire_session_password_change
AFTER UPDATE OF email,email_verified_at,phone,phone_verified_at,phone_sign_in_enrolled_at,password_hash,active,role,registration_approval_state ON users
FOR EACH ROW WHEN (
  (OLD.email,OLD.email_verified_at,OLD.phone,OLD.phone_verified_at,OLD.phone_sign_in_enrolled_at,OLD.password_hash,OLD.active,OLD.role,OLD.registration_approval_state)
  IS DISTINCT FROM
  (NEW.email,NEW.email_verified_at,NEW.phone,NEW.phone_verified_at,NEW.phone_sign_in_enrolled_at,NEW.password_hash,NEW.active,NEW.role,NEW.registration_approval_state)
)
EXECUTE FUNCTION expire_session_password_change();
