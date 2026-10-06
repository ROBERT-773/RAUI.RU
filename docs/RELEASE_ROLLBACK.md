# Staging, release and rollback

## Artifact and dry-run pipeline

RAUI CI checks out the exact PR head, runs frozen installation, lint, strict types,
unit/integration/build, dependency and boundary security checks, full browser E2E
with local load evidence, repeated migrations, encrypted restore drill, built
smoke and all workers. Only after successful gates does it create and verify a
versioned SHA-256 manifest and preserve the readiness artifact for 14 days.

Artifact contents: compiled API, Next server/static output, immutable migrations,
lockfile/package contract, observability config and load/restore evidence. Secrets,
local private media and Next build cache are excluded. This artifact is a verified
build input, not an automatically deployed container. Prepare a runtime image
with Node 24/pnpm 10 and frozen runtime dependencies using the exact source SHA;
include the existing workspace packages, Next public files and configured mounts.
Pin image digests and scan/attest the resulting runtime image before actual launch.

After this workflow is accepted into master, the manual `RAUI staging and rollback
dry-run` workflow takes a successful RAUI CI run ID, full source SHA and either
staging-dry-run or rollback-dry-run. It verifies GitHub run provenance and every
manifest hash from the retained artifact using the trusted checked-out verifier.
The selected run must be completed/successful for the exact `.github/workflows/ci.yml` path and source SHA; the downloaded manifest must carry the same run ID. It has read-only permissions and no deploy command or production credential.
The current RC verifier requires all 12 migrations and RC evidence, so historical pre-RC artifacts cannot pass it. Prepare a newly verified compatible rollback artifact preserving RC security fixes, or use a separately reviewed historical-verifier path; never bypass the current contract.
Locally, from an extracted artifact root, use the trusted repository verifier:
`node /path/to/RAUI.RU/scripts/release-contract.mjs verify .cache/phase4d-release.json <full-sha>`.
Do not create a fake CI manifest or use a mutable branch/tag as release identity.

## Configuration and staging acceptance

Bind DEPLOYMENT_ENV explicitly. Production requires matching clean HTTPS
WEB_ORIGIN/SITE_URL, verified PostgreSQL TLS (sslmode=verify-full with a trusted
CA), rediss Redis, authenticated HTTPS OpenSearch, private S3 and real verification
adapter credentials. SITE_URL and DEPLOYMENT_ENV also belong in the web build and
runtime. CSP uses fresh per-response nonces and dynamic HTML; upstream caching
must not combine stale nonce HTML with fresh headers. Do not cache authenticated
API responses. Provision independent observability/backup secrets through the
approved mechanism and test dependency probes without exposing credentials.

Staging acceptance runs the same full gates against isolated data plus actual
provider sandbox contracts, restore/DR and load at representative dataset/traffic
sizes. Configure protected GitHub environments with required reviewers and
least-privilege runtime identities before a real deployment pipeline is enabled.
An independent penetration test and production provider/storage/backup readiness
are launch prerequisites; local tests do not replace them. This phase never sends
real payment, delivery or AI traffic and does not grant production deployment.

## Flags and rollout

Commerce and all ten AI capabilities remain seeded default-off. Reuse the
existing audited versioned flag endpoints; no second flag ledger is introduced.
First validate flag-off fallback and the kill switch. In staging enable one
capability for a small approved test cohort, observe latency/errors, billing
reconciliation, uncertain AI cost, queue age and audit records, then broaden only
with owner acceptance. The existing flags are global, so do not claim native
percentage canary targeting: cohort/traffic separation requires the approved
staging/ingress routing. Define a release-specific abort threshold before enabling
real traffic; disable the flag through the same audited API if exceeded.

## Rollback / forward-fix

Keep the previous successful immutable artifact/image and config available.
Before rollback verify its successful CI provenance, hashes, schema expectations,
provider contract and flag state. Phase 4D adds no SQL migration; schema 001–011
remains unchanged and accepted Phase 4C can read it. Nonce CSP/web-origin changes
must be rolled back as one API/web/config unit. Disable risky flags before traffic
cutover and drain workers/leases; preserve queues, billing and audit history.

Never run down migrations or restore old production data merely to roll back
application code. Additive future migrations use expand/backfill/switch/contract;
old/new readers must overlap. If data or protocol compatibility prevents an
application rollback, deploy an explicitly reviewed forward-fix. Restore data
only under a separately approved recovery incident using BACKUP_DR.md. No merge,
production deployment, rollback or next phase is automatic.

A Phase 4C schema-compatible rollback does not certify the older dependency
security baseline. Retain csv-parse >=7.0.2 and all necessary security fixes in a
new verified artifact, or choose a forward-fix; never promote a known-vulnerable
image merely because its DB reader is compatible.

## RC staging sequence (execution requires a deployment task)

1. Select an exact successful CI SHA and verified image/config. Confirm provider
   sandbox bindings, ingress trust from TRUSTED_INGRESS.md, feature kill switches,
   database compatibility and a recent verified restore checkpoint. Record abort
   thresholds for latency, errors, queue age and unexpected external effects.
2. Stop new worker claims and, where the migration needs a write window, pause
   producers. Observe persisted active leases until work completes or leases
   expire; do not clear lease rows or retry non-idempotent external effects blindly.
   Drain AI writers before crossing the older 011 cost-accounting semantics.
3. Run one migration runner. Verify immutable checksums and the complete ledger.
   RC migration 012 adds search enqueue age and replaces the dirty trigger without
   deleting jobs or facts. Its backfill holds the table lock until commit: measure
   queue size and duration in staging and fit the existing 5s lock/60s statement
   limits. Existing age is approximated from last update; do not claim historical
   first-enqueue reconstruction. A timeout rolls the migration back for a later
   window; do not increase limits without measurements.
4. Start the compatible API/web behind private ingress, before public traffic.
   Check readiness, auth/CSRF, signed proxy and SSR, sitemap index/shards and
   worker-independent smoke. The new queue metric requires 012; do not start that reader before the
   migration succeeds.
5. Start compatible media/search/commerce/professional/trust workers. Run bounded
   reconciliation and full core/search smoke, observe actual queue progress, lease recovery and
   deduplicated effects. Keep feature flags off while confirming fallback paths.
6. Switch staging ingress, observe the recorded thresholds, then separately
   enable approved flags. This sequence does not authorize production traffic.

For code rollback: flags off, stop claims/drain leases, validate the previous
compatible API/web/config and verified image, run worker-independent smoke
behind private ingress, restart compatible workers, then run full core/search
smoke before switching ingress and observing. Keep 012 and its
queued facts; old explicit-column producers/readers remain compatible. Preserve
RC security patches in any rollback artifact. If that cannot be achieved, use a
reviewed forward-fix rather than restoring an older unsafe artifact.

Portfolio idempotency is now scoped to organization and target portfolio. A
pre-RC cached request can execute once again under the corrected scope; unique
portfolio membership prevents duplicate links, but an additional audit record
can appear. Preserve the old ledger, and let clients keep their original keys.
Sitemap pages are live eligible reads, without a multi-request snapshot guarantee;
concurrent publication changes can alter boundaries until the next index fetch.

Use a bounded isolated staging workload and an explicit operator time limit for
reconciliation: the current `--once` worker can drain until the queue is empty.
The repository core/search smoke scripts write development fixtures and require
local adapters; do not run them unchanged against real provider bindings or a
production-shaped signed ingress. Adapt sandbox fixture authentication and
identity explicitly before executing corresponding staging acceptance checks.
