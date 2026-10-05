# Phase 4D Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; one implementation writer, read-only reviewers. Steps use checkbox tracking and TDD.

**Goal:** Fulfil Issue #26 and Phase 4D readiness/verification requirements without production deployment or the next gated phase.

**Architecture:** Extend the existing modular monolith through dedicated operations/observability boundaries, reuse existing health, auth, flags and workers, and keep lifecycle/billing/AI domain semantics unchanged. Add bounded local verification tools and portable observability/release contracts; actual provider/production activation remains an owner gate.

**Tech Stack:** Node 24, pnpm 10, strict TypeScript/NestJS/Next.js, PostgreSQL/PostGIS, Redis/OpenSearch, Python workers, Docker local services and GitHub Actions.

**Spec:** `docs/PHASE4D_PRODUCTION_READINESS_SPEC.md`, Issue #26, `docs/RAUI_TZ_v1.0.md`, master plan, AGENTS/task router. Base: accepted Phase 4C merge `ec5b26e`.

## Global constraints

- Existing checkout only; branch `feat/phase-4d-production-readiness`, never direct master writes.
- One writer; reviewers read-only. Fetch remote heads before push, never force-push.
- No deployment, actual production DB operations, destructive migration or next gated phase.
- Retain mandatory Prettier/security/full browser tests and immutable applied SQL 001–011.
- Risky capabilities stay default-off; secrets, request bodies, visitor identities and provider outputs never enter operational telemetry.
- Ordinary internal API p95 target approximately <=300 ms under normal conditions (TZ §22). Local measurements are evidence for the tested workload, not production capacity certification.
- SLO/RPO/RTO operating targets must be labelled tested/proposed distinctly; production credentials and rollout acceptance cannot be invented.

## File and interface map

- `apps/api/src/modules/operations/`: bounded metrics/traces, dependency and aggregate queue/security health; contextual admin authorization; no raw tenant/job/provider payloads. Middleware records route templates and safe error classes.
- `apps/api/src/config.ts`, `bootstrap.ts`, `common/http.ts`, database/health wiring: production configuration/security contracts, request correlation and sanitized failures, existing readiness behavior.
- `apps/web/lib/`, request proxy/layout/listing metadata: SEO/JSON-LD and security header guardrails using existing public eligibility rules.
- `infra/observability/`: Prometheus/Grafana/alert contracts, scrape authorization and operating/SLO definitions; no live remote installation.
- `scripts/`: local-only load evidence, bounded security/architecture/contract checks, encrypted backup/restore verification and release/rollback dry-run checks. Scratch DB names/host guards protect the source DB.
- `.github/workflows/`: full existing gates plus readiness/security/load/restore/artifact evidence; staging/release artifacts and manual approval controls, no automatic production deployment.
- `docs/PHASE4D_REPORT.md`, `PHASE4_REPORT.md` and operating runbooks: actual evidence, risks, forward-fix/rollback and owner handoff.

## Review focus

1. Attacker-controlled routes/headers/secrets must not create unbounded labels or leak through errors, logs, traces or metrics.
2. Dependency stalls and observability failures must be bounded and must not turn health into false readiness or block core transactions.
3. Restored backups must preserve domain/audit identity and PostGIS/media evidence; original DB/object data must never be overwritten by a test drill.
4. Mixed-version releases and default-off flags must fail closed; no command may silently migrate/deploy production.
5. SEO/CSP must preserve browser hydration and live listing visibility while rejecting script injection and unsafe canonical/provider origins.

### Task 1: Configuration, web security and SEO guardrails

**Files:** API config/HTTP tests, web security/metadata helper/proxy/layout tests, env contracts/README.
**Interfaces:** Consumes existing config and public detail APIs; produces validated production env and safe HTML/JSON-LD/security policy helpers.

- [x] Write failing tests for insecure production origins/storage/DB transport, unsafe search/CDN configuration, controlled error classes, hostile JSON-LD and nonce/script policy.
- [x] Observe targeted failures, implement minimal validation/guardrails, preserve local `.env` and current security assertions.
- [x] Run unit, strict types, root lint/build and representative E2E before committing/pushing a completed increment.

### Task 2: Observability and protected operations health

**Files:** operations module/tests/integration, bootstrap/health/OpenAPI, observability contracts and dashboards/alerts.
**Interfaces:** Consumes existing Database/Dependencies, admin authorization and job tables; produces bounded metrics/traces and aggregate admin health/queue/security/flag status.

- [x] Fail tests for unknown path cardinality, malicious correlation/trace headers, secret/error sanitization, unauthorized operational endpoints and DB/dependency timeouts.
- [x] Implement bounded HTTP timing/status histograms, W3C-compatible trace correlation, safe spans/error counters and admin snapshots. Reuse existing modules; do not expose job payloads/contact data.
- [x] Add portable dashboard/alert contracts for API p95/error budget, DB/Redis/OpenSearch health, queue age/dead jobs and commerce/AI failures. Verify metric names/selectors against implementation.
- [x] Run real PostgreSQL/HTTP acceptance and required gates; commit/push with evidence.

