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

## Listing notification price baseline — owner decision 2026-10-12

The owner selected the last publicly visible price of the same listing as the
comparison baseline after editing and republishing. Do not substitute the price
of an intermediate draft or the price at subscription time.

The event helper now accepts an optional server-owned `lastPublicPrice` for a
nonpublic-to-public transition. A lower republished price emits availability and
price-drop events with separate stable keys; missing/null baseline (including
first publication) emits availability only. A continuously public price change
retains its immediately prior public price. Nonpublic after-states never parse or
serialize prices. Tests cover exact minor units and queued event payloads.

This is helper groundwork, not end-to-end delivery. Legacy publication history
records approval status without a complete price snapshot, so unmarked records
cannot be treated as an authoritative last-public-price store. The capture
checkpoint below adds versioned snapshots for future qualifying approvals. Before
wiring production events, revalidate the complete public visibility policy before
disclosure and serialize baseline capture with publication changes and event
enqueue in the same transaction. The helper change alone adds no storage,
migration, notification event caller or provider delivery.

Still unresolved: the exact sources of public-to-private availability notices,
handling of delayed/superseded events, and visibility changes caused by seller or
organization/membership state without a listing-version change. The price-baseline
decision does not approve these other policies.

## Transactional public-price capture checkpoint

Successful moderation approvals now append a strict `publicPriceSnapshot`
(schemaVersion 1, exact decimal price string, RUB, post-update listingVersion and
server decisionAt) to the existing immutable `moderation.decided` history record,
but only when `ListingAccess.visible` confirms the full public policy in the same
SQL transaction. Capture, status/history, audit and idempotency commit or roll
back together. This proves public eligibility at the capture query, not continued
visibility after commit or that a visitor actually observed the price.

`readLastPublicPriceSnapshot` selects the latest marked history row. Legacy rows
without a marker remain unknown; invalid/latest unknown-schema markers suppress
the baseline without falling back to older data. Private edits and rejection do
not replace the last valid capture. No backfill, new table or migration is added;
SQL migrations 001–018 remain unchanged. The append-only history is the chosen
versioned snapshot store, replacing the earlier proposal for separate storage.

Unit checks cover exact decimals and malformed snapshot rejection. PostgreSQL
acceptance covers rollback after insertion, idempotent replay, private editing
followed by reapproval, competing approvals, rejection, legacy records and
corrupt latest-marker suppression. These acceptance tests require CI because the
local environment has no PostgreSQL.

Production notification events are still not wired. When wiring is designed, read
the previous snapshot before recording the new one, enqueue in that same
transaction, and apply the separately agreed visibility/history policy before
disclosure. Current snapshot capture does not automatically enable notifications
or solve seller/organization visibility changes outside listing publication.

## Latest-current-state notification gate — owner decision 2026-10-12

The owner agreed to send only the latest current state. Internal queued envelopes
now carry server-owned listingVersion and strict event fields. Price drops and
available-again events require the full public eligibility predicate and matching
current version; price drops must also match the current exact public price.
Unavailable notices require a matching version and a nonpublic current state,
queried atomically with no private title, price, description or reason returned.
Missing/invalid old envelopes and superseded events are skipped, not sent.

Visibility is evidence at the final authorization query, not an assurance of
continued visibility or provider delivery later. The worker rechecks its lease
after visibility queries, retaining subscription/disabling serialization and
provider idempotency keys. Generic notifications remain separate.

Real PostgreSQL tests cover seller verification/role/activity and organization or
membership changes without listing-version increments, stale prices/versions,
neutral unavailable events and strict payload rejection. Production event
generation remains unwired; defining and recording authoritative public-to-private
event sources is still required before enabling delivery. Daily and in-app
channels remain outside this implemented email groundwork.
