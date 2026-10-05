# RAUI.RU — Production Launch Gate

## Purpose

Use this checklist only after Release Candidate stabilization is merged and accepted.
This is the final verification gate before any production deployment.

Do not deploy automatically. Real production deployment requires an explicit separate instruction.

## Preconditions

- Phase 4 merged to master.
- Release Candidate stabilization merged to master.
- All critical CI checks green.
- No known P0/P1 defects.
- Migration and restore evidence available.
- Required production credentials and provider accounts configured outside Git.

## Final verification

### Application and data
- Verify clean build from current master.
- Verify production environment configuration contract.
- Verify all migrations in order on staging-like infrastructure.
- Verify rollback/forward-fix procedures for risky migrations.
- Verify seed/demo data is not enabled in production.
- Verify database backups and tested restore evidence.
- Verify Redis/OpenSearch recovery notes and health behavior.

### Security
- Verify no secrets in repository, artifacts or logs.
- Verify production cookies/session/CSRF/CSP/security headers.
- Verify privileged admin authorization and audit trails.
- Verify webhook signature validation and replay protection.
- Verify API key hashing/scopes/rate limits.
- Verify upload and SSRF protections.
- Verify dependency and secret scans are green.

### Payments and commercial features
- Verify payment provider is configured through adapter.
- Verify idempotency, webhook replay protection and reconciliation.
- Verify promotion pricing/versioning and expiration.
- Verify kill switches/default-off behavior for risky integrations.

### AI and external providers
- Verify AI modules are feature-flagged.
- Verify provider timeouts/retries/fallbacks.
- Verify usage/cost limits and metrics.
- Verify AI cannot become authoritative for critical property facts.
- Verify maps, mail, SMS, storage and other providers use adapters.

### Product regression
- Verify register/login/session flows.
- Verify create/edit/publish/pause/archive listing.
- Verify search/filter/map/listing detail.
- Verify favorites/saved searches/messaging/notifications.
- Verify agency/developer/feed workflows.
- Verify admin and moderation flows.
- Verify mobile/responsive and accessibility critical paths.

### SEO and analytics
- Verify canonical/noindex/sitemap behavior.
- Verify structured-data validation.
- Verify analytics events and privacy boundaries.

### Operations
- Verify logs, metrics, traces and correlation IDs.
- Verify dashboards and alerts.
- Verify queue/DLQ, worker, PostgreSQL, Redis and OpenSearch health.
- Verify payment/feed/AI operational metrics.
- Verify SLOs and alert thresholds are documented.
- Verify on-call/escalation and incident notes exist where applicable.

### Performance
- Verify latest performance evidence.
- Verify critical p95/error-rate targets are within documented thresholds.
- Verify graceful degradation for external provider failure.
- Verify queue backpressure and DB pool behavior.

## Go-live evidence package

Prepare a final report containing:

- exact master commit;
- CI run links/identifiers;
- migration evidence;
- backup/restore evidence;
- performance results;
- security scan results;
- external prerequisites still manual;
- enabled/disabled feature flags;
- rollback/forward-fix plan;
- known accepted risks;
- explicit recommendation whether the build is ready for a human-approved production deployment.

## Stop condition

After preparing the evidence package, STOP.
Do not deploy to production automatically.
