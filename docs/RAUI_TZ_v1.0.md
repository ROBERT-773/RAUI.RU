# RAUI.RU — Technical Specification v1.0

## 1. Product purpose

RAUI.RU is a real-estate portal for Moscow and Moscow Region intended to match the core capabilities of leading property portals while simplifying user flows and maximizing automation.

Core principles:

- automation-first;
- API-first;
- modular architecture;
- mobile-first UX;
- high-load readiness;
- safe extensibility;
- strong automated testing;
- observable and secure by default.

## 2. Main property categories

Initial categories:

- apartments;
- rooms;
- apartments/aparthotel units;
- new-build units;
- secondary housing;
- houses/cottages;
- townhouses;
- land plots;
- commercial real estate;
- garages and parking spaces.

Deal types:

- sale;
- long-term rent;
- short-term rent.

Category-specific attributes must be extensible/configurable.

## 3. User roles

Support:

- guest;
- buyer/renter;
- owner;
- agent;
- agency;
- developer;
- platform administrator.

Professional accounts must support organizations, members, role/status, activation/deactivation and audit.

Authorization model: RBAC plus contextual rules where needed.

## 4. Search and filters

Future search must support:

- property/deal type;
- price and price per m²;
- rooms;
- area;
- floor/floors;
- building year/type;
- renovation;
- bathroom;
- balcony/loggia;
- ceiling height;
- elevator;
- parking;
- furniture/equipment;
- mortgage;
- owner/agent;
- new-build/secondary;
- publication date;
- metro;
- district/okrug;
- city/locality;
- highway/distance.

Search state must have stable URLs and support sorting, cursor pagination and saved searches.

## 5. Map search

Map is a first-class search mode, not a secondary widget.

Required future behavior:

- markers and price labels;
- clustering;
- dynamic loading by viewport;
- district/okrug borders;
- POIs;
- user-drawn area;
- map/list synchronization;
- geocoding;
- manual marker correction;
- travel/distance support where provider permits.

## 6. Automated listing creation

The listing form should ask only for what cannot be reliably inferred.

Flow foundation:

1. deal type;
2. property type;
3. address/autocomplete;
4. geocoding/map marker;
5. building/complex prefill where available;
6. property characteristics;
7. media;
8. automatic media processing;
9. future AI description;
10. future price range estimate;
11. duplicate check;
12. automated moderation;
13. preview;
14. publish;
15. autosaved draft throughout.

All automatic values must be editable.

## 7. Core domain model

Critical rule: physical object, commercial offer and source are separate entities.

### Property

Physical real-estate object.

### Listing

Commercial offer: deal type, price, terms, seller, status.

### ListingSource

Origin: direct user, agency, developer, feed/API.

Supporting domain:

- buildings;
- residential complexes;
- addresses;
- geo coordinates;
- listing history;
- categories;
- configurable attributes;
- source metadata;
- audit fields.

## 8. Listing lifecycle

Target statuses:
draft -> processing -> moderation -> published -> paused -> archived / sold / rented / rejected

Required:

- validated transitions;
- auditable history;
- actor and timestamp;
- price history;
- critical field-change history.

## 9. Media

Media types:

- photos;
- future video;
- floor plans;
- future 3D.

Image pipeline:

- MIME/extension validation;
- size limits;
- EXIF orientation correction;
- metadata cleanup;
- compression;
- responsive sizes;
- WebP/AVIF where supported;
- thumbnails;
- original separated where configured;
- object storage;
- CDN abstraction;
- async processing.

Do not store large binaries in PostgreSQL.

## 10. Trust, moderation and deduplication

Foundation must support:

- moderation cases;
- basic automated rule hooks;
- source tracking;
- future verification statuses;
- future duplicate detection confidence/reasoning;
- no irreversible merge of uncertain duplicates.

Full AI moderation/anti-fraud is later phase work.

## 11. Personal accounts

Buyer/renter:

- favorites;
- compare;
- history;
- saved searches;
- subscriptions;
- messages;
- leads;
- future AI selection.

Owner:

- listings and drafts;
- statistics;
- leads;
- promotion;
- price changes;
- freshness control;
- listing quality recommendations.

Professional:

- portfolio;
- organization users;
- bulk operations;
- feeds/API;
- analytics;
- CRM foundation where applicable later.

## 12. Agencies and developers

Agencies:

- organization details;
- members and roles;
- portfolio;
- lead assignment;
- analytics;
- billing later;
- bulk promotion later;
- feeds/API;
- integration logs.

Developers:

- residential complex -> building -> section -> floor -> unit hierarchy;
- prices;
- availability;
- floor plans;
- promotions;
- completion dates;
- media;
- documents;
- feeds/API.

## 13. Notifications

Channels:

- in-app;
- email;
- SMS;
- web push;
- mobile push later.

Events:

- new lead;
- new message;
- matching object;
- price drop;
- status change;
- plan expiry;
- payment/refund;
- moderation result;
- security event.

Delivery should use queues with retries/backoff/DLQ.

## 14. Monetization

Future promotion products must be configurable, not hard-coded:

- Standard;
- Highlighted;
- Premium;
- VIP;
- SuperVIP;
- Top;
- special placements.

Billing requirements later:

- idempotent operations;
- webhooks with signature/replay protection;
- reconciliation;
- refunds;
- subscriptions;
- card/SBP provider abstraction.

## 15. Advertising

Future support:

- banners;
- native blocks;
- promoted residential complexes/agencies;
- geo/category targeting;
- self-service advertiser cabinet.

## 16. AI layer

Future modules:

