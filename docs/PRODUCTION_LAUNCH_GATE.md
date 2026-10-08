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

### Account approval, publication quota and phone verification

- Verify pending accounts can use only authorized onboarding routes, rejected
  accounts cannot use protected workflows, and inactive or revoked identities are
  denied even when an existing session is presented.
- Verify registration approval is independent of listing moderation. Only staff
  with the required scoped grants can read or decide the corresponding cases;
  revoking a grant or deactivating staff prevents subsequent actions. Verify
  decisions and idempotent retries recheck current sessions and grants before
  replay, deny self-approval, and retain audit evidence. Deny approval of inactive
  or unverified applicants; rejection revokes affected sessions and prevents login.
- Verify email or phone confirmation never grants registration approval, changes
  the account role, or reactivates the account.
- Verify the owner publication cap counts six distinct published Property IDs,
  including concurrent sixth/seventh approval decisions. Multiple sale/rental
  offers for the same Property consume one slot, including an additional offer at
  the cap. Enforce the cap across owner, organization and API sources; a seventh
  distinct Property returns HTTP409 without changing its pending case or history.
  Pausing every public offer for a Property frees a slot and permits retrying the
  same pending case. Existing over-limit publications remain intact with an
  accurate count and zero remaining slots. Draft creation, editing, media and
  moderation submission remain available at the cap.
- Verify `PHONE_OTP_ENABLED=false` preserves the existing long-token phone path.
  Numeric OTP capability and captured-adapter tests are not evidence of real SMS
  delivery; record approved provider bindings and controlled-recipient delivery
  separately before enabling numeric OTP.
- Verify the selected rollback API/web/config preserves registration approval and
  owner quota guards, disables numeric OTP when required, and retains additive
  migrations and audit history. Use a reviewed forward-fix if a previous artifact
  cannot preserve these controls.

Use `ACCOUNT_APPROVAL_RETENTION_DESIGN.md` for account-policy boundaries,
`PHONE_OTP_VERIFICATION.md` for implementation evidence and external delivery
limits, and `RELEASE_ROLLBACK.md` for rollback sequencing. Attach exact source SHA,
CI and staging evidence to these checks; prepared PRs and local tests do not prove
that the deployed staging build enforces them.

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
