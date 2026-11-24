CREATE TABLE portal_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  message text NOT NULL CHECK (message=btrim(message) AND char_length(message) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (author_id,request_id)
);

CREATE INDEX portal_feedback_newest ON portal_feedback (created_at DESC,id DESC);
