# RAUI.RU — Master Execution Plan

Version: 1.0
Repository: RAUI.RU
Default branch: master

This file is the authoritative staged implementation plan for Codex.

## Global working rules

1. Work phase-by-phase. Never jump ahead.
2. Never implement large changes directly on master.
3. Use a dedicated feature branch for each phase.
4. Add tests with implementation.
5. Run lint, typecheck, unit/integration/E2E/smoke as applicable, and build.
6. Fix failures before completion.
7. Database changes are versioned migrations only.
8. Prefer backward-compatible migrations: expand -> backfill -> switch -> contract.
9. PostgreSQL/PostGIS is transactional source of truth.
10. Redis/OpenSearch are derived/read-optimized systems.
11. Long-running work goes to queues/workers.
12. Media goes to object storage/CDN abstractions; never large DB blobs.
13. External providers are behind adapters/interfaces.
14. No secrets in Git.
15. Critical actions need auditability.
16. Risky changes use feature flags where appropriate.
17. Stop after each phase and prepare a PR. Do not continue automatically.

## Phase 1 — Foundation

Status: COMPLETE and merged to master.

Delivered:
- pnpm monorepo;
- Next.js web;
- NestJS API;
- Python scaffold;
- PostgreSQL/PostGIS;
- Redis;
- Docker/local infrastructure;
- strict TypeScript;
- lint/format/typecheck/test/build/smoke;
- health endpoints;
- GitHub Actions;
- engineering docs.

## Phase 2 — Core data model, auth, roles, listings and media

Goal: implement the secure domain core.

Required:
- registration/login/logout/password reset/email verification/phone verification abstraction;
- secure sessions and revocation;
- role model: guest, buyer/renter, owner, agent, agency, developer, platform admin;
- organizations and membership permissions;
- Property, Listing and ListingSource as separate domain entities;
- buildings, residential complexes, addresses, PostGIS coordinates, categories, configurable attributes;
- listing lifecycle: draft, processing, moderation, published, paused, archived, sold, rented, rejected;
- listing history and audit;
- media upload/processing abstraction with object storage;
- geocoding provider abstraction and manual coordinate correction;
- moderation-case baseline;
- protected admin baseline;
- safe migrations and automated tests.

Authoritative detailed requirements: docs/RAUI_TZ_v1.0.md and GitHub Issue #2.

Exit gate:
- verified/authorized user can create and publish a listing;
- unauthorized actions are blocked;
- migrations apply cleanly;
- Property/Listing/ListingSource are distinct and tested;
- history/audit works;
- PostGIS persists geo data;
- media pipeline works through abstraction;
- lint/typecheck/test/build/smoke pass;
- PR to master prepared;
- STOP before Phase 3.

## Phase 3 — Search, map and product experience

After Phase 2 is merged:
- OpenSearch indexing, relevance, typo/synonym handling;
- configurable filters and sorting;
- list/map synchronization;
- map clustering, area search and dynamic loading;
- listing detail experience;
- favorites, comparison, saved searches;
- messaging and notifications;
- mobile-first UX;
- cross-browser and accessibility hardening;
- professional account UX needed for discovery/listing workflows.

## Phase 4 — Monetization, AI, analytics and production hardening

After Phase 3 is merged:
- payments and billing;
- configurable promotion products (Premium/VIP/SuperVIP/Top etc.);
- advertising placements/campaigns;
- agency/developer feeds and professional tooling;
- AI Search, AI Realtor, AI Description, AI Moderation, duplicate detection, recommendations, valuation/support interfaces;
- SEO, structured data and market analytics;
- security/load testing;
- observability hardening;
- backup/DR;
- release gates and production launch readiness.

## Definition of phase completion

A phase is complete only when:
- planned scope is implemented;
- tests exist and pass;
- docs/migrations updated;
- branch pushed;
- PR prepared with summary, test evidence, migration notes, risks and rollback/forward-fix plan;
- implementation stops at the phase gate.
