CREATE TABLE listing_form_drafts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  form jsonb,
  listing_id uuid UNIQUE REFERENCES listings(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (listing_id IS NULL AND form IS NOT NULL AND jsonb_typeof(form) = 'object') OR
    (listing_id IS NOT NULL AND form IS NULL)
  )
);

CREATE INDEX listing_form_drafts_owner_pending
  ON listing_form_drafts (owner_id, updated_at DESC, id)
  WHERE listing_id IS NULL;