- AI Search;
- AI Realtor;
- AI Valuation;
- AI Moderation;
- AI Description;
- AI Photo;
- AI Duplicate Detection;
- AI Recommendations;
- AI Analytics;
- AI Support.

Rules:

- AI is never the source of truth for critical property facts;
- model/prompt/rule versions are auditable;
- latency/cost/fallback controls required;
- uncertainty must be explicit.

## 17. SEO and analytics

SEO:

- SSR/SSG where appropriate;
- canonical;
- sitemap;
- robots;
- structured data;
- control of filter URL indexing;
- SEO regression tests;
- useful real-data landing pages.

Analytics:

- views;
- unique views;
- favorites;
- contact reveals;
- messages;
- leads;
- conversion;
- promotion effect;
- future market analytics by district/metro/category.

## 18. Admin

Protected admin foundation and later full admin for:

- users;
- organizations;
- listings;
- physical properties;
- residential complexes;
- complaints;
- moderation;
- promotions;
- ads;
- payments;
- tariffs;
- notifications;
- feeds;
- API;
- AI;
- SEO/content;
- dictionaries;
- security;
- audit;
- feature flags;
- integration health;
- queues/DLQ.

Critical admin actions must be audited.

## 19. Technology baseline

Frontend:

- Next.js;
- React;
- TypeScript.

Core backend:

- NestJS;
- TypeScript.

AI/data workers:

- Python.

Data:

- PostgreSQL;
- PostGIS;
- Redis;
- OpenSearch;
- S3-compatible object storage;
- CDN.

Architecture:

- modular monolith first;
- event-driven/background workers;
- service extraction only when justified.

## 20. Database engineering

Requirements:

- versioned migrations;
- transactions;
- documented indexes based on query patterns;
- safe migration strategy;
- rollback/forward-fix plan;
- optional partitioning only when justified;
- no direct production schema edits.

## 21. API

Requirements:

- REST/JSON baseline;
- versioning;
- OpenAPI;
- rate limits;
- idempotency for critical writes;
- API keys/OAuth later for partners;
- webhooks;
- request/error logging;
- contract tests.

## 22. High-load and performance

Use:

- PostgreSQL connection pooling;
- Redis cache/sessions;
- OpenSearch for search;
- S3+CDN for media;
- stateless horizontal scaling;
- workers for heavy work;
- cursor pagination;
- query-driven indexes;
- timeouts/retries/backoff;
- circuit breakers;
- graceful degradation.

Target server-side p95 for ordinary internal API operations: approximately <=300 ms under normal conditions, excluding intentionally slow external dependencies.

## 23. Security

Requirements:

- adaptive password hashing;
- secure sessions;
- 2FA readiness;
- RBAC/ABAC;
- rate limiting;
- bot/WAF/DDoS readiness;
- CSRF/XSS/SQLi protections;
- CSP/security headers;
- secrets outside repository;
- dependency/secret scanning;
- audit;
- anti-fraud hooks;
- pentest before production launch.

## 24. Safe change framework

All significant changes must support:

- module boundaries;
- public interfaces/events;
- versioned migrations;
- backward compatibility;
- feature flags;
- staged/canary rollout later;
- fast rollback;
- architectural tests;
- contract tests;
- visual regression;
- performance regression tests.

Release gate:
lint -> typecheck -> unit -> integration -> contract -> architecture checks -> migration checks -> E2E -> visual regression -> security scans -> build -> staging smoke/performance.

## 25. Automated testing

Required over project lifetime:

- unit;
- integration;
- API contract;
- E2E;
- visual regression;
- cross-browser;
- load;
- security;
- migration;
- smoke.

Critical pipeline must be green before production.

## 26. Mobile-first and cross-browser

Support current stable:

- Chrome;
- Safari;
- Firefox;
- Edge;
- iOS Safari;
- Android Chrome.

Core flows must be mobile-first and accessible:

- search;
- map;
- filters;
- listing detail;
- favorites;
- messages;
- listing creation.

## 27. Observability

Required:

- structured logs;
- metrics;
- tracing;
- error tracking;
- dashboards;
- alerts;
- SLO/error-budget readiness;
- DB/Redis/OpenSearch/queue/API/CDN/payment/AI metrics where applicable.

## 28. Backup and DR

Required before production:

- automated DB backup;
- tested restore;
- standby/failover strategy;
- object-storage backup where critical;
- runbooks;
- RPO/RTO definitions;
- regular restore/DR drills.

## 29. Phase 2 authoritative scope

For the currently active Phase 2, implement only:

- authentication/sessions;
- users/roles/permissions;
- organizations/membership;
- Property/Listing/ListingSource;
- buildings/complexes/address/PostGIS;
- categories/configurable attributes;
- listing draft and lifecycle;
- listing history/audit;
- media pipeline/object-storage abstraction;
- geo/geocoder abstraction;
- moderation baseline;
- protected admin baseline;
- safe migrations and comprehensive automated tests.

Do NOT advance into search UX, payments, promotions, AI product features or production launch hardening in Phase 2.

## 30. Phase 2 acceptance gate

Phase 2 is accepted when:

- a verified/authorized user can create and publish a valid listing;
- unauthorized actions fail;
- professional membership rules work;
- Property/Listing/ListingSource are separate and tested;
- listing state transitions/history are auditable;
- media processing path works through abstraction;
- PostGIS persistence is tested;
- migrations apply from clean state;
- lint/typecheck/test/build and relevant smoke/integration checks pass;
- branch is pushed;
- PR is prepared;
- implementation stops before Phase 3.
