# Phase 3 verification report

Branch: `feat/stage-3-search-product`, based on master `bcf9504` (merged Phase 2 plus authoritative Phase 3 specification). Scope: Issue #6, `AGENTS.md`, execution plan, TZ and `PHASE3_SPEC.md`.

Created search/indexing/geo-layer modules; account collections, saved search, messaging and notification modules; Next.js search/map/account/detail routes; shared product/event/provider contracts; local OpenSearch Compose service; migration 002; unit/integration/browser/smoke tests and CI coverage. Detailed architecture, rollout, limits and rollback: [PHASE_3_SEARCH_PRODUCT.md](PHASE_3_SEARCH_PRODUCT.md).

## Verified in the published cloud workspace

| Command                                                | Result                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                       | Passed                                                                                                  |
| `pnpm lint`                                            | Passed, ESLint and Prettier                                                                             |
| `pnpm typecheck`                                       | Passed, strict TypeScript across workspaces                                                             |
| `pnpm test`                                            | Passed: API 14, web 3, UI 1, Python 1                                                                   |
| `pnpm build`                                           | Passed, API and Next.js production artifacts                                                            |
| `pnpm test:integration`                                | Passed: Phase 2 15 + Phase 3 11; isolated real PostgreSQL/PostGIS/OpenSearch                            |
| `CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e`  | Passed: 12 desktop/Android Chromium scenarios, including URL restoration, axe accessibility and SEO/404 |
| `pnpm db:migrate`                                      | Passed twice locally, checksum/repeat verification                                                      |
| `pnpm worker:search --once`                            | Passed as a separate process                                                                            |
| `pnpm search:reconcile` / `pnpm search:reindex`        | Passed with the real local index                                                                        |
| `pnpm smoke` / `pnpm smoke:core` / `pnpm smoke:search` | Passed on built artifacts, including separate media worker, indexed results, PostGIS map and SSR detail |

Browser CDN installation returned HTTP 403 `Domain forbidden`. Firefox/WebKit/iOS and branded Edge were not locally executed. CI installs official Chromium/Firefox/WebKit and runs desktop/mobile projects; its remote result must be checked on the PR. Android is an emulation profile, not a physical device test. No passed result is claimed for unavailable engines.

Migration 001 is unchanged. Migration 002 adds structures and optional definitions without changing existing property values, deleting data, or dropping columns. Only local DB was migrated. Developer DB volumes and previous indices remain intact. No master/production update, deployment or merge was performed.

Counts/facets may lag the source; live cursors can drift under concurrent edits. Map results are capped and expose truncation. Raster tiles/attribution and boundary/POI providers require configuration before public release. External notification delivery remains a deferred adapter/outbox foundation. Deployment must address trusted client-IP forwarding for the existing rate limiter. There is no load-test SLA or physical browser certification.

Rollback retains additive product data and audit history: revert artifacts/worker, switch to a retained index under the worker lock, then reconcile. Forward fixes use migration 003+ and a new index version. Paid promotion, billing, ads, AI, market analytics, full SEO automation and all other Phase 4 work remain intentionally deferred.

Follow-up specification review: search filters, sort and map/list mode now persist in `/search?definition=...&mode=...` URLs. Reloading a filtered URL restores the result set and visible form values; the search route remains `noindex`. No additional migration or index change.
