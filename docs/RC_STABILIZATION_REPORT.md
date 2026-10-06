# RC stabilization report — Issue #13 / PR #37

Updated: 6 October 2026, Europe/Moscow. Branch: `feat/rc-stabilization`.
Scope: regression and release evidence for Phases 1–4; no production deployment or next launch gate.

## Changes

- Hardened native outbound transports, webhook ingress, quota enforcement, account privacy and asynchronous pool/error cleanup. Security regressions remain enabled.
- Added real browser coverage for map keyboard selection, pan/zoom and matching result IDs, plus saved-search creation, rename, reload, reopen and deletion. Fixed Leaflet marker Enter/Space selection.
- Added migration `012_search_queue_observability.sql`: search-trigger efficiency and stable queue enqueue timestamps. Sitemap pagination respects the 50,000 URL limit. Previously applied migrations 001–011 remain unchanged.
- Evaluated all seven Prometheus alert rules with immutable Promtool, covering thresholds, pending/firing/recovery, exclusions, missing series and counter resets. Added an HTTP exporter regression for owned queue tombstones and recovery.
- Extended bounded load measurement to six real read flows, including authenticated identity/session and map response contracts. Four native loopback peers preserve existing per-client quotas; no forwarding-header spoofing or quota disabling.
- Added a controlled backup/restore fixture. Verified every table, migration checksum, PostGIS and sequence configuration/state/next values. Publish fresh recovery evidence atomically only after owned-resource cleanup succeeds; invalidate stale evidence on failure.
- Reject CDN base URLs containing credentials, query strings or fragments; retain valid path prefixes. Added native HTTP 204 regression, handled both 204/205 with null bodies and caught response-construction errors.
- Strengthened readiness manifests to require actual observability, complete six-flow load evidence and restored sequence evidence. Semantic negative tests recompute hashes before exercising validation.

## Verification

Actual local commands passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm security:check`, `pnpm observability:check`, `pnpm recovery:drill` and the production-build smoke/E2E sequence.

Integration output records 93 passing Node test results across six suites, including parent subtests. Local browser run passed 18 tests. CI must additionally pass its complete 45-test/five-project browser matrix for the final pushed commit. The last independent native transport regression and isolated startup-test cleanup were followed by another successful full unit run, restore drill and lint.

Clean migrations, repeat migration runs and upgrade from published master were exercised. The upgrade preserves applied migration bytes, data, audit, PostGIS, sequence state and AI accounting. The 50,001-listing sitemap fixture completed after the search-trigger fix; queue retries no longer reset age.

Six read-only reviewers covered security, DB, contracts, QA, operations and web. Their CDN, evidence-publication and HTTP response findings were fixed and tested. No known P0/P1 finding remains in the reviewed surface; external acceptance below remains mandatory.

Implementation commit `68ea250eb50d7e0b55cfbfcb89f82d39d74d7b74` passed the complete [CI run 37432028661](https://github.com/ROBERT-773/RAUI.RU/actions/runs/37432028661), including the five-project browser matrix, migrations, recovery, worker smoke and readiness creation/verification/upload. Retained artifact `11397836249` is bound to that SHA. Independent downloaded-artifact verification passed in [staging dry-run 37432647149](https://github.com/ROBERT-773/RAUI.RU/actions/runs/37432647149) and [rollback dry-run 37432651613](https://github.com/ROBERT-773/RAUI.RU/actions/runs/37432651613). These workflows verify successful CI provenance, manifest identity and all artifact hashes; neither deploys. Direct download from this cloud environment was denied, so GitHub runners performed that verification. Final documentation-head CI and artifact verification are recorded in PR #37 to avoid a self-referential commit SHA in this file.

## Continued acceptance hardening

A subsequent independent audit found and reproduced two readiness false-positive checks and account collection races. The verifier now binds successful CI to the exact workflow path, immutable SHA and selected run ID, including the downloaded manifest run ID. Load error-kind counters must be the exact four nonnegative safe integers and match the overall error count. Semantic negatives recompute file hashes.

Account loads and collection/saved-search mutation completions now reject stale request generations across tab changes. Deferred Favorites responses and deletes cannot replace Comparison cards or cursor; late saved-search rename/delete cannot supersede its pending load. New regressions were observed failing before the fixes. No new migrations or product features are introduced. Current-head full CI and independent artifact dry-runs are recorded in PR #37 after push.

## Measured local evidence

Sanitized evidence is retained separately from historical Phase 4D results in `docs/evidence/rc/`. Fixture: two published listings, one buyer session, isolated PostgreSQL/PostGIS and OpenSearch, warm reads, four real loopback peers, concurrency four. Each scenario has five warmups and 40 measured requests; all 240 measured requests succeeded, with zero warmup errors. Target p95 remains 300 ms.

| Flow          | p50 ms | p95 ms | Errors |
| ------------- | -----: | -----: | -----: |
| Catalog       |   4.78 |  18.60 |      0 |
| Search        |  19.09 |  32.29 |      0 |
| Public detail |   6.74 |  11.00 |      0 |
| Map           |  17.85 |  23.40 |      0 |
| Auth identity |   5.29 |   9.48 |      0 |
| Auth sessions |   4.27 |   6.06 |      0 |

Latest controlled restore: 61 tables, 12 migrations, nine sequences and all nine expected next values; six pristine and three called sequences; AES-256-GCM authenticated before restore. Local verification phase approximately 1.45 seconds, excluding subsequent cleanup. Object restore uses a local fixture. These results certify neither production capacity nor remote PITR/S3/KMS recovery.

## Risks and production prerequisites

- Stage with real DNS/TLS, protected deployment environments, provider sandbox credentials, object storage and KMS; verify authenticated scraping and real alert receiver firing/recovery delivery.
- Run representative data/traffic, publish/import/provider load and deployment smoke with staging authentication. Measure migration lock/backfill duration and bounded worker draining.
- Exercise remote backups/PITR, object-store restoration and KMS recovery; validate runtime image identity against the immutable readiness artifact.
- Parent process SIGKILL/machine failure can interrupt fixture cleanup. Residual resources are disposable owned `raui_test_*` / `raui_restore_test_*` databases and private recovery workspaces; identify the exact run-owned resources before manual cleanup. Ordinary child failure/timeouts are bounded and cleaned. This documented P2 limitation is not a production DR guarantee.
- Database command deadlines, live pagination consistency and broader OpenAPI response-schema detail remain follow-up hardening considerations. A separate P2 account thread-pagination race remains: a late page for thread A can supersede thread B within the same signed-in identity; fence thread requests/mutations in a follow-up regression increment. Current runtime authorization/contract tests and pre-RC idempotency/audit coverage stay enabled.

## Rollback and forward fix

See `RELEASE_ROLLBACK.md` and `BACKUP_DR.md`. Keep migration 012 and existing queue facts when rolling application code back; do not edit or reverse applied SQL. Stop/drain workers, select a verified immutable artifact and run compatible smoke before resuming. Prefer a new additive migration or narrowly scoped application forward fix for data/trigger defects. Tightened CDN configuration requires a clean base URL; fix configuration rather than relaxing validation.

PR #37 remains the sole integration target. Do not merge, deploy production or start Issue #15 until final RC release review.
