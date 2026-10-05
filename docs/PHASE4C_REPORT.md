# Phase 4C — AI, trust and analytics report

## Scope and delivery

Issue #25 and `PHASE4C_AI_TRUST_SPEC.md`, built on merged Phase 4B and refreshed master `090ad3f`. Implementation stays in `feat/phase-4c`, with one writer. No master writes, PR merge, production deployment or Phase 4D implementation.

| Requirement                                | Delivered surface                                                                                                           | Evidence                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Provider-agnostic AI, default-off controls | `modules/ai`: ten advisory capabilities, server kill switch and versioned per-capability flags                              | Unit off/timeout/retry/invalid-output/kill-switch tests; HTTP fallback and admin authorization tests       |
| Search and realtor foundations             | Redacted query, explicit filters, confirmation and clarifying questions                                                     | Russian search vectors, contact redaction, no guessed foreign-currency conversion                          |
| Description, moderation, duplicates, photo | Stored-fact description, deterministic findings, owner-safe duplicate summary, resolution/classification hook               | No domain writes; cross-owner denial; photo classification remains explicitly unknown                      |
| Recommendations and valuation              | Live public comparables, fixed cohorts, indicative RUB asking-price ranges or insufficient-data fallback                    | Minimum five offers/three sellers, withdrawn comparables suppression and in-flight privacy regression      |
| Analytics/support AI foundations           | Aggregate-only market context and static support guidance                                                                   | All-capability fallback acceptance                                                                         |
| Usage/cost/errors                          | Metadata-only metrics; atomic global daily reservation, two attempts maximum, stable provider idempotency, cooldown circuit | Concurrent budget test; post-reply flag failure regression; provider outage circuit test                   |
| Multi-signal duplicates                    | Python scorer with physical identity, address/geo, area/layout, exact photo hash and feed source reference                  | Python vectors; actual subprocess in PostgreSQL integration; no auto-merge or unpublish                    |
| Human review and fraud enforcement         | Immutable versioned findings, exact fact/media hashes, independent admin dispositions, existing publication workflow gate   | AI-off HTTP approval rejection, audited allow, stale review rejection, immutable-row tests                 |
| Operational trust jobs                     | Standalone worker, leases, bounded retry/backoff/dead-letter, admin retry                                                   | Concurrent claim, stale input/candidate fencing, failed/crashed attempt limits and worker smoke            |
| Privacy-safe analytics                     | Schema v1, global replay identity, daily HMAC pseudonyms, 90-day retention, contextual seller aggregates                    | Conflicting concurrent event, cross-day replay, private/offline denial, retention and minimum-cohort tests |
| Contracts and operations                   | OpenAPI request schemas/routes, README, env defaults, CI trust-worker smoke                                                 | Existing strict contracts/security suites retained                                                         |

## Database changes

- `009_ai_trust_analytics.sql`: additive AI controls/budgets/usage, trust jobs and immutable assessments/reviews/candidates, analytics events/daily keys, optional media SHA-256 and indexes; pgcrypto extension. No old-image backfill, no blob storage, no destructive conversion.
- `010_analytics_identity_and_trust_geo.sql`: global analytics event UUID uniqueness and geography index. This is a forward refinement; migration 009 was not rewritten after first local application.
- Migrations 001–008 are unchanged. Development migrations and isolated fresh PostgreSQL/PostGIS test databases only; production DB was not accessed.
- Before applying 010 to an installation that has already collected 009 events, check for duplicate event UUIDs. A unique-index failure must stop migration; do not delete historical rows to force it through.

## Verification

Verification is recorded in local `.cache/phase4c-final-*` logs. The CI workflow retains mandatory Prettier, strict types, unit/integration/build, full browser matrix, migrations and production-artifact smoke. No checks or security assertions have been disabled.

Successful local checks on the completed code surface:

- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`.
- Unit: 42 API, 3 web, 1 UI and 5 Python tests (51 total). Integration: 81 Node-reported tests across core/search/commerce/professional/Phase 4C, including suite parents.
- Local infrastructure health, `pnpm db:migrate` twice, `pnpm worker:trust --once`, built API/web and media-worker startup, `pnpm smoke`, `pnpm smoke:core`, commerce/professional worker once, search reconciliation/search smoke.
- Desktop and Android Chromium E2E: 12 passed. Downloading the full browser matrix failed with cloud network `403 Domain forbidden`; Firefox/WebKit/iOS were not run locally. The unchanged full matrix remains required in GitHub Actions.
- `git diff --check`; migrations retained their checksums and were exercised on isolated fresh DBs as well as the local development DB.

Git transport permits feature-branch fetch/push. GitHub PR API currently returns `Forbidden`; a prepared PR description cannot substitute for an actual PR or green Actions run. Remote CI status is therefore not claimed.

## Review fixes

A separate read-only whole-branch security/DB/contract review reported two important findings; this sole implementation writer reproduced and fixed both:

- JSON Unicode escapes bypassed raw provider-token reflection detection. The real-adapter boundary regression failed with a missing rejection, then passed after decoded string/key inspection. Literal reflection coverage remains intact.
- The oldest 100 pending moderation cases starved later scheduled scans. A 101-case PostgreSQL test failed with 100 jobs, then passed with rotating keyset scheduling. Cursor wrap also queues a new exact snapshot after an edit.

Additional writer regressions reproduced and fixed double cost accounting after a post-reply flag-store error, stale recommendation advice after withdrawal, stale duplicate findings after candidate edits, and unbounded retries after repeated crashed leases. No security test was weakened. Independent review identified no additional concrete important defects; this is not external CI or owner acceptance.

## Security and operating limits

- AI never publishes, edits factual records, merges duplicates or makes a binding moderation decision. Every suggestion requires human review; deterministic enforcement works with AI disabled.
- Gateway network policy requires exact approved HTTPS hostnames, public IPv4 DNS answers, pinned lookup, verified TLS, no redirects and bounded request/response sizes. Tokens are server-only and reflected tokens are rejected. Provider fixtures test the real adapter boundary; no live provider credentials/certification were used.
- Gateway must honor idempotency, generation/cost limits and abort deadlines before enablement. Server accounting bounds reservations conservatively; it cannot guarantee an arbitrary external provider's real invoice. Uncertain failed attempts charge the configured maximum. A process crash may leave a conservative reservation until that UTC budget day expires.
- Provider cooldown is process-local, while daily spending is globally serialized in PostgreSQL. In-flight usage is settled even when a subsequent access check rejects the response. Withdrawn recommendation context discards stale model advice.
- Duplicate confidence is an engineering heuristic, not calibrated probability. Exact photo SHA-256 is supporting evidence; originals predating this phase have no hash. No perceptual image classifier or authoritative valuation is claimed.
- Analytics identifiers are pseudonymous, not anonymous: DB access to daily keys remains sensitive. No raw visitor API, IP/contact data, prompts or model output in usage metrics. Minimum cohorts reduce exposure but are not a formal differential-privacy guarantee. Promoted counts are observational, with no causal uplift claim.
- Market values are current public asking prices, not completed transactions. New capabilities are API/worker foundations; this phase does not add a new AI UI or Phase 4D rollout/load/backup work.

## Rollback and forward-fix

Keep `AI_ENABLED=false` and all capability flags off until reviewed provider enablement. Disable a capability with its optimistic flag version and retain the audit trail. Stop the new trust worker if diagnosis is needed; do not bypass core publication checks or immutable review records.

Prefer a new forward migration for schema corrections. Do not edit applied SQL or drop trust/audit/analytics tables as an automatic rollback. Compatibility rollback to the preceding application should keep additive tables and media column; explicitly restrict risky publication while the earlier application lacks the new trust gate. AI flags alone do not disable deterministic trust enforcement.

For worker incidents, inspect bounded admin job metadata, resolve the cause and use audited dead-job retry. For analytics corrections, preserve event identities and reviewer evidence; reconcile through an approved forward fix. No production rollback is executed by this task.

## Handoff

PR targets `master` from `feat/phase-4c` and references Issue #25. Creation is blocked by GitHub API `Forbidden`; [open the prepared comparison](https://github.com/ROBERT-773/RAUI.RU/compare/master...feat/phase-4c?expand=1) using `PHASE4C_PR_DESCRIPTION.md`. This is not an existing PR link. External QA/Security/DB/Contract review remains a read-only handoff to this sole writer. Acceptance/merge and the next gated phase require the owner's separate authorization.
