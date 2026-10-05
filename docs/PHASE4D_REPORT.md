# Phase 4D — Production readiness report

Issue #26; branch `feat/phase-4d-production-readiness`; PR #35.
Base: accepted Phase 4C merge `ec5b26e`. This phase does not authorize its own
merge, production deployment or Issue #13/RC execution.

## Implemented scope

| Requirement                  | Implementation and evidence                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEO/content guards           | Clean canonical/site origins, existing public eligibility/noindex/sitemap rules, escaped hostile JSON-LD and nonce-bearing structured data; real browser SEO regression retained                                                                        |
| Production config            | Explicit DEPLOYMENT_ENV; matching HTTPS origins, verified PostgreSQL TLS, rediss, authenticated HTTPS OpenSearch/storage/CDN contracts; malformed URL validation never throws raw credential-bearing API config errors                                  |
| Web/API security             | Request-scoped nonce CSP/strict-dynamic, no production inline/eval scripts, X-Frame/nosniff/referrer/permissions headers, production HSTS; null-safe generic HTTP failures without unknown error-code leakage                                           |
| Observability/tracing        | Bounded route-template histograms, method/status classes, generated/strict-W3C trace correlation and sanitized JSON request spans; no request bodies, query labels, contacts or tokens                                                                  |
| Admin health/queues/security | Existing verified admin/session boundary; aggregate media/search/commerce/professional/notification/trust queues, dependency probes, audited versioned flag visibility, HTTP security denials and actual provider failure/uncertainty counts            |
| Dashboards/alerts/SLO        | Portable Prometheus scrape/rules and Grafana dashboard; ordinary API p95 <=300 ms, proposed 99.9% availability/error budget, dependency, queue, scrape and provider alerts; planned AI fallbacks do not raise provider alerts                           |
| Performance                  | Bounded loopback-only catalog/search/public-detail load on fresh scratch DB/index, 120 measured requests, concurrency 4, five warmups per scenario, p50/p95/p99/throughput and zero errors                                                              |
| Backup/restore/DR            | Consistent exported PostgreSQL snapshot, streaming AES-256-GCM dump, authentication before fresh scratch restore, table/audit content/count digests, sequence/migration/PostGIS checks, encrypted private-object fixture and cleanup failure regression |
| Feature rollout              | Existing default-off AI/commerce flags and audited versioned control APIs reused; staging cohort/ingress rollout and abort/kill-switch procedure documented without inventing percentage targeting                                                      |
| Release/rollback             | Exact source SHA CI build manifest, artifact hashes and mandatory measured load/restore reports; read-only manual staging/rollback dry-run, immutable identity and successful CI provenance checks                                                      |
| Security/audit               | Production dependency advisory found and fixed: csv-parse 6.1.0 -> 7.0.2, GHSA-8cw4-87c7-c6xx; credential/TLS/client-boundary scan, existing security assertions preserved; read-only reviews drove fixes, no tests weakened                            |

## Local validation

- Frozen pnpm 10 installation, lint, strict typecheck, unit suites and build passed.
- Unit suites: 51 API, 7 readiness-tool, 7 web, 1 shared UI and 5 Python tests.
- 85 real PostgreSQL/PostGIS integration tests passed, including protected operations/metrics, no provider alert for six disabled AI fallbacks and actual secure session cookies for both production markers.
- Applied migrations 001–011 verified twice; no SQL added or changed.
- Built API/web, core and real search/PostGIS/SSR smoke passed; media worker used by smoke, commerce/professional/trust workers ran. No production service contacted.
- 14 desktop/Android Chromium E2E passed, including nonce freshness, safe script policy and working hydration/accessibility/map/account flows.
- Dependency audit reports no known production vulnerabilities at the tested snapshot; static secret/TLS/client-boundary scan and diff integrity passed.
- Local full-browser download remains blocked by cloud network download policy; GitHub CI runs the unchanged Chromium/Firefox/WebKit/iOS/Android matrix. The implementation head `561d53d` passed that complete matrix and the new readiness gates in CI; see acceptance evidence below.
- Release tests reject mutable SHA, wrong identity, unsafe/missing artifact paths, missing gates/evidence and tampered report hashes. CI creates/verifies actual retained artifacts only after all preceding gates succeed.

