CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK(email=lower(email)),
 password_hash text NOT NULL, display_name text NOT NULL, role text NOT NULL CHECK(role IN ('buyer','owner','agent','agency','developer','admin')),
 active boolean NOT NULL DEFAULT true, email_verified_at timestamptz, phone text UNIQUE, phone_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE,
 csrf_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_active ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE auth_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK(purpose IN ('email','phone','reset')),
 token_hash text NOT NULL UNIQUE, destination text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_user ON auth_challenges(user_id,purpose);
CREATE TABLE rate_limits (key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE TABLE organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, kind text NOT NULL CHECK(kind IN ('agency','developer')),
 active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
 organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('owner','admin','member')), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,user_id)
);
CREATE INDEX memberships_user ON memberships(user_id) WHERE active;
CREATE TABLE categories (code text PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true);
INSERT INTO categories(code,name) VALUES
 ('apartment','Квартира'),('room','Комната'),('aparthotel','Апартаменты'),('new_build','Новостройка'),('secondary','Вторичное жильё'),
 ('house','Дом/коттедж'),('townhouse','Таунхаус'),('land','Участок'),('commercial','Коммерческая недвижимость'),('parking','Гараж/парковка');
CREATE TABLE attribute_definitions (
 category_code text NOT NULL REFERENCES categories(code), code text NOT NULL, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('string','number','boolean','enum')), required boolean NOT NULL DEFAULT false,
 options jsonb NOT NULL DEFAULT '[]', PRIMARY KEY(category_code,code)
);
INSERT INTO attribute_definitions(category_code,code,name,kind,required)
 SELECT code,'area','Площадь, м²','number',true FROM categories;
CREATE TABLE addresses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formatted text NOT NULL, locality text NOT NULL, district text,
 point geometry(Point,4326) NOT NULL, provider text NOT NULL DEFAULT 'manual', provider_reference text,
 CHECK(ST_X(point) BETWEEN -180 AND 180 AND ST_Y(point) BETWEEN -90 AND 90), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_point ON addresses USING gist(point);
CREATE TABLE residential_complexes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, address_id uuid NOT NULL REFERENCES addresses(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE buildings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 complex_id uuid REFERENCES residential_complexes(id), address_id uuid NOT NULL REFERENCES addresses(id), name text NOT NULL,
 completion_date date, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid NOT NULL REFERENCES buildings(id), name text NOT NULL, UNIQUE(building_id,name));
CREATE TABLE floors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), section_id uuid NOT NULL REFERENCES sections(id), number integer NOT NULL, UNIQUE(section_id,number));
CREATE TABLE properties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid NOT NULL REFERENCES users(id), organization_id uuid REFERENCES organizations(id),
 category_code text NOT NULL REFERENCES categories(code), address_id uuid NOT NULL REFERENCES addresses(id), building_id uuid REFERENCES buildings(id),
 floor_id uuid REFERENCES floors(id), unit_number text, attributes jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX properties_owner ON properties(created_by);
CREATE INDEX properties_org ON properties(organization_id) WHERE organization_id IS NOT NULL;
CREATE TABLE listing_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('direct','agency','developer','feed','api')),
 organization_id uuid REFERENCES organizations(id), external_reference text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='direct' AND organization_id IS NULL) OR (kind IN ('agency','developer','feed','api') AND organization_id IS NOT NULL))
);
CREATE UNIQUE INDEX listing_sources_external ON listing_sources(organization_id,kind,external_reference) WHERE external_reference IS NOT NULL;
CREATE TABLE listings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), source_id uuid NOT NULL REFERENCES listing_sources(id),
 seller_id uuid NOT NULL REFERENCES users(id), organization_id uuid REFERENCES organizations(id), deal_type text NOT NULL CHECK(deal_type IN ('sale','long_rent','short_rent')),
 price numeric(16,2) CHECK(price>0), currency text NOT NULL DEFAULT 'RUB' CHECK(currency='RUB'), title text NOT NULL, description text NOT NULL DEFAULT '', terms jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','processing','moderation','published','paused','archived','sold','rented','rejected')),
 version integer NOT NULL DEFAULT 1, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_seller ON listings(seller_id,created_at,id);
CREATE INDEX listings_org ON listings(organization_id,created_at,id) WHERE organization_id IS NOT NULL;
CREATE TABLE listing_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, listing_id uuid NOT NULL REFERENCES listings(id), actor_id uuid NOT NULL REFERENCES users(id),
 event text NOT NULL, before_data jsonb NOT NULL DEFAULT '{}', after_data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_history_listing ON listing_history(listing_id,id);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, entity_type text NOT NULL,
 entity_id text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_events(entity_type,entity_id,id);
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'History is append-only'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_listing_history BEFORE UPDATE OR DELETE ON listing_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_id uuid NOT NULL REFERENCES listings(id), uploaded_by uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('photo','floor_plan')), original_key text NOT NULL, mime text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','ready','failed')), variants jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_listing ON media(listing_id,state);
CREATE TABLE media_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), media_id uuid NOT NULL UNIQUE REFERENCES media(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','dead')), attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_error text
);
CREATE INDEX media_jobs_claim ON media_jobs(available_at) WHERE state IN ('pending','running');
CREATE TABLE moderation_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_id uuid NOT NULL REFERENCES listings(id), listing_version integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','cancelled')), reviewer_id uuid REFERENCES users(id), reason text,
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE UNIQUE INDEX moderation_one_pending ON moderation_cases(listing_id) WHERE state='pending';
CREATE TABLE idempotency_records (
 actor_id uuid NOT NULL REFERENCES users(id), scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,scope,key)
);
