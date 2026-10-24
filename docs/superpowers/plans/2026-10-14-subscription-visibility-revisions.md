# Subscription Visibility Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Single code writer; independent read-only security and acceptance review. All tasks below are unimplemented.

**Goal:** Prevent stale availability revival across seller/organization/membership eligibility cycles without enabling global notification fanout.

**Architecture:** Transactional dependency-generation registry feeds one neutral authoritative visibility/token snapshot. Strict v2 availability envelopes and a legacy-zero gate share that snapshot across existing immediate/daily paths.

**Tech Stack:** Node 24, pnpm 10.0.0, strict TypeScript, NestJS, PostgreSQL/PostGIS.

**Spec:** `docs/superpowers/specs/2026-10-14-subscription-visibility-revisions.md`.

## Global Constraints

- Preserve migration 001–020 bytes and current user data; use the next unapplied migration, filename selected at implementation dispatch.
- No unused source-intent table, global fanout, daily email, provider sends, dependency installation, merge or deploy.
- Public-price baseline and price-drop/message behavior remain unchanged.
- Generation values are exact canonical bigint decimal strings; unknown current registry data fails closed.
- Preserve creator-user→organization→membership→client and organization→membership→client lock orders.
- A legacy rollback consumer must suppress availability unless it retains the new token and legacy-zero gate.

## Review Focus

- Same listing version and same public boolean after a hide/show/hide cycle must not revive an earlier envelope.
- Membership deletion/recreation must not reset identity or generation; no-op writes must not discard valid notices.
- Current token and public boolean must come from one authoritative SQL snapshot.
- Missing/corrupt registry or extra/mismatched token fields must suppress availability without private-field reads.
- An old application reader/worker must not bypass the gate during rollback; prepared daily rows also require compatibility.

### Task 1: Generation storage and real writers

**Files:** create next additive SQL migration under `apps/api/migrations/`; create `apps/api/src/subscription-visibility.integration.test.ts`; update `apps/api/scripts/integration.mjs` and `migration.integration.test.ts`.

**Interfaces:** SQL registry maps immutable seller/org/membership dependency identities to bigint generations. Triggers seed inserts, advance on the spec's component changes and retain membership tombstones. Consumers read known zero only from an actual seeded row.

- [ ] Write real PostgreSQL RED tests for pre-migration seeded-zero preservation, each actual writer's relevant boolean changes, eligible-role→eligible-role/no-op preservation, rollback and membership delete/recreate ABA.
- [ ] Verify RED against the existing schema; add registry, noncycling allocator, pre-seed write-blocking table locks users → organizations → memberships, seeding/triggers in that same transaction and registry integrity guards.
- [ ] Verify GREEN with real PostgreSQL; assert 001–020 checksums and existing facts preserved, repeated migration idempotent, no notifications/source intents emitted by triggers.
- [ ] Add a PostgreSQL writer barrier proving relevant writes cannot commit between seed and trigger installation; a seed SELECT alone is not sufficient. Check lock ordering with actual admin user/org and membership writers; registry mutation must not acquire a new parent user/org lock.

### Task 2: Atomic neutral state and strict token

**Files:** `modules/listings/access.ts`; create `modules/product/subscription-visibility.ts` and `subscription-visibility.test.ts`; extend the PostgreSQL suite from Task 1.

**Interfaces:** export `VisibilityToken` with the spec's seller/organization/membership objects and `DecimalGeneration` strings. Export `readListingVisibility(sql: Sql, listingId: string): Promise<VisibilitySnapshot | null>` where `VisibilitySnapshot` is `{version:number, visible:boolean, visibilityToken:VisibilityToken|null}`. `ListingAccess.currentVisibility` delegates to it. Null token denotes invalid/missing required generation data, never a zero fallback.

- [ ] Write RED parsing assertions for bigint maximum, leading zero/sign/exponent/overflow rejection, missing/excess fields and mismatched direct/org identities; invalid current data must return no usable token.
- [ ] Implement the typed contract and single authoritative SQL projection, reusing the existing full public predicate without adding unrelated eligibility requirements.
- [ ] Verify GREEN units and PostgreSQL concurrent eligibility updates; return only version/boolean/token and never private listing fields.

### Task 3: Existing producers and all availability gates

**Files:** `subscription-contract.ts`, `subscription-outbox.ts`, `subscription-eligibility.ts`, `subscription-inbox.ts`, `subscription-daily.ts`, `professional/notifications.ts`; affected subscription unit tests, professional and daily integration suites.

**Interfaces:** `listingSubscriptionDeliverySchema` becomes a strict union of legacy envelopes and `schemaVersion:2` availability with `visibilityToken`. `eligibleListingSubscriptionEvent` retains its signature; availability uses exactly one `readListingVisibility` snapshot. Existing canonical lifecycle enqueue retains its exported signature and captures the snapshot in the caller's SQL transaction. Define `availabilityDedupeKey(listingId, listingVersion, token): string` with canonical ordered components, used by immediate and daily capture.

- [ ] Write RED tests: queued v1 and v2 events at known zero, actual same-version hide/show/hide cycle, old-token/legacy rejection after generation advance, corrupt current token, neutral unavailable privacy, dedupe replay and unchanged price baseline/price-drop payload.
- [ ] Implement producer v2 capture, token-aware dedupe and shared exact-current gate. Update every strict parsing consumer; preserve token bytes through daily candidate/manifest preparation.
- [ ] Update fresh fixtures to produce v2; keep genuine pre-migration zero legacy fixtures for compatibility tests. Never disable triggers to make legacy payloads pass.
- [ ] Verify GREEN immediate email/inbox and daily preparation/read behavior, including stale mark-read, raw cursor, opt-out and exact manifest identity. No global source producer is added.

### Task 4: Acceptance and forward/rollback contracts

**Files:** API unit test script; current runtime/release/recovery migration manifests/counts and fixtures; `docs/MIGRATIONS.md`, `docs/RELEASE_ROLLBACK.md` and actionable staging acceptance ledger references.

- [ ] Add actual PostgreSQL barrier tests for eligibility changes and registry rollback with queued availability; assert no transport or inbox disclosure on rejection and no new source→recipient lock cycle.
- [ ] Advance current migration contracts together; preserve historical evidence descriptions and prior SQL bytes.
- [ ] Run required lint/typecheck/test/build/security plus real PostgreSQL, migration/runtime/recovery acceptance on the exact published head. Report environmental failures honestly; do not weaken the known local socket-ownership test.
- [ ] Obtain read-only security/acceptance review and hand off guarded publication/CI to root. Report this as availability invalidation groundwork, with global event fanout and daily email still unimplemented.