### Task 3: Measured performance and security checks

**Files:** local load harness, security/architecture checks, CI artifact evidence, report.
**Interfaces:** Consumes built API/public search/detail and operational metrics; produces versioned latency/throughput/error evidence without request bodies or secrets.

- [x] Fail host/target/schema checks for nonlocal or destructive load targets and malformed benchmark inputs.
- [x] Run bounded concurrent scenarios against a fresh scratch PostgreSQL/PostGIS fixture and built app; measure p50/p95/p99, throughput, errors and workload. Assert the TZ ordinary-operation target for the explicit tested workload.
- [x] Run dependency/secret/security checks without suppressing findings; fix actual defects and retain architecture/contract/privacy boundaries.
- [x] Commit/push tested harness, exact results and resource/coverage limits.

### Task 4: Backup, restore and DR drill

**Files:** backup/restore helpers/tests, local drill script, backup/DR runbooks and production storage contracts.
**Interfaces:** Consumes explicit local DB, consistent exported snapshot and private backup path; produces encrypted checksummed backup, restored scratch DB and identity/count/digest verification.

- [x] Fail tests for original/remote DB targets, corrupt artifacts, wrong keys and unsafe object paths.
- [x] Implement streaming authenticated encryption and private artifacts; use pg_dump/pg_restore on a fresh generated scratch target only. Preserve original data and verify schema checksums, PostGIS and domain/audit identities against the same source snapshot.
- [x] Verify object-storage backup behavior on local fixture objects; document versioning/replication requirements for real S3 without fabricating credentials or remote certification.
- [x] Measure backup/restore time, define provisional cadence/RPO/RTO and failover/fencing runbook. Distinguish measured drill evidence from owner-approved production guarantees.
- [x] Run full drill and checks, then commit/push.

### Task 5: Release/rollback controls, final evidence and PR

**Files:** CI/manual release contracts/scripts, configuration manifests, README/runbooks, Phase 4D and final Phase 4 reports.
**Interfaces:** Consumes tested build/contract/load/backup evidence and existing audited flags; produces reproducible release manifest, staging/rollback dry-run and owner approval gates.

- [ ] Fail checks for unknown artifacts, mutable release identity, incompatible migration expectations or enabled risky defaults.
- [ ] Implement artifact/hash/version checks and dry-run release/rollback flow; production path requires explicit environment approval and credentials and is never run by this task.
- [ ] Recheck every Phase 4D requirement, forward migration compatibility, security review findings and operating runbooks. No automatic PR merge or Issue #13 execution.
- [ ] Run frozen install, lint/typecheck/unit/integration/build, migration repeats, built API/web/core/search smoke, every worker once, full E2E, load/security/restore/release checks. Preserve exact outcome artifacts.
- [ ] Fetch remote, push same branch, prepare PR, follow exact-head CI and fix ordinary failures/review findings. Stop at acceptance gate with complete report.

## Execution rulings and ledger

- Existing approved TZ/spec/Issue #26 and the user's autonomous-work instruction determine the brief and native execution method. Do not add routine design/plan approval stops; escalate only genuine owner blockers in AGENTS.
- Phase 4C merge was separately authorized by the user's response to the explicit merge/Phase 4D question and completed as `ec5b26e`. Phase 4D itself does not authorize its own merge or production deployment.
- Before implementation, self-review plan/spec coverage and interfaces; record completed increments and exact tests here and in the phase report.

### Task 1 evidence

- Observed red tests for plaintext/mismatched production origins, malformed credential-bearing URL errors, missing web security helper and null/unknown-code HTTP errors before fixes.
- API and web unit suites, root lint/typecheck/build passed. All 83 PostgreSQL/PostGIS integration tests passed; migrations 001–011 reapplied without changes.
- Built API/web/core/search smoke, commerce/professional workers and 14 desktop/Android Chromium E2E checks passed, including fresh per-response CSP nonce and working browser hydration. Full remote browser matrix remains a CI gate.
- No migration or deployment. Request-scoped CSP makes HTML dynamically rendered; inline styles remain allowed for React/Leaflet, while production scripts reject unsafe-inline/unsafe-eval.

### Tasks 2–4 evidence

- Bounded route/method/status labels, strict traceparent, admin authorization and aggregate PostgreSQL queries tested. Read-only security review found wrong AI column, red-cluster false health, planned-fallback false alarms and parser-order coverage; all corrected with regression coverage.
- 84 integrations passed. Local 120-request catalog/search/public-detail load passed p95 <=300 ms with zero errors; fresh evidence is produced by every E2E run.
- Consistent AES-GCM restore verified 61 public tables, 11 migrations, 9 sequences and PostGIS, plus private object fixture. Wrong key/corrupt data/unsafe target/path and failed DROP cleanup covered.
- Dependency audit found GHSA-8cw4-87c7-c6xx in csv-parse6.1.0; upgrade7.0.2 and frozen lockfile pass audit and existing feeds/integration suites.
- Readiness release manifest binds mandatory load/restore evidence hashes and validates schemas; CI artifact dry-run and final review remain Task5 acceptance checks.
