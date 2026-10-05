# Post-launch Verification Spec

## Purpose

This package starts only after the production launch gate has been satisfied and the release has been explicitly authorized. It does not authorize deployment by itself.

## Objectives

- verify production health after release;
- confirm critical user journeys;
- validate data integrity and background processing;
- confirm observability and alerting are effective;
- capture evidence and defects for the next stabilization block.

## Required checks

1. Health and availability
   - API health endpoints
   - frontend availability
   - database connectivity
   - queue/worker health
   - search and geo services

2. Critical user journeys
   - registration/login/logout
   - listing creation/edit/publish
   - search/filter/map
   - favorites/saved search
   - media upload
   - organization and role permissions

3. Data integrity
   - migration state
   - duplicate prevention
   - idempotent jobs
   - no stuck background jobs
   - no unexpected data loss

4. Security
   - auth/session behavior
   - permission boundaries
   - admin-only actions
   - rate limiting
   - secret exposure checks

5. Observability
   - logs
   - metrics
   - traces where applicable
   - alert delivery
   - error-rate and latency dashboards

## Deliverables

- `docs/POST_LAUNCH_REPORT.md`
- list of defects with severity
- links to evidence
- rollback recommendation if any release blocker is found

## Exit criteria

- no unresolved release-blocking defect;
- critical journeys pass;
- production error rate and latency remain within agreed limits;
- all findings are documented;
- next stabilization block is ready.

## Codex handoff rule

When complete:
1. run all required checks;
2. commit the report and fixes in a dedicated branch;
3. open a PR;
4. provide a concise completion report;
5. immediately continue with `docs/OPERATIONS_HARDENING_SPEC.md` if there is no release blocker.
