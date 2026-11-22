CREATE TABLE public_professional_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid UNIQUE REFERENCES users(id),
  agency_id uuid UNIQUE REFERENCES organizations(id),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  published_at timestamptz,
  CHECK ((agent_id IS NULL) <> (agency_id IS NULL))
);

CREATE TABLE public_professional_regions (
  profile_id uuid NOT NULL REFERENCES public_professional_profiles(id) ON DELETE CASCADE,
  region_code text NOT NULL CHECK (region_code ~ '^[a-z][a-z0-9_]{0,49}$'),
  PRIMARY KEY (profile_id, region_code)
);

CREATE INDEX public_professional_regions_lookup
  ON public_professional_regions (region_code, profile_id);
