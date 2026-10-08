# Account launch foundation

Owner request: audit today's requirements, prioritize launch, implement the passing initial scope. Issue: https://github.com/ROBERT-773/RAUI.RU/issues/73.

## Scope and sequence

1. Reconcile latest instructions in ACCOUNT_APPROVAL_RETENTION_DESIGN.md. Separate implementation, passing checks and deployment.
2. Migration014: immutable positive unique numeric public_id for existing/new users, keeping UUID relationships. API returns decimal string through an explicit safe projection. Account shows ID; knowing it cannot reset a password.
3. Migration015: default-deny named moderation.read/moderation.decide grants. Only administrator manages grants with reason and audit; fresh server lookup makes revoked permission unavailable on subsequent requests. Existing owner/version/idempotency/CSRF rules remain.
4. Add an administrator staff-permission screen with narrow proxy routes. This is a rights-management foundation, not a complete moderator workspace.
5. Verify meaningful real HTTP tests, preserved populated upgrade, full repository checks, production-build smoke and recovery. Update release contracts to15 immutable migrations.

## Excluded activation

SMS registration and staff approval, full administrator cabinet editing, complaints/reasoned blocks,30-day and90-day cleanup, tariff removal and three-month registration embargo remain later stages. They require their own implementation and acceptance. No destructive processing or remote database migration is activated by this foundation.

## Acceptance

- Numeric ID assigned on upgrade/register, unchanged across profile/session changes; protected from reassignment, bigint encoded as string.
- No password or future internal user columns exposed by authentication responses.
- No permissions by default; administrator can grant/revoke; users cannot self-grant or gain other administrator operations.
- Read permission cannot decide; decision permission preserves own-listing restriction and audit; revocation denies the next request.
- Administrator UI reports failed updates and reads actual persisted grants.
- Existing application checks stay green; migration/backup/release tests include new schema.

Rollback: retain additive schema and existing ID values, remove new UI/routes if necessary. Reverting application must not reset the sequence or reassign IDs. No real data is deleted.
