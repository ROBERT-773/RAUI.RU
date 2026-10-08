# Owner Publication Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The user selected parallel agents and autonomous execution; runtime work begins only after the current registration-onboarding CI gate passes.

**Goal:** Enforce six simultaneous published Properties per owner and show accurate own-account capacity while preserving drafts and existing publications.

**Architecture:** A small publication-quota service owns fresh seller eligibility, a seller-row mutex and distinct-Property counting. Staff approval invokes it before existing property/listing/case locks; the existing ProductController exposes an informational own-account snapshot. OwnerListings alone consumes that snapshot without treating promotions as publication entitlements.

**Tech Stack:** Node24, pnpm10, strict TypeScript, NestJS, PostgreSQL, Next.js/React, Vitest and existing integration/browser harnesses.

**Spec:** ../specs/2026-10-08-owner-publication-quota.md

## Global Constraints

- Existing checkout and dedicated feature branch; no merge/deploy or remote migration.
- Limit six; count DISTINCT property_id for seller_id and status published, including organization sources.
- Drafts/nonpublic states do not count; already-counted Property offers remain allowed at or above capacity.
- Existing over-limit publications remain; no backfill mutation or automatic unpublication.
- Seller mutex uses FOR NO KEY UPDATE before property/listing/case locks; never FOR UPDATE.
- Fresh active/approved/role/email/phone checks; existing media/trust/organization/staff checks remain.
- No automatic owner conversion, paid base-placement entitlement, charges or cleanup.
- GET /v1/account/publication-quota returns applies, limit, publishedObjects, remaining only.

## Review Focus

- Two distinct Properties approved concurrently from five must not become seven.
- FK key-share locks from audit/history/idempotency inserts must not deadlock seller mutex acquisition.
- Current seller role/contact/activation/registration state must defeat stale guard snapshots.
- Organization portfolios and promotion products must not bypass the seller's owner quota.
- A late quota response must not display a previous account's private count or imply failed fetch means zero.

## File structure and ownership

- Create `apps/api/src/modules/listings/publication-quota.ts`: service, types and exporting module depending only on global Database.
- Modify `apps/api/src/modules/product/product.ts`: import the quota module/service and expose GET publication-quota on existing ProductController. ProductModule currently imports ListingAccessModule and SearchModule, not ListingsModule; the focused quota module avoids changing that dependency topology.
- Modify `apps/api/src/modules/admin/admin.ts`: import service module and enforce publication transaction lock order/capacity.
- Modify `apps/api/src/common/openapi.ts`: exact GET response and documented quota409.
- Create `apps/api/src/publication-quota.integration.test.ts`: real HTTP/database behavior, races and own-account privacy.
- Modify `apps/api/scripts/integration.mjs`: register new isolated integration suite.
- Preserve all16 applied migrations and ledger-count expectations; no schema/index migration without representative query-plan evidence.
- Preserve `apps/web/components/account-profile.tsx` and its tests unchanged; quota display is only in OwnerListings, avoiding duplicate requests.
- Modify `apps/web/components/owner-listings.tsx`, `apps/web/components/owner-listings.test.tsx`: explain simultaneous objects and preserve draft CTA.
- Modify `apps/web/lib/client.ts` only if required to expose safe exact quota error code; preserve numeric status and generic errors for unrelated responses.
- Existing `apps/web/app/api/[...path]/route.ts` already admits account routes: verify the new GET through existing proxy tests; do not widen its generic allowlist.
- Modify `apps/web/e2e/owner-publication.spec.ts`: authenticated owner quota/read-only UI journey.

### Task 1: Quota source of truth and own-account contract

**Interfaces:** Produce `PublicationQuota = {applies:boolean;limit:number|null;publishedObjects:number|null;remaining:number|null}`, `PublicationQuotas.own(actor:Actor):Promise<PublicationQuota>`, `PublicationQuotas.lockSeller(sql:Sql,sellerId:string):Promise<PublicationSeller>`, `PublicationQuotas.assertCapacity(sql:Sql,seller:PublicationSeller,propertyId:string):Promise<void>`, and `PublicationQuotaModule`. PublicationSeller contains id, role, active, email_verified_at, phone_verified_at, registration_approval_state; use current database values, not request-body input.

- [ ] Write isolated integration failures named `owner quota counts distinct published properties`, `nonpublic statuses do not consume slots`, `owner organization offers and promotions count`, `own endpoint excludes other sellers`, `nonowners return null quota`, `pending inactive and guest reads are denied`, and `overlimit snapshot retains accurate count`. Assert exact payloads from the spec, including count7/remaining0.
- [ ] Register the suite in `apps/api/scripts/integration.mjs`; run `pnpm test:integration` and observe missing endpoint/service assertions fail, rather than fixture/setup errors.
- [ ] Implement service/types/module and add the route to existing ProductController. Read current seller row, take FOR NO KEY UPDATE for publication writes, require fresh approved verified active seller, and count published DISTINCT Properties. Existing-property check precedes capacity rejection; return the exact409 code/copy. Import PublicationQuotaModule into both AdminModule and ProductModule; inject its exported service. Keep the service dependent only on global Database, avoiding Listings/Product/Admin cycles.
- [ ] Add OpenAPI GET response, nullable non-owner fields and safe409 schema; preserve other response contracts. Leave migrations and release/restore-ledger expectations unchanged.
- [ ] Run isolated integration/migration tests and OpenAPI contract tests; require existing clean/repeat/populated migration gates remain green, preserved users/listings, pending central denial and exact own-account payloads.

