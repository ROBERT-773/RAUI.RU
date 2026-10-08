# Owner publication quota

## Intent and authorization

Implement Issue [80](https://github.com/ROBERT-773/RAUI.RU/issues/80), grounded in `docs/RAUI_ACCOUNT_SCENARIO_2026_10_08.md`, `docs/RAUI_TZ_v1.0.md`, and `docs/RAUI_MASTER_EXECUTION_PLAN.md`. The latest scenario permits an owner six simultaneously placed objects and requires verified phone for free placement. The user explicitly authorized continuous autonomous development and parallel agents. This document and its plan prepare the next bounded slice; runtime implementation waits for the current registration-onboarding CI gate to pass. No merge, deployment, remote migration, or real provider action is authorized.

## Counting and compatibility

For a current owner-role seller, count `COUNT(DISTINCT property_id)` across that seller's `listings` with `status='published'`. Count all sources and organization-associated listings by `seller_id`, never by the viewer's organization portfolio. Several sale/rental offers for the same Property consume one slot. A duplicate Property row consumes another slot; address text never establishes physical identity or authorizes merging.

Draft, processing, moderation, paused, rejected, archived, sold and rented listings do not consume slots. Creating/editing drafts and submitting moderation remain available at capacity. Capacity is allocated only at successful publication approval; submission creates no reservation. Pausing the last published offer releases a slot, while pausing one of several published offers for the same Property does not. Republication must pass moderation and the quota again.

The limit is six. Existing owners above six retain all current publications; another offer for an already counted Property remains possible, but an additional distinct Property is denied until the count falls below six. No automatic unpublication or backfill changes user/listing state. Non-owner roles retain their existing publication rules. Ranking promotions, including products named Standard, are not base-publication entitlements and do not exempt an owner object from this count.

## Authoritative transaction

`AdminService.decision` is the publication authority; owners cannot transition directly to published. Before property/listing/case locks, acquire the original seller's user-row mutex with `SELECT ... FOR NO KEY UPDATE`. This serializes two approvals for one seller and concurrent user-role/activation changes without conflicting with the key-share locks acquired by user foreign-key inserts. Do not substitute `FOR UPDATE`: audit/history/idempotency inserts can already hold key-share locks on users and cause lock-upgrade deadlocks.

Under the seller mutex, reread current role, active state, email/phone verification, and `registration_approval_state`. Require active, approved, verified seller eligibility; reviewer privileges never substitute for applicant eligibility. Resolve listing references first without locks, then lock seller -> property -> listing -> moderation case and recheck that the locked listing still belongs to that seller and Property. Keep stale-version, organization, media, trust, self-review and existing staff authorization checks. Seller checks and capacity count run in the same transaction as publication and immutable history.

For an owner, first allow a Property already represented by at least one published offer from that seller; otherwise require published distinct-object count < 6. A failing check returns 409 and rolls back the entire decision: case remains pending, listing remains in moderation, and no publication history is appended. Status-release transitions need no seller mutex because they can only reduce capacity; concurrent release may make a denial conservative and retryable. Never acquire a seller mutex after a property/listing lock in a capacity-increasing path.

Role mutations serialize through the same user row. Owner -> buyer denies publication; agent -> owner applies the six-object rule; owner -> agent uses current existing agent rules without inventing tariffs. If publication wins the lock first, subsequent role changes preserve existing behavior; this slice does not implement conversion or tariff policy. Existing idempotency replay does not allocate another slot or revive an unpublished listing.

## Own-account API and interface

`GET /v1/account/publication-quota` returns exactly:

```json
{ "applies": true, "limit": 6, "publishedObjects": 4, "remaining": 2 }
```

For an approved authenticated non-owner, return `{"applies":false,"limit":null,"publishedObjects":null,"remaining":null}`. Owner `remaining = max(0,6-publishedObjects)`; existing over-limit counts are returned accurately. Count uses only caller's seller ID. A fresh account-state read prevents stale authenticated snapshots from exposing the endpoint after rejection/deactivation; pending/rejected sessions remain denied by the central guard. No caller-supplied seller ID, contact data, organization totals, or secret fields are accepted. The response is an informational snapshot, not a slot reservation or publication permission.

Quota denial uses HTTP409 with machine-readable `code: OWNER_PUBLICATION_QUOTA_EXCEEDED` and safe copy: `Достигнут лимит: 6 объектов одновременно. Чтобы освободить место, приостановите все опубликованные объявления одного объекта. После освобождения места сотрудник может повторить одобрение текущей заявки.` Do not claim paid promotion buys additional capacity. UI explains that all published offers for an object must be paused to release that object's slot. A quota-denied staff decision leaves the same moderation request pending; after capacity is freed, staff retries that undecided request. The owner need not withdraw or resubmit the case. Ordinary 409 version conflicts must not be relabeled as quota failures.

OwnerListings alone shows used/remaining capacity for owners, including an over-limit state. AccountProfile remains unchanged and does not issue a duplicate quota request. Draft creation remains enabled. Pending users do not request this endpoint. Failed quota fetches are recoverable UI errors, never an invented zero count; expired sessions use existing OwnerListings session-expiry handling. Identity/unmount guards prevent a prior account's count appearing after logout/login. Keep numeric public IDs as strings and existing registration/contact onboarding intact.

## Acceptance matrix

| Case                                                       | Expected outcome                                          |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| Five Properties, approve sixth                             | Published; count six                                      |
| Six Properties, approve seventh distinct                   | 409; case/listing/history unchanged                       |
| Six or more Properties, another offer for counted Property | Allowed; count unchanged                                  |
| Concurrent different-Property approvals from count five    | Exactly one succeeds; count six                           |
| Concurrent same-Property offers from count five            | Both may succeed; count six                               |
| Same Property/other seller                                 | Counts independently; no slot sharing                     |
| Pause sole offer / one of multiple offers                  | Releases one slot / releases none                         |
| Paused offer republished after another object takes slot   | 409 unless Property remains counted                       |
| Draft/processing/moderation/rejection/withdrawal           | No quota allocation; drafts/submission available          |
| Archive/sold/rented final published offer                  | Slot released                                             |
| Owner organization/source changes or active paid promotion | No quota bypass                                           |
| Existing count seven                                       | Preserve seven; remaining zero; deny eighth distinct      |
| Missing contact, inactive, pending/rejected seller         | Publication denied without state mutation                 |
| Concurrent owner -> buyer / agent -> owner                 | Current locked role determines eligibility/quota          |
| Quota denial then capacity freed                           | Staff retries same pending request; no owner resubmission |
| Successful idempotency retry / payload mismatch            | One publication-history event / existing conflict         |
| Two approvals with audit/FK inserts and same reviewer      | No deadlock; bounded completion and valid final count     |
| Pending/guest own-status read                              | Denied; no data                                           |
| Approved non-owner own-status read                         | applies false and null values                             |
| Logout/new identity while quota read outstanding           | Old count discarded                                       |

## Scope and migration safety

No migration is required for this bounded slice: existing `listings_seller` index supports seller-scoped scans, and no measured query-performance evidence currently justifies an additional index. Keep migration ledger16 and all applied SQL unchanged. If representative query plans later justify a partial index, propose it as an additive migration with clean/reapply/populated-upgrade and release-ledger checks before adding it. Application rollback removes quota enforcement, so any approved rollback should explicitly acknowledge that effect; prefer a forward fix. No state mutation or data cleanup accompanies rollback.

Exclude ownership evidence, postpublication blocks/complaints, the three-day owner -> agent worker, paid base-publication entitlements/expiry, agent tariffs, automatic charges, cleanup/deletion, and six-month re-registration exclusion. These require separate contracts and cannot be inferred from current promotion data. Node24, pnpm10, strict TypeScript, API/OpenAPI updates, local integration/migration tests, lint/typecheck/test/build, infra/smoke and isolated browser checks remain required before PR completion.
