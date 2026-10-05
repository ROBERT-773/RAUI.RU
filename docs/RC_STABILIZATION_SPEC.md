# RAUI.RU — Release Candidate Stabilization Specification

## Goal

After Phase 4 is merged, run a dedicated release-candidate stabilization pass before any production launch.

Use branch:

`feat/rc-stabilization`

Do not deploy to production automatically.

## Read before coding

- `docs/RAUI_MASTER_EXECUTION_PLAN.md`
- `docs/RAUI_TZ_v1.0.md`
- `docs/PHASE4_SPEC.md`
- `AGENTS.md`

## Scope

1. Full regression across Phases 1–4.
2. Fix only defects, unsafe defaults, missing tests, performance regressions, migration issues and production blockers.
3. No large redesigns or new product scope unless required to remove a blocker.
4. Verify all DB migrations from a clean database and an upgrade path from current master.
5. Verify auth, roles, permissions, admin boundaries and audit coverage.
6. Verify listing lifecycle, search, map, favorites, saved searches, messaging and notifications.
7. Verify billing/payment state machine, idempotency, webhooks, promotions and reconciliation.
8. Verify feeds/imports, partner API permissions, rate limits and idempotent reprocessing.
9. Verify AI feature flags, fallbacks, timeouts, usage/cost limits and non-authoritative behavior.
10. Verify SEO canonical/noindex/sitemap behavior and analytics privacy.
11. Verify observability, alerts, queue/DLQ visibility and health checks.
12. Run security hardening checks and dependency/secret scanning.
13. Run reproducible load/performance checks and document p50/p95/error rates for critical flows.
14. Verify backup/restore procedure in a safe non-production environment.
15. Verify staging release sequence, migration ordering, worker ordering, smoke checks and rollback/forward-fix steps.
16. Produce a concrete production prerequisite checklist for anything requiring real credentials, DNS, providers or infrastructure.

## Required checks

Run and pass, as applicable:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:integration`
- `pnpm build`
- E2E
- smoke
- migration verification
- security/audit checks
- load/performance checks
- backup/restore validation scripts
- production-readiness validation

## Exit criteria

The stabilization pass is complete only when:

- no known P0/P1 blockers remain;
- all critical CI checks are green;
- clean-install and upgrade migrations pass;
- rollback/forward-fix notes exist for risky changes;
- measured performance results are documented;
- backup restore has evidence;
- remaining external prerequisites are listed explicitly;
- branch is pushed;
- PR to `master` is prepared;
- a final RC report is produced.

After completion, STOP and wait for final release review. Do not deploy automatically.