### Task 2: Serialized staff publication approval

**Interfaces:** Consume Task1 lockSeller/assertCapacity and existing `AdminService.decision(actor,id,body,key)`. Preserve the successful `{listingId,status}` response and existing version/idempotency behavior.

- [ ] Add failing tests `sixth publishes seventh remains pending`, `same property second offer does not allocate slot`, `republish reevaluates capacity`, `pause release depends on final offer`, `overlimit legacy owner can publish counted property`, and `draft submission remains available at capacity`. Assert no failed-case/history mutation. Add `capacity freed permits staff retry of same pending request`: after quota409, release a slot and retry that case without owner resubmission; assert one successful history event.
- [ ] Add real concurrent tests using two connections and explicit barriers: `distinct property approvals serialize at six`, `same property offers serialize without double counting`, `role change under user mutex uses fresh eligibility`, `deactivation contact loss and approval rejection prevent publication`, and `FK key share plus concurrent decisions do not deadlock`. Have an independent connection hold user FOR KEY SHARE, verify publication's FOR NO KEY UPDATE completes; exercise same reviewer audit/history/idempotency inserts and bounded connection completion. Do not use timing sleeps as the only evidence of ordering.
- [ ] Run `pnpm test:integration`; confirm capacity/race tests fail on current implementation.
- [ ] In decision, resolve seller/property references, lock seller first with Task1 helper, then property/listing/case, recheck references/version, and assert fresh eligibility/capacity before update. Keep rejection behavior and existing media/trust/self-review checks. Do not silently replace authorizing actor with reviewer. Fresh role cases owner->buyer deny and agent->owner apply quota are explicit tests.
- [ ] Test retry with same key returns stable success with one immutable publication event; different payload conflicts. Test owner organization source and paid promotion cannot bypass quota. Run complete API integration plus existing staff/core/registration/commerce suites.

### Task 3: Accurate owner feedback and identity safety

**Interfaces:** OwnerListings consumes `api<PublicationQuota>('v1/account/publication-quota')`; retain its existing identity/session guards and current status-error contracts. Root owns exact known quota-code mapping in client.ts; no profile changes.

- [ ] Write failing component tests for owner4/remaining2, full6, legacy7/remaining0, non-owner no quota, pending no quota request, failed fetch without invented zero, and old-account delayed response discarded after unmount/logout. Keep all quota tests in owner-listings.test.tsx; assert draft creation remains enabled at full capacity and only one quota fetch per normal load.
- [ ] Run `pnpm --filter @raui/web test components/owner-listings.test.tsx` and confirm feature assertions fail.
- [ ] Show published object count and remaining capacity for approved owners. Explain multiple offers for one Property count once and releasing capacity requires pausing all that object's published offers. Explain that staff retries the same pending request after capacity is freed; owners need not resubmit. Fetch failures offer refresh;401 follows existing OwnerListings expiry handling;403/503 do not invent signout or zero capacity. Keep all async writes behind current identity/generation guards.
- [ ] Preserve actionable quota409 copy without exposing arbitrary backend messages; root maps only the exact known code/status and test ordinary409/503 generic behavior. Do not suggest buying a promotion to raise quota.
- [ ] Run all web tests and a browser own-owner quota journey, including draft CTA at capacity and post-logout privacy; proxy GET works without expanding permitted prefixes.

### Task 4: Review, evidence and PR gate

- [ ] Self-review spec acceptance matrix against integration/component/browser coverage; specifically inspect every capacity-increasing path and seller/property lock order.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; require all pass with exact command evidence.
- [ ] Run `pnpm infra:up`, `pnpm test:integration`, migration tests, built API/web production-mode local smoke, `pnpm smoke`, and relevant E2E. Clean up temporary DB/index/processes and run `pnpm infra:down` preserving volumes.
- [ ] Obtain independent security/concurrency review; correct findings with regression tests before repeating affected gates.
- [ ] Prepare documentation with no-migration rationale, compatibility for existing over-limit owners, rollback risk (old artifact loses quota enforcement), safe forward fix, exact tests, and excluded conversion/payment/lifecycle scope.
- [ ] Commit/push only as the root's explicitly authorized integration step; prepare PR and require exact-head CI. Do not merge/deploy. Stop at Issue80 gate before beginning ownership-conversion work.