Measured artifacts are versioned under `docs/evidence/phase4d/`. The final CI run
publishes its own fresh evidence and manifest, rather than treating these local
figures as production certification. See `OBSERVABILITY.md`, `BACKUP_DR.md` and
`RELEASE_ROLLBACK.md` for commands and operating contracts.

## Migrations and compatibility

No new migration. Immutable 001–011 checksums remain unchanged; rollback to the
accepted Phase 4C application preserves schema/data. API/web/origin/CSP config
must roll back as a unit. Do not run down migrations or erase billing/audit data.
Use a separately reviewed additive forward-fix for incompatible data/protocol
changes. Retain the csv-parse7.0.2 security baseline in any rebuilt rollback
artifact; schema-compatible older code does not certify safe dependencies. Regenerate search indexes from PostgreSQL after DR instead of treating
OpenSearch as the source of truth.

## Risks and launch gates

- Local load uses two published listings and a warm low-concurrency workload;
  staging needs representative dataset/traffic, resource saturation and soak tests.
- Restore proves local DB and object fixture identity, not real S3 versioning,
  cross-region recovery or a production standby. Proposed RPO <=15 min/RTO <=60 min
  need monitored WAL/object replication, protected key custody and owner acceptance.
- Portable dashboards/alerts/trace ingestion require private staging endpoints,
  collector setup and observer-session rotation. The current scrape session uses
  existing admin privileges; restrict collector egress to metrics GET and protect
  its credential as a privileged secret. OpenSearch yellow is usable but
  degraded replica redundancy; red/malformed/oversized health responses fail.
- Nonce CSP requires dynamic HTML and coordinated upstream caching; React/Leaflet
  inline styles remain allowed. Production scripts remain nonce-only/strict-dynamic.
- The readiness artifact is a verified build input. A pinned scanned/attested
  runtime image, actual provider sandbox acceptance and an independent penetration
  test remain prerequisites for a separately authorized production launch.
- No production credentials, deployment, irreversible migration or actual payment,
  email/SMS/AI provider call was performed. Manual workflow becomes available on
  the default branch only after the owner accepts and merges this PR.

## Acceptance status

Implementation head `561d53d6999b7e006cbfcd10be28213cd02d51f3` passed
[RAUI CI run 37343613059](https://github.com/ROBERT-773/RAUI.RU/actions/runs/37343613059):
frozen install, lint/types/unit/security/build, 84 integration tests, all five browser
projects (35 E2E), load, repeated migrations, authenticated restore, built smoke/
workers, release/rollback manifest verification and retained readiness artifact.

The original three read-only review rounds completed. A subsequent RC preflight
found a Phase 4D regression: `DEPLOYMENT_ENV=production` enabled production
configuration validation but did not secure session cookies unless `NODE_ENV`
also indicated production. A real HTTP regression failed on missing `Secure`
before the fix. Configuration validation and cookie issuance now share the same
production predicate; the HTTP test checks both marker combinations and restores
its synthetic configuration afterward. A read-only security review found no
blocker in this correction. The first cookie-fix CI run (37347596475) passed
lint/types/unit/security/build and integration gates but failed the E2E step.
Cloud access to detailed job-log downloads was denied, so CI now uses Playwright's
GitHub annotations and bounded preflight-stage annotations to expose failures
without publishing credentials or raw service logs. No assertion, browser project
or performance threshold was disabled. Final head
`4b664fb601d54d1526e3ba54a32681201a63726c` passed exact-head RAUI CI run
37348437508, including the complete browser matrix and readiness gates.
Local Compose services were stopped without removing persistent volumes. The
cloud setup install/start instructions were updated as a saved configuration
draft; publication is a separate environment action, not performed here.

PR #35 is merge-ready from the documented Phase 4D validation perspective: its
exact-head mandatory CI is green and no unresolved review blocker is recorded.
Owner acceptance remains separate; no merge, deploy or next gated phase is
automatic.
