# Listing moderation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task, with independent review before completion.

**Goal:** Allow authorized staff to block or remove a listing, accept owner corrections, and expire an uncorrected block after 30 days.

**Architecture:** Add a moderation restriction independent of the owner's listing status, preserving existing publication approval and ownership rules. Enforce the restriction at authoritative reads and writes, not only in OpenSearch. Use a bounded resumable worker for expiry and cleanup; no live deployment is part of implementation.

**Tech Stack:** Node 24, pnpm 10.0.0, strict TypeScript, NestJS, PostgreSQL/PostGIS, OpenSearch, Next.js.

**Spec:** `docs/ACCOUNT_APPROVAL_RETENTION_DESIGN.md`, section “Модерация объявлений и жалобы”; user approved the 30-day rule.

## Global constraints

- Work in the existing checkout and a dedicated feature branch; do not merge/deploy.
- Do not modify applied migrations. Add the next sequential migration from the implementation base.
- Preserve CSRF/Origin, session verification, seller eligibility, organization access and idempotency.
- Moderator powers do not include passwords, tokens or arbitrary personal messages.
- Do not implement 90-day account cleanup, contact retention, SMS, or new tariffs in this block.
- Exercise deletion only on isolated fixtures; cleanup worker starts disabled by default.

## Review focus

- Stale search results and direct media URLs must not expose a blocked listing.
- An owner cannot remove a staff restriction by editing, paying or changing lifecycle status.
- Timely corrections awaiting staff review must not expire because of review delay.
- Repeated requests must not reset the deadline or create concurrent correction cases.
- Deleting one listing must not destroy shared properties, media, billing or other users' records.

## Task 1: Restriction state and authorized decisions

**Files:** New `apps/api/src/modules/listings/moderation.ts`; new sequential SQL migration; modify `apps/api/src/modules/admin/admin.ts`, `apps/api/src/modules/listings/access.ts`, `apps/api/src/common/openapi.ts`; tests in `apps/api/src/core.integration.test.ts` and `apps/api/src/core.test.ts`.

**Interfaces:** Restriction rows carry listing ID, state (`blocked`, `review_pending`, `resolved`, `removed`), immutable block time/deadline, blocking actor/reason and version. Reasons include a user-visible category, explanation and required corrections; staff-only evidence is separate. A user-ID-scoped strict-review flag records only confirmed violations and minimal decision history, surviving deletion of a listing. Staff block/remove consumes listing version and idempotency key. Staff decisions require named permissions issued and revoked by an administrator; absence of a grant denies access. Complete the permission foundation before adding these actions. Never grant the broad admin role as a substitute.

- [ ] Add real HTTP regressions: nonstaff block/remove rejected; staff block requires reason; duplicate request returns original result/deadline; stale version rejected; own-listing moderation remains forbidden.
- [ ] Run `pnpm test:integration`; observe the missing endpoint/state failures before implementing.
- [ ] Add the additive schema and transactional staff endpoints; use existing property/listing lock order and `Audit.record`/minimal history events. Return reason, exact deadline and restriction version to authorized callers.
- [ ] Add negative tests for empty reasons and complaint-only strict-review escalation; prove user-visible reasons exclude private complainant/evidence fields. Strict-review status requires a confirmed staff decision and an audited staff-only reset.
- [ ] Ensure blocked listings return 404 through public detail and disappear from list/map/SEO, including a stale OpenSearch document. Private owner access remains available for corrections; check private media versus public media eligibility separately.
- [ ] Run unit/integration tests and confirm wrong-role, stale-index and direct-detail cases pass. Update OpenAPI security and response contracts.
- [ ] Update migration verification/recovery/release contract counts and add negative tests proving a previous migration manifest is rejected. Commit the complete schema/decision block.

## Task 2: Owner corrections and staff re-review

**Files:** `apps/api/src/modules/listings/moderation.ts`, `apps/api/src/modules/listings/listings.ts`, `apps/api/src/modules/admin/admin.ts`, `apps/api/src/modules/search/index.ts`, `apps/api/src/core.integration.test.ts`, `apps/api/src/common/openapi.ts`.

**Interfaces:** `submitCorrection(actor, listingId, {listingVersion, restrictionVersion}, key)` creates one pending review for the current blocked restriction. It requires an actual new listing content version, preserves `blocked_at`/deadline and records server submission time. `reviewCorrection` accepts an immutable submitted listing version and an approve/reject decision with reason.

