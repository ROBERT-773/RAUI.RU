CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_hash text NOT NULL UNIQUE,
  topic text NOT NULL CHECK (topic IN ('login','listing','moderation','photos','complaint','ownership','xml','commercial','other')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  listing_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reply text CHECK (char_length(reply) BETWEEN 1 AND 2000),
  replied_at timestamptz,
  replied_by uuid REFERENCES users(id),
  CHECK ((reply IS NULL) = (replied_at IS NULL))
);
CREATE INDEX support_tickets_queue ON support_tickets (created_at,id) WHERE reply IS NULL;
