# Continuous Improvement Queue

This document defines the no-idle work loop for Codex after the major delivery phases are complete.

## Working rule

For every block:

1. update from current `master`;
2. read `AGENTS.md`, the relevant spec, and current execution plan;
3. create a dedicated branch;
4. implement the block;
5. run lint, typecheck, build, tests and any block-specific checks;
6. push the branch and open a PR;
7. publish a concise completion report;
8. if there is no blocker requiring owner input, start the next queued block immediately.

Do not deploy to production automatically.

## Queue

### Q1 — Production defect burn-down
Source: defects from post-launch verification and operational hardening.

Exit:
- P0/P1 resolved;
- P2 triaged;
- regression tests added.

### Q2 — Search relevance and catalog quality
- ranking/relevance review;
- stale listing handling;
- duplicate reduction;
- missing-field quality checks;
- indexing correctness.

### Q3 — Performance optimization
- API latency hotspots;
- slow queries and indexes;
- frontend loading;
- media pipeline throughput;
- cache opportunities.

### Q4 — Security hardening
- permission regression tests;
- auth/session review;
- rate limits;
- dependency audit;
- secret/config review;
- abuse-path tests.

### Q5 — Operational automation
- health checks;
- scheduled verification jobs;
- backup verification;
- alert validation;
- repeatable incident diagnostics.

### Q6 — Product polish
- UX defects;
- accessibility;
- mobile/responsive behavior;
- error/empty states;
- analytics consistency.

### Q7 — Technical debt
- remove dead code;
- simplify duplicated modules;
- improve test fixtures;
- documentation drift cleanup;
- dependency maintenance.

## Prioritization

Use this order:
1. security or data-loss risk;
2. production outage/reliability;
3. broken critical user journey;
4. performance regression;
5. quality/UX;
6. technical debt.

## Stop conditions

Codex should stop and request owner input only when:
- a production deployment approval is required;
- credentials/secrets are required;
- destructive data migration is required;
- a product/business decision is genuinely ambiguous;
- repository permissions block progress.

Otherwise, continue to the next queue item.
