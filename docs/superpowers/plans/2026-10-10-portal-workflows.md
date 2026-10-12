# Portal Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Single writer; read-only specialist review.

**Goal:** Implement the owner's revised portal workflow without resetting current staging data.

**Architecture:** Keep PostgreSQL as transactional authority and existing adapters/queues. Public registration supports buyer, owner, agent, agency and developer; staff roles are assigned separately with required 2FA. Publication entitlement, paid promotion and booking are separate domains.

**Tech Stack:** Node 24, pnpm 10.0.0, strict TypeScript, NestJS, Next.js, PostgreSQL/PostGIS, Redis, OpenSearch.

**Spec:** `docs/RAUI_TZ_v1.1.md` (authoritative). Earlier workflow notes are historical where conflicting.

## Global Constraints

- No merge or deployment during preparation; do not alter current staging accounts.
- Preserve applied SQL migration checksums and user modifications.
- No credentials in source, screenshots or logs; no provider success without actual integration.
- No automatic buyer-to-owner elevation or destructive account purge.
- Prices are supplied proposed values; booking settlement and insurance remain blocked for real charging until provider/business contracts are defined.

## Review Focus

- Missing role must not silently become buyer or owner.
- Legacy-account migration must preserve contacts and prevent privilege escalation.
- Cross-agency access and concurrent exclusive call claim must fail safely.
- Deadline workers must not revoke valid paid rights or override ownership evidence.
- Deletion and duplicate provider events must not leave public data or double-charge.

## Task 1 — Explicit registration choice

**Files:** `apps/web/components/account.tsx`, `account.test.tsx`; `apps/api/src/modules/auth/auth.ts`, `apps/api/src/core.test.ts`, integration registration fixtures; `apps/api/src/common/openapi.ts`.

**Interfaces:** public registration requires an explicit
buyer/owner/agent/agency/developer role; omitted and staff roles are rejected.
Historical public user responses remain compatible until a separately approved
remediation contract exists.

- [x] Add a required blank role selection for buyer/owner/agent/agency/developer; verify omitted and staff roles fail.
- [x] Implement form and verify account tests.
- [x] API contract: explicit buyer/owner/agent/agency/developer accepted; omitted and staff roles rejected.
- [x] Remove registration schema default and expose developer in registration; accepted by RAUI CI #192.
- [x] Run lint/typecheck/test/build and affected API/integration/E2E checks, then commit API change separately.

## Task 2 — Historical roles and profile

**Files:** new versioned API migration, `modules/auth/auth.ts`, `common/security.ts`, `components/account-profile.tsx`, auth/profile/integration tests.

**Interfaces:** historical-role remediation is not yet specified: the eligible
cohort, allowed target roles and treatment of the current and other sessions
remain design decisions. Any eventual authenticated flow must check
active/approval state, lock the user transactionally, audit the change, apply the
approved session-revocation policy and preserve contacts and collections. Staff
privileges and organization ownership remain unchanged.

**Design blocker:** existing rows do not record whether `buyer` was explicitly
selected or supplied by the historical registration default. Do not infer the
remediation cohort from `role='buyer'`. Reconcile the allowed targets with the
v1.1 buyer/developer roles and define current-session revocation before designing
the additive migration or endpoint.

- [ ] Test unauthorized/cross-account/repeated/concurrent selection and preserved contact verification.
- [ ] After resolving the design blocker, add any required expand migration and endpoint; expose explicit selection only to the defined remediation cohort.
- [ ] After approval, record the remediation contract in the authoritative specification and align the master plan and derived public-role documentation.
- [ ] Verify migration, authorization, profile and generated API contract.

## Task 3 — Agency employees and CRM

**Files:** `modules/organizations/organizations.ts`, `modules/professional/platform.ts`, `feeds.ts`, agency web routes/components, professional tests.

**Interfaces:** reuse organization owner/admin/member and scoped partner tokens; per-agent feed links do not imply outbound syndication. New exports require tenant/employee attribution.

- [ ] Test inactive membership, tenant isolation, owner/admin boundaries and token revocation.
- [ ] Implement employees, scoped API-key management, organization metrics export and per-agent cabinet/feed workflow.
- [ ] Add explicit outbound portal adapters separately from inbound feed import.

## Task 4 — Publication rights and promotion

**Files:** `modules/listings/publication-quota.ts`, `modules/commerce/commerce.ts`, new entitlement migration/service, commerce cabinet, search-ranking integration.

**Interfaces:** immutable server-priced quote produces publication entitlement with expiry; promotion is additive and does not grant publication rights. Without a paid entitlement, an owner may have one active listing and make three genuine publications per Europe/Moscow calendar month.

