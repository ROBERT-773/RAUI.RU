# Agent Ownership and Handoff

This document defines conflict-free parallel agent work for RAUI.RU. It supplements `AGENTS.md` and the current task router; it does not override stage gates, merge approval, production approval, or security rules.

## Core rule: one writer per active surface

At any moment, exactly one implementation owner may write to an active feature branch. Review, QA, security, database, and next-phase scouting agents are read-only against that branch. Findings are handed to the implementation owner, who applies fixes serially.

Do not let multiple agents independently push fixes to the same branch or edit the same implementation surface.

## Current Phase 4B allocation

- **A0 — Router / Coordinator:** track stage, dependencies, PR/CI state, handoffs, and owner blockers. Write only coordination docs on a dedicated admin/docs branch.
- **A1 — Phase 4B Owner:** own PR #28 through CI/review readiness. This is the sole implementation writer to `feat/phase-4b-professional-integrations`.
- **A2 — CI / QA:** inspect Actions, tests, regressions, and acceptance evidence. Stay read-only and send findings to A1.
- **A3 — Phase 4C Scout:** read the Phase 4C spec and prepare a dependency/file map. Stay read-only until Phase 4B is accepted and merged.
- **A4 — Docs / Contract Review:** check OpenAPI, reports, runbooks, and behavior alignment. Stay read-only against active implementation; use an independent docs PR if needed.
- **A5 — Security / Trust Review:** review partner tokens, SSRF controls, tenant isolation, secrets, and the notification gateway. Stay read-only and send findings to A1.
- **A6 — DB / Migration Review:** review migrations, replay/idempotency, forward-only compatibility, and rollback notes. Stay read-only and send findings to A1.
- **A7 — Release / Ops:** prepare the RC/operations checklist and rollback/observability requirements. Stay read-only and perform no production actions.

## Handoff protocol

1. The coordinator records one active implementation owner and branch.
2. Review agents report findings; they do not race the owner with competing commits.
3. The owner resolves findings and gets required CI green.
4. Merge remains governed by `AGENTS.md`: do not merge without the separately required approval/request.
5. A next-stage agent may scout read-only, but must not create or implement the next stage before its prerequisite stage is accepted and merged.
6. After an authorized merge, refresh from the latest `master`, then assign a new sole implementation owner and dedicated branch.
7. Previous-stage owners become reviewers by default unless explicitly reassigned.

## Conflict prevention

- No direct writes to `master`.
- No production deployment or production credential changes without explicit approval.
- No two implementation agents share one active feature branch.
- No destructive migration or applied migration rewrite.
- No next-stage implementation from an unmerged prerequisite branch.
- Cross-cutting changes belong to the active owner when they are required by that stage; otherwise use a separate PR.
- If two tasks need the same file, serialize them under one owner instead of merging parallel edits later.

## Owner-decision boundary

Escalate only for the blockers already defined in `docs/CODEX_TASK_ROUTER.md` and `AGENTS.md`: production approval, unavailable credentials/secrets, destructive or irreversible data changes, genuine product/business ambiguity, repository permission failure, or an explicit governance conflict.

Normal CI failures, review findings, documentation corrections, and reversible fixes are not owner blockers.

## Governance precedence

This allocation document is administrative only. If it conflicts with `AGENTS.md`, the authoritative product/spec documents, or an explicit owner instruction, stop the conflicting action and follow the higher-authority instruction.

In particular, the task router's no-idle guidance must not be interpreted as permission to merge a PR or begin a gated next stage when `AGENTS.md` requires a separate request.
