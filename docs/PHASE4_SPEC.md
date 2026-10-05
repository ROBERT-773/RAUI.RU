# RAUI.RU — Phase 4 Specification

## Goal

Complete the commercial, AI, analytics, operations and production-readiness layer for RAUI.RU on top of the merged Phase 3 product.

Work from current `master`. Use a dedicated branch:

`feat/stage-4-monetization-ai-production`

Do not modify `master` directly. This is the final planned implementation phase before release-candidate stabilization.

## Read before coding

- `docs/RAUI_MASTER_EXECUTION_PLAN.md`
- `docs/RAUI_TZ_v1.0.md`
- `docs/PHASE3_SPEC.md`
- `AGENTS.md`

Before implementation:

1. summarize architecture and sequencing;
2. list affected modules/files;
3. identify schema/migration changes;
4. identify external-provider boundaries;
5. identify security, rollout and rollback risks;
6. identify features that must be behind feature flags.

## 4.1 Billing and payments

Implement a provider-agnostic billing domain:

- accounts/balances or invoice model as appropriate;
- payment intents/orders;
- payment state machine;
- refunds;
- subscriptions/recurring plans where supported;
- receipts/invoice metadata foundation;
- idempotency for all critical writes;
- webhook signature verification;
- replay protection;
- reconciliation jobs;
- payment audit trail.

Payment providers must be behind adapters. Do not hard-code one provider into domain logic.

Support future card/SBP-style provider integrations through interfaces/configuration.

Never store full payment card data.

## 4.2 Promotion products

Implement configurable promotion products rather than hard-coded logic:

- Standard;
- Highlighted;
- Premium;
- VIP;
- SuperVIP;
- Top;
- future custom placement types.

Required:

- product catalog;
- pricing/versioning;
- eligibility rules;
- activation period;
- scheduling;
- expiration;
- placement priority inputs;
- purchase history;
- admin configuration;
- audit.

Search/ranking integration must be explicit and testable. Paid promotion must not silently corrupt organic relevance logic.

## 4.3 Advertising

Implement advertising foundation:

- placements;
- campaigns;
- creatives metadata;
- geo targeting;
- category targeting;
- schedule;
- budget/spend counters foundation;
- impressions/click tracking;
- basic advertiser organization compatibility;
- admin controls.

Keep ad-serving logic isolated from core listing search logic.

## 4.4 Agencies and developers

Expand professional tooling:

- organization profile;
- team roles/permissions;
- portfolio management;
- bulk listing operations;
- feed/API integration management;
- integration logs;
- import status/error reporting;
- lead routing foundation;
- analytics summary;
- billing/promotions integration.

Developer hierarchy support:

- residential complex;
- building;
- section;
- floor;
- unit;
- price;
- availability;
- floor plans;
- completion dates;
- promotions;
- documents.

Do not duplicate Property/Listing/ListingSource. Professional imports must map into the existing core model.

## 4.5 Feeds and partner API

Implement:

- feed definitions;
- scheduled imports;
- validation;
- dry-run mode;
- upsert strategy;
- source tracking;
- deduplication hooks;
- idempotent reprocessing;
- error quarantine;
- per-feed logs/metrics;
- partner API keys;
- scoped permissions;
- rate limits;
- webhook foundation where needed.

Imported data must remain traceable to ListingSource.

## 4.6 AI layer

Implement AI modules behind provider-agnostic interfaces and feature flags.

Required modules:

- AI Search / natural-language search interpretation;
- AI Realtor assistant foundation;
- AI Description generation;
- AI Moderation assistance;
- AI Duplicate Detection assistance;
- AI Photo quality/classification hooks;
- AI Recommendations foundation;
- AI Valuation/price estimate foundation;
- AI Analytics/support interfaces.

Rules:

- AI must never be authoritative for critical property facts;
- model/provider/prompt/rule version must be logged where relevant;
- uncertainty/confidence must be represented;
- timeouts, retries and fallbacks required;
- cost/usage metrics required;
- deterministic non-AI fallback where possible;
- unsafe or low-confidence outputs must not auto-publish critical changes.

## 4.7 Duplicate detection

Implement multi-signal duplicate candidate generation:

- normalized address/property identity;
- source/external IDs;
- seller/organization relationships;
- photo similarity hook;
- text similarity hook;
- geo proximity;
- category/attribute similarity.

Do not automatically merge uncertain duplicates.

Provide:

- confidence score;
- reasons/signals;
- review workflow;
- audit trail.

## 4.8 Moderation and anti-fraud expansion

Expand Phase 2 moderation:

- rule engine;
- suspicious price checks;
- duplicate checks;
- contact/spam pattern hooks;
- media quality hooks;
- source trust metadata;
- user/organization risk signals foundation;
- moderation queue prioritization;
- appeal/review notes foundation;
- audit.

AI may assist but must not be the only enforcement layer for high-impact decisions.

## 4.9 SEO and content

Complete SEO foundation:

- scalable sitemap partitioning;
- canonical rules;
- structured data validation;
- robots/noindex policy for filter pages;
- SEO-safe search URL rules;
- district/metro/category landing-page architecture;
- metadata templates;
- indexation guardrails;
- broken-link and canonical tests;
- SEO regression checks.

Avoid automatically generating thin/duplicate landing pages.

## 4.10 Analytics and market intelligence

Implement product/business analytics foundation:

- listing views;
- unique views;
- favorites;
- contact reveals/messages;
- leads;
- conversion;
- search-to-contact funnel;
- promotion performance;
- agency/developer portfolio metrics;
- market aggregates by district/metro/category;
- price distributions/trends;
- event schema versioning.

