# Phase 3: search and product experience

Scope: Issue #6 and `PHASE3_SPEC.md`. No Phase 4 features, merge, deployment, or production migration.

## Local workflow

Node 24, pnpm 10, Docker Compose, Python 3.12. Preserve existing `.env`; copy `.env.example` only if it does not exist. Defaults connect exclusively to local services. API configuration accepts `OPENSEARCH_URL`, `OPENSEARCH_ALIAS`, and optional bearer `OPENSEARCH_TOKEN`; production requires HTTPS. Compose disables OpenSearch authentication only for the loopback development service. It persists a separate volume and pins the image digest.

```sh
pnpm install --frozen-lockfile
pnpm infra:up
pnpm build
pnpm db:migrate
pnpm worker:search --once
# Separate terminals:
pnpm --filter @raui/api start
pnpm --filter @raui/web start
pnpm worker:media
pnpm worker:search
```

`API_INTERNAL_URL` is server-only. `WEB_ORIGIN` must match the browser origin exactly. `SITE_URL` controls canonical links. Raster map tiles and attribution are optional build-time `NEXT_PUBLIC_MAP_TILE_URL` / `NEXT_PUBLIC_MAP_ATTRIBUTION` settings. Without a tile provider, Leaflet still renders coordinates, price markers, navigation and polygon selection; the geographic background must be configured before public release. There is no default third-party map request or analytics vendor.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
# Install browsers once in a writable browser cache:
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/browsers" pnpm --filter @raui/web exec playwright install --with-deps chromium firefox webkit
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/browsers" pnpm test:e2e
# Existing Chromium can be used if browser downloads are unavailable:
CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e
pnpm smoke
pnpm smoke:core
pnpm search:reconcile
pnpm smoke:search
pnpm infra:down
```

Integration creates a separate random local PostgreSQL database for each suite and a separate OpenSearch alias. E2E creates its own database/index, two listings and a buyer/seller, runs **built artifacts** on ports 3100/3101, then removes its database/index and stops its processes. It never seeds the developer database. Browser traces/logs stay under ignored `.cache`; they can contain test session data and must not be published. Default Playwright projects: Chromium, Firefox, WebKit, Android Chromium, iOS WebKit. Chromium covers the engine used by Chrome/Edge; these are engine/emulation checks, not certification of physical mobile devices or every branded browser. CI installs the three engines and runs all projects. An explicitly supplied system Chromium runs two supported local projects.

## Search architecture and contract

PostgreSQL is authoritative. `public_search_listings` encapsulates the existing publication, active seller, verified contacts and active organization/membership rules. Search documents contain public text, numeric price/price per m², category/deal/source/seller role, date, location and typed nested attributes. No seller IDs, account contacts, source credentials or original media keys enter the index. Floor and completion year derive from linked physical structure records when available; other optional values remain absent unless supplied.

- `POST /v1/search`: validated JSON filters, typo-tolerant Russian text/synonym analyzer, unique-ID sort tie-breaker, query-bound 15-minute `search_after` cursor, category/deal facets.
- `POST /v1/search/map`: same query/filter contract, required bounds or a closed polygon, PostGIS revalidation, bounded grid clustering, price markers and listing IDs.
- `GET /v1/listings/:id/public`: existing authoritative detail; Next.js renders it server-side with canonical metadata and escaped JSON-LD.
- `GET /v1/search/sitemap`: public IDs/dates, bounded at 50,000. This is a sitemap hook; sitemap splitting and content automation remain Phase 4.
- `POST /v1/geo/layers`: typed boundary/POI provider hook; the default adapter explicitly returns `configured: false` and empty features.

OpenAPI includes request contracts. `search/contracts.ts` centralizes extensible filter configuration; per-attribute typed nested clauses and parameterized PG predicates avoid a monolithic hard-coded query. Optional attribute definitions are seeded by migration 002 and feed the advanced filter UI. Extending the initial search attribute set requires adding the code to that registry; index mapping remains stable because nested values use number/keyword/boolean fields.

Public cards are fetched in batches and live filters/authorization/geometry are rechecked in PostgreSQL. Index lag can suppress newly published results until the worker catches up, but cannot return private or newly ineligible listings. Counts/facets are derived estimates and may lag. Cursor pagination is live, without a point-in-time snapshot; concurrent price/publication changes can move entries between pages. Clients must restart a changed search, and expired cursors return 400. Search outages return 503 with an actionable frontend error instead of silently falling back to incompatible database semantics.

## Indexing, reindex and reconciliation

Migration triggers enqueue affected listing IDs **in the same transaction** as listing/property/address/structure/seller/organization/membership/source changes, including row deletion tombstones. Jobs have monotonically increasing revisions. The worker uses external versions, retains tombstones to prevent resurrection, and acknowledges only the exact revision it wrote. Failed requests leave the queue intact. A DB advisory lock serializes workers and alias switches; workers release it between batches so reindex can proceed. Indexing refreshes once per batch rather than per document.

```sh
pnpm search:reconcile
pnpm search:reindex
```

Normal workers reconcile at startup and every hour. Reconciliation requeues PG listings and scans indexed IDs to tombstone orphans. Reindex creates `alias-v3-<timestamp>`, copies PG in 100-row keyset batches, refreshes, atomically switches the alias, and drains queued changes. Old indices are retained for review/rollback; cleanup is an explicit operator operation. A failed copy does not replace the live alias. A failure after alias switch is forward-fixed by restarting the worker/reconciliation; authoritative hydration still enforces privacy.

Synonyms live in versioned mapping configuration and require reindex to update. The initial Russian synonym group is a foundation, not an externally managed dictionary. Inference/AI relevance is outside this phase.

## Product data and privacy

Migration **002_search_product.sql** is additive. It adds the public view, durable search queue/sequence/triggers/indexes, optional typed catalog attributes, owner-scoped collection/saved-search tables, participant-scoped threads/messages, notifications/preferences and an external-channel outbox. Applied migration 001 is unchanged.

`/v1/account` APIs use existing sessions and CSRF rules. Favorites/comparison/recent return only currently public listings; comparison caps at 10, recent history at 100. Saved definitions have an inactive subscription flag for future opt-in delivery. Saved searches never accept a stored pagination cursor. Threads are accessible only to their buyer and original seller, including after a listing is unpublished; organization peers/admins do not gain implicit access to conversations. Inquiries require a currently public listing and cannot target the seller's own listing. Messages are plain escaped text, bounded to 4,000 characters. Message + in-app notification + requested external outbox rows commit atomically. Mutation retries may duplicate messages: do not automatically retry sends; transport adapters must use the outbox ID as their idempotency key.

Only in-app notifications are operational. Email/SMS/push preferences and durable outbox/transport interfaces are foundations; an unconfigured adapter returns `deferred` and never claims a send succeeded. No external notification worker/provider or full CRM has been introduced. Unread notifications carry thread references, not message bodies or contact details.

## Performance and rollout

Page size ≤50, map selection ≤2,000 candidates, ≤100 polygon vertices. Map responses disclose truncation and ask users to zoom. They apply index geo filters before PostGIS validation; clusters are viewport grid buckets, not a global precomputed hierarchy. List cards use a single batched media query with one ready image per listing. Maps are loaded dynamically; variants are already resized/compressed by the Phase 2 worker. Media intentionally bypasses Next's public image cache to preserve revocation semantics. Private and mutable public data use `no-store`; no unsafe shared account cache.

Important PG indexes: existing `addresses_point` GiST for `ST_Intersects`; new listing-property/source, property-address/floor/building dependency indexes; account-owner/kind, saved-owner, thread-participant, thread-message and notification-owner indexes. Tests exercise real PostGIS bounds/polygons and map/list consistency. Performance coverage checks batching and bounded responses; fixture timings are not a load-test SLA. Benchmark representative production-sized data before adjusting the 2,000-candidate cap or cluster resolution. The existing per-IP API rate limiter sees the same-origin proxy address; multi-host deployment must configure trusted client-address forwarding before public release. That deployment work is not performed here.

Rollout order: back up → review migration 002 → apply expand migration → configure isolated index/provider env → start worker → reconcile/reindex → deploy API/web artifacts → smoke. Only local development migration was executed in this task. Do not run production migrations from this branch.

Rollback: revert application artifacts/stop the new worker; keep additive schema and immutable audit/history. If needed, switch search alias to a retained previous index under the same advisory lock and reconcile against PG. Never delete volumes, revert migration checksums, drop product data or erase audit records. Forward fixes use migration 003+ and a new index version. Operational network credentials, map attribution and external transport configuration require deployment-specific review.

Phase 4 intentionally deferred: billing, paid promotion, ads, business feed tooling, AI/recommendations/valuation, market analytics, full SEO/content automation and production rollout.
