# Release candidate stabilization — Issue 13

Base: merged Phase 4D master `ff0094589a2835304ff994053e69daca276bb3ed`.
Branch: `feat/rc-stabilization`. Sole implementation writer; parallel read-only
Security/DB/Contract/QA/Web/Operations reviews. User authorized merge and RC;
production deployment remains excluded. Scope: defects and regression evidence,
not new product features. Apply TDD: observe meaningful red, minimal fix, suites.

## File map and increments

- [x] Transport: professional/feed-fetch.ts and professional.test.ts; actual
      Node24 HTTPS/DNS seam, IPv4 pinning, verified TLS, no redirects. Auth/delivery.ts
      plus gateway tests: reject token-bearing redirects and sanitize failures.
- [x] Account privacy: components/account.tsx plus browser/component regression;
      reset identity-owned state and fence asynchronous responses across logout/login.
- [x] Rate limits: common/security.ts, shared private ingress signature contract,
      web API proxy/config; trusted per-client identity, spoof/replay resistance,
      aggregate abuse limits preserved, explicit production ingress prerequisites.
- [x] API correctness: professional/platform.ts target-scoped idempotency and
      target-based partner revocation; OpenAPI actual public/key requirements;
      real PostgreSQL/HTTP negative/replay/contract regressions.
- [x] SEO: search sitemap pagination and Next sitemap partitions; bounded outputs,
      every eligible listing represented, canonical/noindex tests.
- [x] DB: populated current-master migration repeat/upgrade, immutable checksums,
      domain/audit/PostGIS/sequence identity; bounded advisory-lock regression.
      Existing migration SQL is immutable; scratch databases only.
- [x] Operations: payment-failure and stalled-index alert evidence; staging forward
      migration/API/web/worker/ingress order, compatible rollback/forward-fix.
- [x] QA: real viewport/keyboard/saved-search assertions, bounded E2E harness,
      safe failure diagnostics, meaningful visual comparison where portable.
- [x] Evidence: expand existing critical-flow performance measurements, restore
      identity including sequence state, external production prerequisites.
- [ ] Final: lint/typecheck/unit/integration/build, full cross-browser E2E, migration,
      smoke/workers, security audit, load/restore and readiness artifact verification.
      Review exact final surface, fix findings, push PR/report. Stop at RC review;
      no production deployment or next gated implementation in this pass.

## Verification and release notes

Pinned Node24/pnpm10; frozen dependency installation. Services are local Compose.
No provider secrets or production calls. Fetch remote heads before every push;
never force-push or overwrite concurrent work. Each finished increment is committed
and pushed for parallel review. Keep rollback security fixes and immutable migrations;
prefer additive forward-fix when older writers/readers are incompatible.
