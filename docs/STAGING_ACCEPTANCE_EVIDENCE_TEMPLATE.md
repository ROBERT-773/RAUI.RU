# RAUI.RU — Staging Acceptance Evidence Template

Purpose: collect the external non-production evidence required by RAU-12 and the production launch gate. This document must contain identifiers, statuses and sanitized metadata only. Never record secret values, private keys, tokens, passwords, connection strings or credential contents.

## 1. Staging identity

- Approved hosting/platform:
- Region:
- Staging environment name:
- Runtime artifact/image digest:
- Registry/repository:
- Source commit SHA:
- Build/CI run:
- Deployment timestamp:
- Deployer/workload identity:
- Evidence links:

Acceptance:

- [ ] Runtime artifact is immutable and traceable to the accepted source SHA.
- [ ] Staging is isolated from production.
- [ ] No local/dev-only storage or demo/seed mode is enabled.

## 2. DNS, TLS and ingress

- Public staging hostname:
- DNS provider / zone reference:
- TLS issuer:
- Certificate subject/SAN:
- Certificate expiry:
- API public exposure: expected private / restricted
- Web public exposure:
- Private API origin:
- Trusted proxy / ingress identity:
- Direct Next/API bypass test result:
- Evidence links:

Acceptance:

- [ ] HTTPS only.
- [ ] Valid trusted certificate and hostname match.
- [ ] Private API ingress topology is documented.
- [ ] Direct bypass of trusted ingress is blocked.
- [ ] Caller-IP forwarding is stripped/replaced by trusted ingress.
- [ ] `PROXY_IDENTITY_SECRET` is injected outside Git and is 32+ characters; value is not recorded here.

## 3. Protected environment and IAM

- GitHub/environment name:
- Required reviewers:
- Deployment branch/tag policy:
- Workload identity / OIDC principal:
- Cloud role/service account:
- Least-privilege review reference:
- Evidence links:

Acceptance:

- [ ] Staging environment exists and is protected.
- [ ] Required reviewers are configured.
- [ ] Workload IAM is least-privilege.
- [ ] Long-lived static credentials are avoided where workload identity is available.
- [ ] Secrets are injected outside Git/chat/logs.

## 4. PostgreSQL / PostGIS

- Host identifier:
- Database/service identifier:
- TLS mode:
- CA/trust source:
- PostGIS version:
- Migration count:
- Migration 012 duration:
- Lock/backfill timing:
- Pool configuration:
- Health/smoke result:
- Evidence links:

Acceptance:

- [ ] TLS uses trusted verification equivalent to `sslmode=verify-full`.
- [ ] All migrations apply in order.
- [ ] Existing migration bytes/checksums are preserved.
- [ ] PostGIS is enabled and healthy.
- [ ] Representative migration lock/backfill timing recorded.
- [ ] Pool saturation/timeout behavior observed during staging tests.

## 5. Redis

- Service identifier:
- TLS scheme:
- Auth mode:
- Persistence/recovery note:
- Health result:
- Evidence links:

Acceptance:

- [ ] TLS uses `rediss://` or equivalent trusted transport.
- [ ] Service is not publicly exposed.
- [ ] Auth is enabled.
- [ ] Recovery/rebuild behavior is documented.

## 6. OpenSearch

- Service identifier:
- HTTPS endpoint class:
- Auth mode:
- Index/bootstrap result:
- Search health:
- Evidence links:

Acceptance:

- [ ] Authenticated HTTPS only.
- [ ] Service is not publicly writable.
- [ ] Search/index reconciliation smoke passes.
- [ ] Failure/degradation behavior is known.

## 7. Object storage and CDN

- Bucket/container identifier:
- Region:
- Private/public mode:
- Encryption:
- Versioning:
- CDN origin policy:
- Upload/download smoke:
- Evidence links:

Acceptance:

- [ ] Bucket/container is private.
- [ ] Public delivery, if used, is through the intended CDN/policy.
- [ ] Local development storage is not used.
- [ ] Upload/download path works through the configured adapter.
- [ ] Versioning/retention supports recovery requirements where applicable.

## 8. External provider bindings

Record provider names and binding status only; never credential values.

Track each launch-scope capability separately:

- Verification: provider, staging binding, health test, failure/degradation test, evidence.
- Maps/geocoding: provider, staging binding, health test, failure/degradation test, evidence.
- Email: provider, staging binding, health test, failure/degradation test, evidence.
- SMS: provider, staging binding, health test, failure/degradation test, evidence.
- Notifications gateway: provider, staging binding, health test, failure/degradation test, evidence.
- AI gateway: provider, staging binding, health test, failure/degradation test, evidence.
- Payments, if in launch scope: provider, staging binding, health test, failure/degradation test, evidence.

## 9. Observability binding

- Metrics scrape target:
- Scrape auth mode:
- Dashboard workspace:
- Alert receiver:
- On-call owner:
- Correlation/tracing validation:
- Evidence links:

Acceptance:

- [ ] Metrics scrape is private/authenticated.
- [ ] Dashboards ingest real staging data.
- [ ] Critical alerts have fired and recovered in staging-like conditions.
- [ ] Queue/DLQ, PostgreSQL, Redis, OpenSearch, provider and worker signals are visible.
- [ ] On-call/escalation owner is named.

## 10. Staging smoke and regression

Record exact commands/run links where applicable.

- [ ] Register/login/session.
- [ ] Create/edit/publish/pause/archive listing.
- [ ] Search/filter/map/detail.
- [ ] Favorites/saved searches/messaging/notifications.
- [ ] Agency/developer/feed workflows.
- [ ] Admin/moderation.
- [ ] Mobile/responsive/a11y critical paths.
- [ ] SEO canonical/noindex/sitemap/structured-data.
- [ ] Analytics/privacy boundaries.
- [ ] Queue/DLQ/worker health.
- [ ] Graceful external-provider degradation.

## 11. Performance acceptance handoff

- Representative dataset profile:
- Concurrency:
- Duration:
- Requests:
- p50:
- p95:
- Max:
- Error rate:
- DB pool pressure:
- Queue/backpressure:
- Redis/OpenSearch saturation:
- Provider degradation:
- Evidence links:

Target: ordinary backend API p95 <= 300 ms under the agreed representative profile. A tiny local fixture does not satisfy this gate.

## 12. Recovery handoff

- Remote PITR/WAL restore:
- Object version restore:
- KMS recovery:
- Standby/failover:
- Measured RPO:
- Measured RTO:
- Cleanup verification:
- Evidence links:

Acceptance:

- [ ] Remote recovery is demonstrated in non-production.
- [ ] RPO/RTO are measured and owner-accepted.
- [ ] Cleanup targets exact owned resources only; no broad-prefix deletion.

## 13. Security handoff

- Runtime image digest:
- Image vulnerability scan:
- Attestation/SBOM:
- IAM review:
- Public HTTPS cookie/session validation:
- Independent pentest reference:
- Open P0/P1 findings:

Acceptance:

- [ ] No unresolved P0/P1.
- [ ] Runtime image is scanned/attested.
- [ ] Independent pentest is complete.
- [ ] Any finding is fixed in a separate reviewed PR and re-tested.

## 14. Final staging acceptance

- [ ] All required evidence links attached.
- [ ] No secret values recorded.
- [ ] No production resources modified.
- [ ] Remaining blockers are explicit.
- [ ] Ready to hand evidence to RAU-13/14/15/16/17 and finally RAU-18.

Final status: **INCOMPLETE until every applicable external checkbox is backed by real non-production evidence.**
