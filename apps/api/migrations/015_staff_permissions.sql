-- Additive, default-deny delegated staff capabilities. Does not change user roles.
CREATE TABLE staff_permission_grants (
 user_id uuid NOT NULL REFERENCES users(id),
 permission text NOT NULL CHECK(permission IN ('moderation.read','moderation.decide')),
 granted_by uuid NOT NULL REFERENCES users(id),
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,permission)
);