- [ ] Write failures for unchanged/duplicate submissions, wrong owner, owner transition bypass, and staff approval of a stale listing version.
- [ ] Observe failures, then implement submission and review using the existing ownership and publication validation. Editing and ordinary publication decisions must not bypass an unresolved restriction.
- [ ] Timely submission enters `review_pending`; it remains nonpublic until staff approval. Duplicate or empty resubmission cannot extend the deadline. Approval resolves the restriction only after normal eligibility checks.
- [ ] Rejection returns to blocked state with the original deadline; do not invent a fresh automatic 30-day extension. If staff needs an extension, obtain the missing explicit product rule before adding that operation.
- [ ] Let an authorized owner remove their blocked listing and submit a new one. Preserve the user-ID-scoped strict-review flag and require staff review of replacement listings; deletion/new submission cannot erase confirmed violations or lift publication restrictions. Add real HTTP tests for both paths and wrong-owner removal.
- [ ] Prove that pending review survives a deadline crossing, that approval restores eligible public visibility, and that rejection does not expose the listing or reset its deadline. Commit.

## Task 3: Bounded expiry and safe removal

**Files:** New `apps/api/src/modules/listings/moderation-worker.ts` and `apps/api/src/moderation-worker.ts`; worker command in `apps/api/package.json`; configuration in `apps/api/src/config.ts`; cleanup integration tests; existing media/storage and search-index interfaces.

**Interfaces:** `expireBlockedBatch(limit)` claims bounded due blocked restrictions, rechecks authoritative state and submission timestamp under locks, then emits durable removal/cleanup work. Due means server time at or after `blocked_at + interval '30 days'`. `review_pending` is never automatically expired by this handler.

- [ ] Write clock-boundary tests just before/at/after 30 days; race timely submission with expiry; retry a claimed task after simulated crash.
- [ ] Observe failures, then implement transactional transition to removed and immediate public exclusion. Repeated cleanup attempts must not resurrect content, double-delete shared files or reset deadlines.
- [ ] Build an explicit inventory of content/media references before physical cleanup. Keep shared Property/ListingSource/media and mandatory billing records; remove only listing-exclusive data. Avoid persisting a full content snapshot in the removal event.
- [ ] Use `ObjectStorage.delete` and versioned OpenSearch tombstones through durable retries. Distinguish marking content unavailable from completion of file/index cleanup; report failures safely without secrets.
- [ ] Test shared files, partial storage/index failure, old queued indexing updates and worker restart. Run only isolated fixtures, with the worker disabled in default runtime configuration. Commit.

## Task 4: Staff/owner UI, notifications and complete verification

**Files:** Existing web admin/listing components selected after reading their current routes; new focused moderation components/tests where needed; `apps/web/e2e/product.spec.ts`; notification model/API; `docs/LISTING_MODERATION.md`.

**Interfaces:** Owner view shows block category, explanation, required corrections, exact deadline and correction-review state, with choices to correct/resubmit or delete/create anew; staff view shows listing materials, complaint/case context, reasoned decisions and current versions. Reuse existing API client and in-portal notification mechanism; do not send real email/SMS.

- [ ] Add failing UI tests for the blocked-owner view, correction submission, role-restricted controls and visible destructive-action confirmation.
- [ ] Implement the views and in-portal notifications. State changes and notification creation share a durable transaction/outbox path, preventing silent success or duplicate notices.
- [ ] Add a real-browser journey: staff blocks → public detail/search unavailable → owner corrects → pending review stays nonpublic → staff approves → public visibility returns. Add an independent expiry integration journey with a synthetic old block.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, real-service integration, browser E2E, repeated migrations, recovery drill and built smoke. Full CI must pass against the final head.
- [ ] Independently review authorization, the deadline race, shared-data cleanup and stale-index exposure. Document exact SHA, migrations, remaining provider/product limits and rollback. Prepare a PR; no merge/deploy or live removal.

## Self-review and scope boundaries

Tasks cover staff decisions, authoritative visibility, owner corrections, review-delay protection, expiry, cleanup and UI. Existing complaint intake must be inspected before implementing UI; if absent, add a separate bounded complaint-intake task rather than falsely claiming that queue exists. Existing paid promotion is not a complete base-listing tariff model: tariff expiry/nonpayment is outside this plan and must not be claimed delivered by moderation expiry.

Removal is not reversible by code rollback. Retain additive schema and queued cleanup facts, stop worker claims to halt future removals, and use a separately approved recovery procedure for actual data restoration. The 90-day account policy and remaining retention/six-month decisions stay outside this implementation block.
