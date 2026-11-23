ALTER TABLE users ADD COLUMN phone_sign_in_enrolled_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_phone_sign_in_requires_verified_phone
 CHECK (phone_sign_in_enrolled_at IS NULL OR (phone IS NOT NULL AND phone_verified_at IS NOT NULL));

CREATE FUNCTION clear_phone_sign_in_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.phone IS DISTINCT FROM OLD.phone OR NEW.phone_verified_at IS NULL THEN
  NEW.phone_sign_in_enrolled_at := NULL;
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER users_clear_phone_sign_in_enrollment
 BEFORE UPDATE OF phone,phone_verified_at ON users
 FOR EACH ROW EXECUTE FUNCTION clear_phone_sign_in_enrollment();
