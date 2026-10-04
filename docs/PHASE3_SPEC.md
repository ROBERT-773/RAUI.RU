# RAUI.RU — Phase 3 Specification

## Goal

Build the primary user-facing product experience on top of the merged Phase 2 core.

Work from the current `master` after Phase 2. Use a dedicated branch:
`feat/stage-3-search-product`

Do not modify `master` directly. Do not begin Phase 4.

## Read before coding

- `docs/RAUI_MASTER_EXECUTION_PLAN.md`
- `docs/RAUI_TZ_v1.0.md`
- `AGENTS.md`

Before implementation:
1. summarize the approach;
2. list affected modules/files;
3. identify data/indexing/API contract changes;
4. identify migration and rollout risks.

## 3.1 OpenSearch indexing and search API

Implement:
- OpenSearch index/mapping for public listings;
- indexing pipeline from PostgreSQL source of truth;
- create/update/publish/pause/archive/delete synchronization;
- safe reindex strategy with versioned aliases;
- typo tolerance where supported;
- synonyms foundation;
- filters and sorting;
- cursor pagination;
- search result facets/counts where practical;
- stale-index recovery/reconciliation job;
- search API contract tests.

PostgreSQL remains source of truth. OpenSearch is derived.

## 3.2 Filters and sorting

Support the core filters from the technical specification, including where data exists:
- property/deal type;
- price / price per m²;
- rooms;
- area;
- floor / floors;
- building year/type;
- renovation;
- bathroom;
- balcony/loggia;
- ceiling height;
- elevator;
- parking;
- furniture/equipment;
- mortgage;
- owner/agent/professional source;
- new-build / secondary;
- publication date;
- metro;
- district / okrug;
- city/locality;
- highway/distance where supported by data.

Filters must be configurable/extensible and must not require hard-coding one monolithic query.

## 3.3 Map search

Implement map-search backend/frontend foundation:
- viewport/bounds query;
- clustering;
- price markers;
- dynamic loading;
- map/list synchronization;
- district/okrug boundary hooks;
- POI/provider abstraction hooks;
- user-drawn polygon/area search foundation;
- manual coordinate correctness retained from Phase 2;
- provider abstraction — no hard lock-in to one map vendor.

Use PostGIS for geo queries and document important indexes.

## 3.4 Frontend product experience

Build a production-quality, mobile-first experience for:
- home/search entry;
- search results list;
- map mode;
- search filters;
- listing card;
- public listing detail;
- loading/skeleton/error/empty states;
- responsive navigation;
- basic account shell required for these flows.

Use existing Next.js/React/TypeScript stack and shared UI package.

Do not create a second frontend stack.

## 3.5 Favorites, comparison and saved searches

Implement:
- favorites;
- compare;
- saved search definitions;
- saved search CRUD;
- history/recently viewed foundation;
- authorization and privacy tests.

Saved search model should be compatible with later notification subscriptions.

## 3.6 Messaging and notifications baseline

Implement only the baseline needed for product UX:
- listing inquiry/message thread foundation;
- basic in-app notification model;
- notification preference foundation;
- queue/adapters for future email/SMS/push;
- no hard dependency on a specific provider.

Full CRM automation and omnichannel workflows belong later.

## 3.7 Accessibility, responsive and cross-browser

Required:
- mobile-first layouts;
- keyboard navigation;
- semantic structure;
- focus states;
- labels/ARIA where needed;
- no critical flow dependent on hover;
- current stable Chrome, Safari, Firefox, Edge;
- iOS Safari and Android Chrome considerations.

## 3.8 Performance

Requirements:
- avoid N+1 API/data patterns;
- pagination everywhere needed;
- cache safe read paths where useful;
- lazy-load heavy map/media UI;
- image optimization;
- avoid blocking rendering on non-critical data;
- document search/map performance assumptions;
- add targeted performance regression coverage where practical.

## 3.9 SEO foundation for public listing pages

Implement:
- SSR/metadata for public listing pages;
- canonical URL;
- basic structured data;
- sitemap hooks/foundation;
- correct noindex handling for unsuitable search/filter combinations;
- avoid generating infinite indexable filter combinations.

Full SEO/content automation belongs to Phase 4.

## 3.10 Analytics event foundation

Create typed event contracts for:
- search performed;
- result viewed;
- listing viewed;
- favorite added/removed;
- contact/message initiated;
- filter changed;
- map/list mode changed.

Keep provider behind an adapter; no vendor lock-in.

## 3.11 Automated tests

At minimum:
- OpenSearch indexing tests;
- search/filter/sort tests;
- geo/bounds/polygon tests;
- map/list contract tests;
- favorites/compare/saved-search tests;
- public listing detail tests;
- auth/privacy tests;
- frontend component tests for critical states;
- E2E: search -> filter -> open listing -> favorite;
- E2E: map/list synchronization;
- E2E: saved search;
- cross-browser smoke where supported;
- accessibility baseline checks where supported.

Run and pass:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- integration tests
- smoke tests
- any new search/map E2E checks

## Non-goals

Do not implement Phase 4:
- payments/billing;
- VIP/Premium/SuperVIP/Top;
- advertising campaigns;
- full developer/agency feed business tooling beyond interfaces required here;
- AI search/realtor/valuation/recommendations;
- full market analytics;
- production launch hardening beyond required safe engineering.

## Exit criteria

Phase 3 is complete only when:
- public user can search and filter listings;
- results can be explored in list and map modes;
- public listing detail works;
- favorites and saved searches work;
- core messaging/in-app notification baseline works;
- mobile/responsive UX is usable;
- accessibility baseline is present;
- OpenSearch indexing/reconciliation works;
- PostGIS geo queries are tested;
- required checks are green;
- branch is pushed;
- PR to `master` is prepared;
- implementation stops before Phase 4.

Final report must include:
- implementation summary;
- search/index design;
- migrations/schema changes;
- test commands/results;
- performance notes;
- known risks;
- rollback/forward-fix plan;
- intentionally deferred Phase 4 items.
