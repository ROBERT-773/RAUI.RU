# Backup, restore and disaster recovery

## Local verification

Run `pnpm infra:up`, `pnpm build`, `pnpm db:migrate`, then `pnpm recovery:drill`.
The drill requires an explicit loopback development DATABASE_URL and the local
Compose PostgreSQL service. It holds a read-only repeatable-read exported snapshot,
uses `pg_dump --snapshot` and streams the custom dump into AES-256-GCM encryption.
A generated 256-bit key stays in memory; nonce/tag and ciphertext checksum identify
the envelope. Private temporary files/directories use 0600/0700 permissions.

Authentication completes before pg_restore sees plaintext. The script creates a
fresh random `raui_restore_test_*` database; it never drops or restores the source.
It compares every public table's count and content digest, migration checksums,
sequence positions and PostGIS version, then checks an encrypted private-object
fixture. Scratch DB, plaintext/ciphertext fixtures and in-memory key are removed
in cleanup. The persisted `.cache/phase4d-recovery.json` contains only verification
metadata and timing. Tests reject remote/original names, traversal paths, wrong
keys and corrupted ciphertext. The drill is verification, not a retained backup.

## Production contract — activate separately

Before launch, configure managed PostgreSQL base backups plus continuous WAL/PITR,
private encrypted storage with immutable retention, an independent region/account
copy and a least-privilege backup identity. Use KMS/secret-manager key custody,
rotation and recovery access; never reuse the ephemeral drill key. Enable S3
versioning, object-lock retention where supported and cross-region replication
for originals and variants; preserve media keys and DB metadata together. A real
remote S3 restore is not certified by the local object fixture. Restrict restore
permissions and record operator actions. Retain backup metadata and checksums
without copying contacts or private object bytes into operational reports.

Proposed operating targets, subject to owner/staging acceptance: DB RPO <=15 min
with WAL archiving, daily base backups retained 30 days; critical object RPO <=15
min with monitored replication lag; RTO <=60 min including identity/permission
checks and traffic cutover. Local drill measured timing is in the Phase 4D report;
it proves a small dataset path, not those production guarantees. Alert on archive
lag >10 min, replication lag >10 min, missing daily backup, failed authentication
or restore verification. Run scratch restore monthly and before major releases;
run a cross-region recovery exercise quarterly.

## Incident / failover procedure

1. Declare the incident and freeze release/flag changes. Record the last healthy
   release, schema/checksums, WAL position and object replication watermark.
2. Fence the failed primary: revoke application writes/credentials and prevent
   automated restart from creating two writable primaries. Preserve evidence.
3. Select a verified standby or create a new isolated restore target from the
   encrypted base backup and WAL to the accepted recovery timestamp. Resolve
   key access through the approved recovery operator; do not improvise secrets.
4. Restore object versions matching the DB recovery window. Verify migrations,
   PostGIS, sequences, domain/audit/billing identities and permissions; never
   blindly replay payment captures or externally delivered notifications.
5. Rebuild disposable OpenSearch indexes from PostgreSQL, rotate Redis sessions
   if necessary, and restart workers after fencing/lease review. Check queue age,
   reconciliation/deduplication, live listing visibility and ready probes.
6. Run smoke, login/role, public search/detail and media checks on the isolated
   target. Compare measured data loss/recovery duration to accepted RPO/RTO.
7. Owner authorizes ingress/DNS cutover. Enable writes once, monitor error budget,
   and use audited staged flag rollout. Keep the old primary fenced.
8. Record the incident, actual loss/recovery duration, backup provenance and
   forward-fix. Do not automatically fail back; plan a separate reviewed recovery.

No production migration, restore, failover or deployment was executed by Phase 4D.