- [x] Verify one active listing and three publications per Moscow calendar month with real PostgreSQL, concurrent approvals, month boundary and idempotency replay.
- [ ] Implement role/region/deal tariffs and expiry-aware entitlement consumption.
- [ ] Implement Standard/Premium/Top ranking integration, atomic auction budgets and capped autobroker strategy.
- [ ] Verify no charge or promotion activates without confirmed provider event.

## Task 5 — Moderation and ownership deadline

**Files:** `modules/admin/admin.ts`, `modules/trust/trust.ts`, moderation workbench, new ownership case migration/worker.

**Interfaces:** audited case records blocking reason, evidence and three-day deadline; worker conversion preserves paid entitlement expiry, never republishes blocked listing.

- [ ] Test boundary/replay and evidence-resolution versus deadline race.
- [ ] Implement case state, evidence workflow, account/all-listings sanctions and idempotent role conversion.
- [ ] Preserve active paid rights; restrict new free placements after conversion.

## Task 6 — Calls, leads, realtor profile and analytics

**Files:** new calls/leads/reputation modules and migrations; `modules/analytics/analytics.ts`, professional UI and integrations.

**Interfaces:** exclusive call claim is transactional; unsuccessful claimant cannot see contact. Loyalty derives from verified events and moderated reviews, not fabricated trust placeholders.

- [ ] Test parallel call claim, cross-agency access, self-review and fabricated call outcome.
- [ ] Implement calls/leads lifecycle, client selection, realtor page and configured loyalty thresholds.
- [ ] Implement team/organization analytics, efficiency comparison, competitor subscriptions and non-private auction heatmap.

## Task 7 — Provider-backed identity and access

**Files:** auth provider adapters, profile UI, support recovery module, phone OTP delivery and tests.

**Interfaces:** external login binds validated provider identity; identity proof is distinct from phone/email/ownership proof. Provider availability is explicit.

- [ ] Test identity collision, provider failure, stale callback and support-account takeover attempts.
- [ ] Implement phone-first access, four-digit call adapter, Mail.ru/VK/Gosuslugi/Sber adapters and support recovery.
- [ ] Verify actual credentials/callbacks in a controlled provider environment before enabling integrations.

## Task 8 — Bookings and electronic transactions

**Files:** new booking/calendar/settlement/insurance/transaction modules and migrations; provider adapters and cabinet UI.

**Interfaces:** booking overlap excluded transactionally, settlement uses explicit immutable payer/payee rules; insurance only reports actual policy issuance.

- [ ] Test overlapping bookings, timezone boundaries, cancellation, duplicated webhook and failed policy issue.
- [ ] Implement reservation lifecycle, calendar reconciliation and provider-backed electronic transaction status.
- [ ] Enable charging/insurance only after settlement/refund/coverage contracts are determined.

## Task 9 — Account deletion

**Files:** auth deletion endpoint, new deletion-job/tombstone migration, cleanup worker, settings UI, media/search integration tests.

**Interfaces:** authenticated confirmed deletion revokes sessions and hides listings immediately; asynchronous cleanup handles media/index/collections. Six-month keyed-HMAC contact tombstones are separate from user PII; retention obligations explicitly documented.

- [ ] Test replay, cross-account deletion, stale sessions, public asset removal and contact cooldown expiry.
- [ ] Implement confirmation, queued purge/reconciliation and minimal cooldown registry.
- [ ] Verify full user journey and forward-fix/release procedure before next unified staging deployment.

## v1.1 continuation checkpoint

- Preserved source specification: `docs/RAUI_TZ_v1.1.md`, commit e3a63e2.
- Registration alignment: a9d3c0f; owner quota implementation: 096b777; updated PostgreSQL acceptance scenarios: eac4dc5.
- GitHub Actions RAUI CI #192 passed on candidate head `ce88d669fd0f2a1df7279c2b57b93b9b6e8ced69`, including PostgreSQL integration, concurrent quota acceptance, complete browser E2E, repeated migrations, runtime service smoke, encrypted recovery, production smoke, accepted-image restore and release/rollback artifact verification.
- This verifies the current registration/quota candidate; it does not complete the remaining v1.1 portal tasks or external staging/provider acceptance.
- MVP advertising is managed by administrators; advertiser self-service is second wave, threshold more than 20 active advertisers.
- Exclusive promotion is scoped to a residential complex page and Similar block for 7/30/90 days. General search and map visibility must be preserved.
- Paid publication exception requires an actual publication entitlement; existing Standard ranking promotion is not an entitlement.
- Next implementation sections after the current acceptance gate: resolve the historical-role provenance/design blocker; staff 2FA; complete notification event wiring/delivery with consent, unsubscribe-race and visibility guarantees; admin advertising; provider-backed payments; and legal consent surfaces.
