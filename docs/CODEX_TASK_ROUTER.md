# Codex Task Router

This file is the authoritative no-idle execution order after the completed Phase 2, Phase 3, and Phase 4A work.

## Current chain

1. Issue #24 — Phase 4B — Professional tooling, feeds and integrations
   - Spec: `docs/PHASE4B_PROFESSIONAL_INTEGRATIONS_SPEC.md`
   - Branch: `feat/phase-4b-professional-integrations`
   - PR: #28
   - Continue on this same branch until CI and review are merge-ready.

2. Phase 4C
   - Start only after Phase 4B is merged.
   - Update from latest `master` before creating the dedicated branch.

3. Issue #13 — Release candidate stabilization
   - Spec: `docs/RC_STABILIZATION_SPEC.md`
   - Branch: `feat/rc-stabilization`

4. Issue #15 — Final production launch gate
   - Spec: `docs/PRODUCTION_LAUNCH_GATE.md`
   - No automatic production deployment.

5. Issue #17 — Post-launch verification
   - Spec: `docs/POST_LAUNCH_VERIFICATION_SPEC.md`

6. Issue #18 — Operations hardening
   - Spec: `docs/OPERATIONS_HARDENING_SPEC.md`

7. Issue #19 — Product quality iteration
   - Spec: `docs/PRODUCT_QUALITY_ITERATION_SPEC.md`

8. Issue #20 — Continuous improvement queue
   - Spec: `docs/CONTINUOUS_IMPROVEMENT_QUEUE.md`

## No-idle rule

For every implementation block:

1. update from the latest `master`;
2. read `AGENTS.md`, the block spec, `docs/RAUI_MASTER_EXECUTION_PLAN.md`, and `docs/RAUI_TZ_v1.0.md`;
3. implement only the current block;
4. run the required quality gates;
5. push the dedicated branch;
6. open or update the PR;
7. publish the completion report;
8. while the PR is open, keep fixing CI failures and review findings on that same branch;
9. after the PR is merged, immediately update from `master` and start the next numbered block.

Do not start a block that requires the previous block to be merged against an outdated base.

## Stop only for real owner blockers

Stop and request owner input only when one of these is true:

- explicit production deployment approval is required;
- credentials or secrets are required and unavailable;
- a destructive or irreversible data migration requires approval;
- a genuine product/business decision is ambiguous;
- repository permissions prevent progress.

A pending CI run, an open PR, or a normal review cycle is not a reason to stop working. Continue resolving the current block until it is merge-ready.

## Completed historical issues

Phase 2, Phase 3, and Phase 4A are complete and should not be selected as new work. The legacy Issue #9 / `feat/stage-4-monetization-ai-production` route is superseded by the Phase 4A/4B/4C split and must not be selected as current work.