Analytics provider must be behind an adapter where practical.

Do not expose private user-level analytics to unauthorized parties.

## 4.11 Observability

Production observability baseline:

- structured logs;
- correlation/request IDs;
- metrics;
- traces;
- error tracking adapter;
- dashboards;
- alert rules;
- queue metrics;
- OpenSearch health;
- PostgreSQL health;
- Redis health;
- worker health;
- payment webhook/reconciliation health;
- feed/import health;
- AI latency/error/cost metrics.

Define initial SLOs and alert thresholds.

## 4.12 Performance and load testing

Add reproducible performance tests for:

- public search;
- map search;
- listing detail;
- auth/session endpoints;
- publish flow;
- feeds/import where practical.

Validate:

- horizontal/stateless app behavior;
- database pool limits;
- Redis behavior;
- OpenSearch limits;
- queue backpressure;
- timeout/retry policies;
- graceful degradation.

Document measured results and known bottlenecks.

Target ordinary backend API p95 around <=300 ms under normal expected conditions, with separate realistic SLOs for search/map/external-provider paths.

## 4.13 Security hardening

Complete production security baseline:

- dependency scanning;
- secret scanning;
- security headers/CSP review;
- CSRF/session review;
- auth rate-limit/brute-force review;
- admin privileged-action review;
- webhook verification;
- API-key hashing/storage rules;
- SSRF protections for feed/webhook/import URLs;
- upload hardening;
- input limits;
- audit coverage;
- secure defaults for production configuration;
- documented pentest checklist.

No secrets in repository or logs.

## 4.14 Feature flags and safe rollout

Implement/configure:

- feature flag abstraction;
- per-feature gradual rollout readiness;
- safe default-off for risky integrations;
- kill switches for AI, payments, feeds and promotions where appropriate;
- rollout documentation;
- rollback/forward-fix notes.

## 4.15 Backup and disaster recovery

Production readiness requirements:

- automated PostgreSQL backup plan/scripts/configuration;
- restore procedure;
- restore verification test/runbook;
- object-storage backup/retention guidance;
- recovery runbook;
- RPO/RTO definitions;
- dependency recovery notes for Redis/OpenSearch;
- scheduled DR drill checklist.

Do not claim DR is complete without a tested restore procedure.

## 4.16 Production configuration and release pipeline

Implement:

- environment separation documentation/config contracts for dev/test/staging/prod;
- immutable build artifact strategy;
- staging gate;
- production release gate;
- migration ordering;
- worker deployment ordering;
- smoke checks;
- rollback plan;
- post-deploy verification;
- feature-flag rollout sequence.

No direct production testing.

## 4.17 Admin expansion

Expand admin for:

- billing/payment status;
- tariffs/promotion products;
- campaigns/ads;
- agencies/developers;
- feeds/imports;
- AI controls/usage;
- SEO settings;
- analytics summaries;
- feature flags;
- integration health;
- queue/DLQ status;
- audit/security events.

Critical actions must remain auditable.

## 4.18 Notifications and delivery

Expand notification infrastructure:

- in-app;
- email adapter;
- SMS adapter;
- web push foundation;
- mobile push adapter foundation.

Required:

- retry/backoff;
- dead-letter handling;
- delivery status;
- provider fallback hooks;
- preference checks;
- deduplication/idempotency.

External providers remain configurable adapters.

## 4.19 Testing requirements

At minimum add/extend tests for:

- billing state machine;
- payment idempotency/webhook replay;
- promotion activation/expiration;
- paid-ranking integration;
- feed import/upsert/idempotency;
- partner API authorization/rate limits;
- AI adapter fallbacks/timeouts;
- moderation/dedup candidate behavior;
- SEO canonical/noindex/sitemap rules;
- analytics privacy;
- notification retries/preferences;
- feature flags;
- backup/restore procedure where testable;
- security regression;
- load/performance scenarios;
- admin authorization/audit.

Run and pass:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- integration tests
- E2E tests
- smoke tests
- security/audit checks
- migration checks
- performance/load checks
- any new production-readiness validation scripts

## 4.20 Non-goals

Do not:

- replace the current architecture with microservices without measured need;
- introduce Kafka unless justified by actual throughput/operational need;
- rebuild Phase 1–3 functionality unnecessarily;
- bind the project irreversibly to one maps/payment/AI/SMS/email vendor;
- auto-merge uncertain duplicate properties;
- allow AI to become the source of truth for critical facts;
- bypass release gates for speed.

## Exit criteria

Phase 4 is complete only when:

- billing domain and provider adapters exist and are tested;
- configurable promotion products work end-to-end;
- professional feed/API workflows exist;
- core AI modules have safe interfaces/fallbacks/feature flags;
- SEO/analytics foundations are production-ready;
- observability and alerts are defined;
- security hardening checks pass;
- load/performance evidence is documented;
- backup/restore runbook and tested restore path exist;
- staging/release/rollback process is documented and automated where practical;
- all required CI checks are green;
- branch is pushed;
- PR to `master` is prepared;
- final report is produced.

## Final Phase 4 report

The report must include:

- implementation summary;
- migrations/schema changes;
- provider adapters/configuration required;
- tests and exact results;
- performance/load results;
- security checks;
- observability/SLO summary;
- backup/restore evidence;
- known risks;
- remaining production prerequisites requiring real credentials/infrastructure;
- rollback/forward-fix strategy.

After completion, STOP and wait for final release-candidate review. Do not deploy to production automatically.
