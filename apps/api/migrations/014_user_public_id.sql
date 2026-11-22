-- Public identifiers are independent of internal UUIDs and never credentials.
-- PostgreSQL assigns existing rows and subsequent users from the same sequence.
ALTER TABLE users ADD COLUMN public_id bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE users ADD CONSTRAINT users_public_id_positive CHECK (public_id > 0);
ALTER TABLE users ADD CONSTRAINT users_public_id_unique UNIQUE (public_id);

CREATE FUNCTION preserve_user_public_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'User public ID is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_public_id_immutable BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION preserve_user_public_id();
