-- Preserve every existing account; application signup explicitly requests approval.
ALTER TABLE users ADD COLUMN registration_approval_state text NOT NULL DEFAULT 'approved'
 CHECK (registration_approval_state IN ('pending','approved','rejected'));
CREATE TABLE registration_approval_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL UNIQUE REFERENCES users(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 reviewer_id uuid REFERENCES users(id), reason text, resolved_at timestamptz,
 CHECK ((state='pending' AND reviewer_id IS NULL AND reason IS NULL AND resolved_at IS NULL)
  OR (state IN ('approved','rejected') AND reviewer_id IS NOT NULL
      AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 3 AND 2000 AND resolved_at IS NOT NULL))
);
CREATE INDEX registration_approval_pending ON registration_approval_requests(requested_at,id) WHERE state='pending';
ALTER TABLE staff_permission_grants DROP CONSTRAINT staff_permission_grants_permission_check;
ALTER TABLE staff_permission_grants ADD CONSTRAINT staff_permission_grants_permission_check
 CHECK(permission IN ('moderation.read','moderation.decide','registration.read','registration.decide'));
