# Production Launch Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Root is the sole writer; six agents review independent surfaces.

**Goal:** Produce the Issue #15 exact-master evidence package and an honest deployment recommendation.

**Architecture:** Reuse the accepted RC verification and immutable artifact pipeline. Keep local/CI evidence separate from actual staging, provider, IAM and remote recovery acceptance; no deployment or invented provider credentials.

**Tech Stack:** Node 24, pnpm 10, Python 3.12, PostgreSQL/PostGIS, Redis, OpenSearch, GitHub Actions.

**Spec:** `docs/PRODUCTION_LAUNCH_GATE.md`, Issue #15.

## Global Constraints

- RC is merged through PR #37; baseline master `9d2ec36614a6b4de60f9c8f23a1a99f21bcc73b7`.
- Changes only in `feat/production-launch-gate`; preserve user `.env` and applied SQL.
- Production deployment requires a separate explicit instruction; no automatic deploy.
- Missing provider/infrastructure acceptance produces a NO-GO recommendation, never a false success.

## Review Focus

- Prior-head artifact mistaken for current master: verify exact CI path/run/SHA and manifest identity.
- Local fixture evidence mistaken for deployed staging: label each evidence class explicitly.
- Default-off flags mistaken for actual deployed state: distinguish migration defaults from live configuration.
- Recovery identities described incorrectly: sessions are PostgreSQL-backed, Redis derived state is disposable.
- Missing provider adapter mistaken for credentials-only readiness: payments remain fail-closed until selected and implemented.

## Task 1: Fresh exact-master verification

**Files:** Create sanitized `docs/evidence/launch-gate/` evidence; reuse existing quality commands/workflows.

- [x] Frozen dependency installation and clean build from baseline master.
- [x] Lint, typecheck, unit, integration, build, security, Promtool, restore and smoke/E2E pass; preserve actual exit codes.
- [x] Confirm master CI success and independent staging/rollback artifact dry-runs bound to its run ID/SHA.
- [x] Inventory GitHub protected environments and required binding names only; never record secret values.

## Task 2: Evidence package and recovery correction

**Files:** Create `docs/PRODUCTION_LAUNCH_GATE_REPORT.md`; modify `docs/BACKUP_DR.md`.

- [x] Report exact master, CI/artifact links, migrations, recovery, performance, security, flags, rollback, risks, external prerequisites and deployment recommendation.
- [x] Correct Redis-session incident wording to PostgreSQL session revocation/rotation and derived Redis recovery.
- [x] Map every spec item to local/CI evidence or explicit unmet staging acceptance.
- [ ] Resolve the actual launch payment-scope owner decision when supplied; do not enable an unimplemented provider.

## Task 3: Review and handoff

- [x] Six independent read-only reviews; root resolves concrete findings.
- [x] Run formatting/lint and required checks for final changes; commit/push after checking remote head.
- [ ] PR #38 prepared; await exact-head CI before final package handoff.
- [x] Continue only tasks whose real prerequisites are satisfied. Issue #17 requires an authorized actual release; broad development access alone does not deploy production.
