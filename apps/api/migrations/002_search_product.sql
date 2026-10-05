-- Expand-only Phase 3. Public projection is authoritative at read time.
CREATE VIEW public_search_listings AS
SELECT l.id,l.title,l.description,l.price::float8 AS price,l.deal_type,l.published_at,
 p.category_code AS category,p.attributes || jsonb_strip_nulls(jsonb_build_object('floor',f.number,'building_year',EXTRACT(YEAR FROM b.completion_date))) AS attributes,a.formatted AS address,a.locality,a.district,
 ST_X(a.point) AS longitude,ST_Y(a.point) AS latitude,a.point,
 u.role AS seller_type,s.kind AS source_type,
 CASE WHEN (p.attributes->>'area') ~ '^[0-9]+(\.[0-9]+)?$' THEN l.price::float8 / NULLIF((p.attributes->>'area')::float8,0) END AS price_per_m2
FROM listings l JOIN users u ON u.id=l.seller_id JOIN properties p ON p.id=l.property_id
JOIN addresses a ON a.id=p.address_id JOIN listing_sources s ON s.id=l.source_id
LEFT JOIN floors f ON f.id=p.floor_id LEFT JOIN buildings b ON b.id=p.building_id
WHERE l.status='published' AND u.active AND u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL
AND u.role IN ('owner','agent','agency','developer','admin')
AND (l.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN memberships m ON m.organization_id=o.id
 WHERE o.id=l.organization_id AND o.active AND m.user_id=l.seller_id AND m.active));
CREATE SEQUENCE search_revision;
CREATE TABLE search_jobs(listing_id uuid PRIMARY KEY, revision bigint NOT NULL DEFAULT nextval('search_revision'), updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION dirty_search() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[]; sellers uuid[]; orgs uuid[];
BEGIN
 ids := ARRAY[(to_jsonb(NEW)->>'id')::uuid,(to_jsonb(OLD)->>'id')::uuid];
 sellers := ARRAY[(to_jsonb(NEW)->>'user_id')::uuid,(to_jsonb(OLD)->>'user_id')::uuid];
 orgs := ARRAY[(to_jsonb(NEW)->>'organization_id')::uuid,(to_jsonb(OLD)->>'organization_id')::uuid];
 INSERT INTO search_jobs(listing_id)
 SELECT l.id FROM listings l JOIN properties p ON p.id=l.property_id
 WHERE (TG_TABLE_NAME='listings' AND l.id=ANY(ids))
 OR (TG_TABLE_NAME='properties' AND p.id=ANY(ids))
 OR (TG_TABLE_NAME='addresses' AND p.address_id=ANY(ids))
 OR (TG_TABLE_NAME='users' AND l.seller_id=ANY(ids))
 OR (TG_TABLE_NAME='organizations' AND l.organization_id=ANY(ids))
 OR (TG_TABLE_NAME='memberships' AND l.organization_id=ANY(orgs) AND l.seller_id=ANY(sellers))
 OR (TG_TABLE_NAME='floors' AND p.floor_id=ANY(ids))
 OR (TG_TABLE_NAME='buildings' AND p.building_id=ANY(ids))
 OR (TG_TABLE_NAME='listing_sources' AND l.source_id=ANY(ids))
 ON CONFLICT(listing_id) DO UPDATE SET revision=nextval('search_revision'),updated_at=now();
 IF TG_TABLE_NAME='listings' AND TG_OP='DELETE' THEN
  INSERT INTO search_jobs(listing_id) VALUES(OLD.id) ON CONFLICT(listing_id) DO UPDATE SET revision=nextval('search_revision'),updated_at=now();
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER search_listings AFTER INSERT OR UPDATE OR DELETE ON listings FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_properties AFTER INSERT OR UPDATE OR DELETE ON properties FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_addresses AFTER INSERT OR UPDATE OR DELETE ON addresses FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_users AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_organizations AFTER UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_memberships AFTER INSERT OR UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_sources AFTER UPDATE ON listing_sources FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_floors AFTER UPDATE ON floors FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE TRIGGER search_buildings AFTER UPDATE ON buildings FOR EACH ROW EXECUTE FUNCTION dirty_search();
CREATE INDEX properties_floor_search ON properties(floor_id) WHERE floor_id IS NOT NULL;
CREATE INDEX properties_building_search ON properties(building_id) WHERE building_id IS NOT NULL;
CREATE INDEX listings_property_search ON listings(property_id);
CREATE INDEX listings_source_search ON listings(source_id);
CREATE INDEX properties_address_search ON properties(address_id);
INSERT INTO search_jobs(listing_id) SELECT id FROM listings;
CREATE TABLE account_listings(user_id uuid NOT NULL REFERENCES users(id),listing_id uuid NOT NULL REFERENCES listings(id),kind text NOT NULL CHECK(kind IN ('favorite','compare','recent')),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,listing_id,kind));
CREATE INDEX account_listings_page ON account_listings(user_id,kind,updated_at DESC,listing_id);
CREATE TABLE saved_searches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,definition jsonb NOT NULL,subscription_enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX saved_search_owner ON saved_searches(user_id,created_at DESC,id);
CREATE TABLE inquiry_threads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),listing_id uuid NOT NULL REFERENCES listings(id),buyer_id uuid NOT NULL REFERENCES users(id),seller_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(listing_id,buyer_id));
CREATE INDEX inquiry_buyer ON inquiry_threads(buyer_id,created_at DESC,id);
CREATE INDEX inquiry_seller ON inquiry_threads(seller_id,created_at DESC,id);
CREATE TABLE inquiry_messages(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,thread_id uuid NOT NULL REFERENCES inquiry_threads(id),sender_id uuid NOT NULL REFERENCES users(id),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX inquiry_message_page ON inquiry_messages(thread_id,id DESC);
CREATE TABLE notifications(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),thread_id uuid NOT NULL REFERENCES inquiry_threads(id),kind text NOT NULL CHECK(kind='message'),read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX notification_page ON notifications(user_id,id DESC);
CREATE TABLE notification_preferences(user_id uuid PRIMARY KEY REFERENCES users(id),in_app boolean NOT NULL DEFAULT true,email boolean NOT NULL DEFAULT false,sms boolean NOT NULL DEFAULT false,push boolean NOT NULL DEFAULT false);
CREATE TABLE notification_outbox(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,notification_id bigint NOT NULL REFERENCES notifications(id),channel text NOT NULL CHECK(channel IN ('email','sms','push')),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','dead')),attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),UNIQUE(notification_id,channel));

-- Optional Phase 3 typed attributes; no backfill or invented property values.
INSERT INTO attribute_definitions(category_code,code,name,kind)
SELECT c.code,a.code,a.name,a.kind FROM categories c CROSS JOIN (VALUES
 ('rooms','Комнаты','number'),('floor','Этаж','number'),('floors','Этажей','number'),
 ('building_year','Год постройки','number'),('building_type','Тип дома','string'),
 ('renovation','Ремонт','string'),('bathroom','Санузел','string'),('balcony','Балкон','boolean'),
 ('loggia','Лоджия','boolean'),('ceiling_height','Высота потолков','number'),('elevator','Лифт','boolean'),
 ('parking','Парковка','string'),('furniture','Мебель','boolean'),('equipment','Техника','boolean'),
 ('mortgage','Ипотека','boolean'),('market','Рынок','string'),('metro','Метро','string'),
 ('okrug','Округ','string'),('highway','Шоссе','string'),('highway_distance','До шоссе, км','number')
) AS a(code,name,kind) ON CONFLICT DO NOTHING;
