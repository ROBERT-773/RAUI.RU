-- Lock BEFORE the seed snapshot: a transaction alone does not close the seed/trigger gap.
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE memberships IN SHARE ROW EXCLUSIVE MODE;
CREATE SEQUENCE subscription_visibility_generation_seq AS bigint MINVALUE 1 NO CYCLE;
CREATE TABLE subscription_visibility_generations (
 kind text NOT NULL CHECK(kind IN ('seller','organization','membership')),
 identity text NOT NULL,
 generation bigint NOT NULL CHECK(generation>=0),
 PRIMARY KEY(kind,identity),
 CHECK((kind IN ('seller','organization') AND identity ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 OR (kind='membership' AND identity ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
INSERT INTO subscription_visibility_generations(kind,identity,generation) SELECT 'seller',id::text,0 FROM users;
INSERT INTO subscription_visibility_generations(kind,identity,generation) SELECT 'organization',id::text,0 FROM organizations;
INSERT INTO subscription_visibility_generations(kind,identity,generation) SELECT 'membership',organization_id::text||':'||user_id::text,0 FROM memberships;
CREATE FUNCTION protect_subscription_visibility_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Visibility generation cannot be deleted'; END IF;
 IF NEW.kind<>OLD.kind OR NEW.identity<>OLD.identity OR NEW.generation<=OLD.generation THEN
  RAISE EXCEPTION 'Visibility generation identity is immutable and generation must increase';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER subscription_visibility_generation_guard BEFORE UPDATE OR DELETE ON subscription_visibility_generations FOR EACH ROW EXECUTE FUNCTION protect_subscription_visibility_generation();
CREATE FUNCTION record_subscription_visibility_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dependency_kind text; dependency_identity text;
BEGIN
 IF TG_TABLE_NAME='users' THEN
  dependency_kind:='seller';
  IF TG_OP='UPDATE' THEN
   IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'Visibility dependency identity is immutable'; END IF;
   IF ROW(NEW.active,NEW.email_verified_at IS NOT NULL,NEW.phone_verified_at IS NOT NULL,NEW.role IN ('owner','agent','agency','developer','admin'))
    IS NOT DISTINCT FROM ROW(OLD.active,OLD.email_verified_at IS NOT NULL,OLD.phone_verified_at IS NOT NULL,OLD.role IN ('owner','agent','agency','developer','admin')) THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='DELETE' THEN dependency_identity:=OLD.id::text; ELSE dependency_identity:=NEW.id::text; END IF;
 ELSIF TG_TABLE_NAME='organizations' THEN
  dependency_kind:='organization';
  IF TG_OP='UPDATE' THEN
   IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'Visibility dependency identity is immutable'; END IF;
   IF NEW.active IS NOT DISTINCT FROM OLD.active THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='DELETE' THEN dependency_identity:=OLD.id::text; ELSE dependency_identity:=NEW.id::text; END IF;
 ELSE
  dependency_kind:='membership';
  IF TG_OP='UPDATE' THEN
   IF NEW.organization_id<>OLD.organization_id OR NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'Visibility dependency identity is immutable'; END IF;
   IF NEW.active IS NOT DISTINCT FROM OLD.active THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='DELETE' THEN dependency_identity:=OLD.organization_id::text||':'||OLD.user_id::text;
   ELSE dependency_identity:=NEW.organization_id::text||':'||NEW.user_id::text; END IF;
 END IF;
 INSERT INTO subscription_visibility_generations(kind,identity,generation)
 VALUES(dependency_kind,dependency_identity,nextval('subscription_visibility_generation_seq'))
 ON CONFLICT(kind,identity) DO UPDATE SET generation=nextval('subscription_visibility_generation_seq');
 RETURN NULL;
END $$;
CREATE TRIGGER users_subscription_visibility AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION record_subscription_visibility_generation();
CREATE TRIGGER organizations_subscription_visibility AFTER INSERT OR UPDATE OR DELETE ON organizations FOR EACH ROW EXECUTE FUNCTION record_subscription_visibility_generation();
CREATE TRIGGER memberships_subscription_visibility AFTER INSERT OR UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION record_subscription_visibility_generation();
