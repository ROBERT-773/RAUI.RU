# Production launch gate — Issue #15

Updated: 6 October 2026, Europe/Moscow. Branch: `feat/production-launch-gate`.

**Recommendation: NO-GO for production deployment.** Repository and local/CI gates pass, but real staging, provider, IAM, infrastructure, remote recovery and penetration-test evidence is not available. This package does not authorize deployment or claim that the launch gate is satisfied.

## Exact source and release identity

RC PR #37 was merged and accepted for continued verification under the owner's explicit continuation authorization. Application baseline: master `9d2ec36614a6b4de60f9c8f23a1a99f21bcc73b7`.

[Master CI 37439594041](https://github.com/ROBERT-773/RAUI.RU/actions/runs/37439594041) passed the complete `ci.yml` pipeline. Retained artifact `11400294335`, `raui-readiness-9d2ec36614a6b4de60f9c8f23a1a99f21bcc73b7`, was unexpired at verification. Master-bound [staging dry-run 37440359787](https://github.com/ROBERT-773/RAUI.RU/actions/runs/37440359787) and [rollback dry-run 37440365242](https://github.com/ROBERT-773/RAUI.RU/actions/runs/37440365242) both passed. Each verified the selected successful CI run, exact SHA, manifest run ID and retained artifact hashes. Receipts are recorded in `ci-provenance.json`. Neither dry-run deploys.

The application source is unchanged in this branch. Documentation corrects session recovery: sessions live in PostgreSQL; Redis derived state can be rebuilt/discarded. There are no new migrations, providers, enabled flags or production changes.

## Fresh verification

Frozen installation, lint, strict typecheck, complete unit suites and clean build passed from the accepted master application source. Generated API `dist` and Next `.next` were removed before the build. Integration, security/dependency audit, real Promtool, controlled restore and production-build smoke passed with exit code 0.

Local E2E: 18 tests across Chromium and Android Chromium, 29.4 seconds. Master CI additionally passed its complete five-project/45-test browser matrix. The smoke sequence verifies API/web/media health, core, search reconciliation/index/geo/detail, and commerce/professional/trust workers. These commands use disposable local fixtures and adapters; they are not a staging certification.

Sanitized fresh evidence: `docs/evidence/launch-gate/`. `local-verification.json` identifies the exact application baseline. `local-binding-presence.json` records only names/presence in the current development cloud process, never values, and explicitly does not certify production credentials.

## Migration and recovery evidence

All 12 migrations apply cleanly and repeat safely; populated pre-RC master-baseline upgrade tests preserve previously applied migration bytes/checksums, data, audit, PostGIS, sequence identities and AI accounting. Applied SQL 001–011 remains immutable. Migration 012 is already accepted into master; its queue age and trigger changes remain compatible with documented application rollback.

Controlled encrypted restore verified 61 tables, 12 migrations, PostGIS and nine sequence configurations/states/next values: six pristine and three called. AES-256-GCM authentication precedes restore; the source fixture writer is quiesced. Verification phase approximately 1.45 seconds, excluding later cleanup; success publishes only after owned-resource cleanup. Synthetic local object restore is covered.

Remote PITR/WAL, replicated object restoration, KMS recovery, standby/failover, actual RPO/RTO and representative migration lock/backfill timings remain unverified. Parent interruption can leave owned disposable scratch resources; exact ownership cleanup is required, never broad-prefix deletion.

## Measured performance

Fixture: two listings, one buyer session, isolated PostgreSQL/PostGIS and OpenSearch, four dedicated native loopback peers, concurrency four. Five warmups plus 40 measured requests per scenario. All 240 measured requests succeeded; zero warmup errors. p95 target remains 300 ms; no quotas or thresholds were disabled.

| Flow          | p50 ms | p95 ms | Errors |
| ------------- | -----: | -----: | -----: |
| Catalog       |   4.30 |  18.12 |      0 |
| Search        |  18.43 |  31.06 |      0 |
| Public detail |   5.28 |   7.46 |      0 |
| Map           |  14.68 |  20.98 |      0 |
| Auth identity |   4.36 |   7.03 |      0 |
| Auth sessions |   4.11 |   5.10 |      0 |

Earlier RC CI latency failures remain in history. Dedicated worker peers fix proven artificial client queueing; bounded client/server/SQL diagnostics remain available. Passing a warm tiny fixture is not production capacity evidence. Representative reads, writes, publish/import/provider traffic, pool/backpressure and worker draining still require staging measurement.

## Security and configuration

Fresh `pnpm security:check` passed the credential/TLS/client-boundary scan and production dependency audit with no known vulnerabilities reported. Unit/integration/browser regressions cover authorization, admin/audit, session revocation, CSRF/CSP, signed ingress, webhook replay, key hashing/scopes/quotas, upload limits, SSRF/DNS pinning, identity/tab/thread isolation and analytics privacy. Existing security tests remain enabled.

Production configuration fails closed on unsafe origins, database/search/Redis transport, missing trusted proxy identity or verification/storage bindings. Source defaults do not enable seed/demo behavior. This is configuration-contract evidence; actual deployed configuration, TLS/IAM and secret/log/artifact/runtime-image security are not verified. Runtime image packaging/digest/scan/attestation and an independent penetration test remain required.

## Feature flags and payments

| Control                                                                                                                            | Verified source/fixture default                                           | Actual production state                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `AI_ENABLED`                                                                                                                       | Off by default                                                            | Unknown; no deployed acceptance                    |
| AI `search`, `realtor`, `description`, `moderation`, `duplicates`, `photo`, `recommendations`, `valuation`, `analytics`, `support` | Persisted defaults off; fallback/timeouts/cost gates tested               | Unknown; do not enable without provider acceptance |
| Commerce `payments`, `promotions`, `advertising`                                                                                   | Default-off/kill-switch behavior tested                                   | Unknown; launch scope awaits owner decision        |
| Seed/demo paths                                                                                                                    | Development-only acceptance fixtures; no production activation introduced | Must verify actual runtime configuration           |

Payments remain bound to `UnconfiguredPaymentProvider`: create/refund fail closed, webhook verification rejects, reconciliation is unavailable. Credentials alone cannot activate it. Owner must choose disabled launch scope or a provider; enabling payments then requires the adapter implementation and sandbox signature/replay/reconciliation/refund acceptance. The owner question is pending; this report does not infer an answer.

## Full acceptance matrix

| Spec area              | Local/CI evidence                                                                                          | Still required before GO                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Build/application/data | Exact master CI, clean frozen build, migration/recovery regressions                                        | Actual staging artifact/config, migration duration and drain/order                      |
| Auth/admin/security    | Session/cookie/CSRF/CSP/admin/audit/webhook/key/upload/SSRF tests                                          | Public HTTPS ingress/cookies, IAM, protected environment, pentest                       |
| Payments/commercial    | State/idempotency/reconciliation/promotion expiry/kill-switch tests                                        | Selected scope/provider, implemented adapter and sandbox acceptance                     |
| AI/providers           | Flag/fallback/timeout/retry/budget/non-authoritative tests                                                 | Actual gateway/maps/mail/SMS/storage bindings and failures                              |
| Product/mobile/a11y    | Lifecycle/account/org/feed/moderation; search-page axe/responsive baseline plus five-project browser flows | Actual iOS/Android and keyboard/focus through deployed staging                          |
| SEO/analytics          | Canonical/noindex/sitemap/structured-data/privacy regressions                                              | Public HTTPS URL/structured-data validation and analytics acceptance                    |
| Operations             | Health/queues/DLQ/traces/metrics/exporters; seven alert rules evaluated                                    | Authenticated scrape, deployed dashboards, real receiver firing/recovery, named on-call |
| Performance            | Six-flow bounded evidence, pool/failure/backpressure regressions                                           | Representative data/traffic, writes/import/providers and draining                       |
| Backup/rollback        | Local restore, compatible migration and artifact verification                                              | Remote PITR/object/KMS restore, standby/failover and accepted RPO/RTO                   |

GitHub repository environment API currently reports zero environments. Protected staging/production environments, reviewers and workload identities need configuration. The repository evidence does not identify an approved hosting/registry, private ingress topology, real alert receiver/on-call owner, provider accounts or independent pentest result.

## Concrete external prerequisites

1. Supply the approved staging/hosting/registry and private ingress topology, DNS/TLS, trusted socket peers and workload identities. Configure protected environments and approved reviewers.
2. Bind actual PostgreSQL/PostGIS trusted TLS, Redis TLS, authenticated OpenSearch, private object bucket/CDN, verification, maps and notification providers securely outside Git/chat. Development presence is insufficient; workload IAM may replace static keys.
3. Decide launch payment scope and provide the selected provider's sandbox through secure environment settings if enabling it. Certify its adapter before live activation. Confirm actual commerce and AI flag states with an audited operator.
4. Provide an isolated representative staging dataset; measure migration 012 lock/backfill, worker drain/order, read/write/import/provider load, auth/role/product/SEO/analytics flows and graceful failures.
5. Certify remote backups/PITR, object versions, KMS recovery and failover against owner-accepted RPO/RTO. Local fixture timings do not meet this requirement.
6. Name on-call/escalation owners and real receiver destinations; verify authenticated scrape and alert firing/recovery. Accept the documented availability/latency/RPO/RTO objectives explicitly.
7. Build/package and scan/attest an immutable runtime image from the verified source/artifact, approve the registry identity/retention and complete an independent penetration test.

## Rollback, risks and next action

Keep the previous verified compatible runtime artifact/image/config. Flags off, stop claims and drain leases before migration or cutover; preserve applied migration 012 and queue facts. Validate exact workflow/run/SHA/manifest hashes, schema compatibility and smoke before resuming. Historical pre-RC artifacts fail the current 12-migration contract; use a newly verified compatible artifact preserving RC security fixes or a separately reviewed historical-verifier path. Prefer additive migration/application forward fixes; never edit applied SQL or blindly replay captures/notifications. See `RELEASE_ROLLBACK.md` and `BACKUP_DR.md`.

Known risks needing owner acceptance: real infrastructure/provider/recovery/pentest checks are outstanding; small-fixture load does not establish capacity; OpenAPI success-body detail and DB command-deadline/lifecycle hardening remain documented follow-ups. No claim of owner-accepted production risk is made here.

Proceed with available non-production technical work while owner inputs arrive. Issue #17 requires an authorized actual release and a satisfied launch gate, so it cannot be executed against this local fixture. No production deployment or cutover has occurred.
