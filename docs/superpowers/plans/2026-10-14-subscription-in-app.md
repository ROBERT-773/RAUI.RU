# Immediate Listing Subscription Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Preserve one writer; specialists review read-only. Steps use checkbox tracking.

**Goal:** Deliver immediate listing subscription events into the account inbox without exposing stale public data or reviving withdrawn consent.

**Architecture:** Extend the existing PostgreSQL notifications inbox through migration 019. The already wired authoritative listing producer writes email deliveries and in-app notifications in the same listing transaction. Account reads apply current ownership, preferences, subscription version and authoritative listing eligibility; stale rows remain stored but are omitted from responses.

**Tech Stack:** Node 24, pnpm 10.0.0, strict TypeScript, NestJS, PostgreSQL/PostGIS, Next.js.

**Spec:** `docs/RAUI_TZ_v1.1.md`, `docs/RAUI_MASTER_EXECUTION_PLAN.md`, and approved subscription decisions in `docs/superpowers/plans/2026-10-10-portal-workflows.md`. This plan covers immediate account notifications only, not all notification requirements in the broader specification.

## Global Constraints

- Implementation is gated on acceptance of the preceding durable account-offboarding CI for its exact published commit. This document does not assert that gate passed.
- Work in the existing feature checkout. No merge, production deployment, provider sends, paid connections or installation in this block.
- Preserve applied migration 001–018 bytes; migration 019 is additive and must preserve existing message notifications.
- Favorites never imply subscription consent. No invented subscription quota, daily schedule, retention period or delivery promise.
- Daily digest is not implemented. Saving `frequency='daily'` remains a preference, not evidence of an operational delivery path.
- Server-owned event payloads contain no private listing title, address, description, contacts, media or draft price.
- Latest current listing state governs eligibility. Re-publication price comparison remains the last public price, never a hidden draft price.
- Preserve existing offboarding, email consent locking, transport timeout and lease checks. Do not replace real PostgreSQL checks with query-string assertions.

## Review Focus

- Withdrawal and re-subscription races must not revive rows captured under an older subscription version.
- Seller, organization and membership changes can revoke visibility without increasing listing version.
- Hidden notifications must advance pagination even when a whole page becomes empty.
- Unavailable notifications must remain neutral and must not read private listing details.
- Rolling back to a message-only inbox API after subscription writes must not expose or mislabel those rows.

## File Structure

| File                                                                                                               | Responsibility                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `apps/api/migrations/019_listing_subscription_inbox.sql`                                                           | Expand inbox schema, checks, deduplication and pagination index              |
| `apps/api/src/modules/product/subscription-outbox.ts`                                                              | One canonical transactional producer for immediate email and in-app          |
| `apps/api/src/modules/product/subscription-eligibility.ts`                                                         | Shared strict event/current-listing eligibility helper                       |
| `apps/api/src/modules/product/product.ts`                                                                          | Owned inbox reads, filtered cursor and mark-read authorization               |
| `apps/api/src/modules/professional/notifications.ts`                                                               | Reuse listing eligibility while retaining email-specific consent/lease logic |
| `apps/api/src/modules/listings/listings.ts`                                                                        | Rename existing canonical producer import/call                               |
| `apps/api/src/modules/admin/admin.ts`                                                                              | Rename existing moderation publication producer import/call                  |
| `apps/api/src/modules/professional/platform.ts`                                                                    | Rename existing platform producer import/call                                |
| `packages/types/src/product.ts`                                                                                    | Discriminated account-notification response type                             |
| `apps/web/components/account.tsx`                                                                                  | Separate message and subscription inbox actions                              |
| `apps/web/components/account.test.tsx`                                                                             | Rendering, navigation, cursor and identity-race acceptance                   |
| `apps/api/src/common/openapi.ts`                                                                                   | Exact inbox response and stale-read contract                                 |
| `apps/api/src/subscription-outbox.test.ts`                                                                         | Canonical producer and strict event-envelope tests                           |
| `apps/api/src/professional.integration.test.ts`                                                                    | Real PostgreSQL producer/read/disable race coverage                          |
| `apps/api/src/migration.integration.test.ts`                                                                       | Upgrade preservation and new shape constraints                               |
| `.github/workflows/ci.yml`                                                                                         | Readiness receipt migration count aligned with the complete 001–019 ledger   |
| `scripts/runtime-image-verification.mjs`, `scripts/release-contract.mjs`, `scripts/runtime-image-archive.test.mjs` | Complete 001–019 package and release-receipt expectations                    |
| `docs/RUNTIME_IMAGE.md`, `docs/RELEASE_ROLLBACK.md`                                                                | Supported migration package and inbox compatibility rollback gate            |

## Task 1 — Expand the Existing Inbox

**Interfaces:** Existing message rows keep `id`, `user_id`, `thread_id`, `kind='message'`, `read_at` and `created_at`. New subscription rows use nullable `thread_id`, `listing_id`, `subscription_version`, `listing_version`, `dedupe_key` and `payload jsonb`.

- [ ] Add real migration tests: existing unread/read message rows survive upgrade; invalid mixed message/subscription shapes fail; duplicate user/event insertion fails while separate users/events remain valid.
- [ ] Seed actual read and unread message rows and their inquiry thread before the migration snapshot. The existing `to_jsonb(notifications)` integrity hash changes when nullable fields are added: compare every original field after removing only the specifically added 019 fields, and separately assert those fields are NULL on legacy message rows. Never exclude the notifications table or weaken unrelated fact/checksum comparisons.
- [ ] Run the targeted migration integration suite against PostgreSQL and confirm failure before adding migration 019.
- [ ] Drop only the generated message-only kind constraint and thread NOT NULL restriction. Add an explicitly named shape constraint: message requires thread and NULL subscription fields; subscription requires NULL thread, listing FK, positive versions, dedupe key and payload, and one of exactly `subscription.listing.price_drop` / `subscription.listing.availability`.
- [ ] Make all constraint branches total: use explicit IS NULL / IS NOT NULL checks so PostgreSQL CHECK's NULL acceptance cannot bypass required fields. Strict JSON event validation also remains an application gate.
- [ ] Add a partial unique index on `(user_id,dedupe_key)` for subscription kinds and preserve the existing `notification_page(user_id,id DESC)` pagination index; do not create a duplicate pagination index. Do not change existing FK deletion behavior or delete message history.
- [ ] Extend complete migration manifest, CI readiness receipt `migrationCount`, and release/recovery receipt assertions to 19, preserving checksum validation and immutable prior entries. Run migration runner twice: second run applies nothing, existing checksums remain unchanged.
- [ ] Review schema/upgrade acceptance and commit this independently testable expansion with its packaging expectations.

## Task 2 — Produce Immediate Events Atomically

**Interfaces:** Rename `enqueueImmediateListingEmails(sql: Sql, change: Parameters<typeof listingSubscriptionEvents>[0]): Promise<number>` to `enqueueImmediateListingNotifications` in the same file. Return continues to count derived events, not sent messages. All three existing call sites use the renamed helper; no second event source is introduced.

- [ ] Extend producer tests for in-app only, email only, both channels, current global in-app preference false, daily frequency, wrong consent and inactive user. Assert strict server envelope and channel-independent deduplication.
- [ ] Run new producer tests and confirm the missing in-app behavior fails.
- [ ] Derive events once using the existing safe-money and last-public-baseline logic. Select eligible immediate subscription rows in deterministic user/listing order with `FOR UPDATE OF s`; retain locks until the authoritative listing transaction commits.
- [ ] Email preserves existing `notification_deliveries` behavior. In-app inserts into expanded `notifications` only when channel/event/current consent/version/user activity permit and `COALESCE(notification_preferences.in_app,true)` permits. Insert server listing/subscription versions and the strict envelope; dedupe by existing canonical event key per user.
- [ ] Preserve lock ordering: authoritative listing mutation then subscription; disable locks subscription only. Do not add notification-row locks before subscription locks. Account reads acquire no listing row lock after subscription.
- [ ] Add real PostgreSQL publication/pause/re-publication assertions to the existing integration fixtures: dual-channel once-only insertion; rollback of listing transaction leaves neither channel; paused notification is neutral; lower-price re-publication uses captured last public price.
- [ ] Prove disable races using explicit transaction barriers: producer-first holds subscription lock and disable waits, then version invalidates the row; disable-first yields no eligible insert. Re-subscription cannot resurrect prior version.
- [ ] Run targeted producer/integration tests and commit producer changes after independent review.

## Task 3 — Authorize Every Inbox Read

**Interfaces:** Add `eligibleListingSubscriptionEvent(access: ListingAccess, kind: string, payload: unknown, sql: Sql): Promise<ListingSubscriptionDelivery | null>` in `subscription-eligibility.ts`, where `ListingSubscriptionDelivery` is inferred from existing `listingSubscriptionDeliverySchema`. It validates strict schema, exact kind, listing version, full visibility and current public price; caller owns subscription/user/channel authorization. Reuse from email worker without changing email lock/lease behavior.

`Product.notifications(actor, query)` retains `{items,cursor}` with descending IDs; `Product.read(actor,id)` retains `{ok:true}` for an eligible owned row and generic 404 otherwise.

- [ ] Add tests for strict malformed/extra fields, kind mismatch, stale listing/subscription versions, stale price and unsafe minor values. Add PostgreSQL eligibility revocation cases for seller/organization/membership without listing version change.
- [ ] Run new tests to confirm current unconditional inbox SELECT/read UPDATE fails the new gate.
- [ ] Implement shared helper. Public price/available events require full `ListingAccess.visible`, exact listing version and, for price-drop, equality of current public price minor units. Unavailable uses only atomic `currentVisibility`, exact version and `visible=false`; never fetch private details for that branch.
- [ ] In one account-read transaction, select at most the requested raw page size and acquire relevant subscription locks in deterministic order. Require actor ownership, active user, current consent, enabled subscription, exact captured subscription version, immediate frequency, requested event and in-app channel. Apply current global in-app preference. Keep message behavior unchanged.
- [ ] For a concurrent preference update, use `FOR NO KEY UPDATE` on the actor-user row as the stable mutex in both inbox subscription reads and `Product.preferences` update. Acquire user before subscriptions. Do not use `FOR UPDATE`: a producer holding a subscription lock needs the user's foreign-key `KEY SHARE` lock when inserting notifications, and `FOR UPDATE` would create a user/subscription deadlock. `NO KEY UPDATE` serializes inbox/preferences while remaining compatible with that foreign-key lock. Never add a recipient-user `FOR UPDATE` lock to the producer. This serializes a preference row that may not yet exist; never assume an absent preference row can be locked.
- [ ] Return only safe normalized subscription envelope fields. Cursor equals the last scanned raw ID when raw page reaches limit, even if all rows were filtered; otherwise null. Do not scan the whole history to fill a visible page.
- [ ] Apply identical ownership/current-consent/listing gates before subscription mark-read. Stale/disabled/inaccessible rows return generic 404 without changing read_at; valid repeated read stays idempotent. Message mark-read retains existing behavior.
- [ ] Add PostgreSQL concurrent read/disable and read/global-preference tests using barriers. Document point-in-time transaction authorization: content already received/rendered cannot be recalled; a later browser response arrival does not mean authorization occurred after disable.
- [ ] Prove foreign-key lock compatibility with a PostgreSQL barrier: producer holds subscription, inbox obtains user `NO KEY UPDATE` and waits for subscription, producer inserts its notification and commits, inbox completes. Preserve the existing email transport lease recheck after the shared visibility helper returns.
- [ ] Assert wrong-account 404, unchanged stale read_at, neutral unavailable shape, old unavailable hidden after re-publication, and entirely stale first page with cursor leading to a later valid event.
- [ ] Run affected tests, check email regressions and commit after security review.

## Task 4 — Typed Inbox UI and API Contract

**Interfaces:** Export `AccountNotification` from `packages/types/src/product.ts` as message/subscription discriminated union with shared string id, nullable read_at and created_at. Message has `kind:'message'` and thread_id; subscription has exact kind, listing_id and validated event. API serializes bigint IDs as strings. Replace account's message-only local Notification interface.

- [ ] Add UI tests for message thread navigation, price-drop RUB rendering, available listing navigation and neutral unavailable copy. Add empty-filtered-page next-cursor and account-switch stale-response tests.
- [ ] Run targeted account tests and confirm unsupported kinds/actions fail.
- [ ] Render messages with existing thread action; render eligible public events with listing navigation. Render unavailable as «Объявление больше недоступно» without listing link/private details. Subscription read must not select messages or open a thread.
- [ ] Preserve identity/navigation epoch checks, existing error behavior and click handling. Keep load-more available on empty items with a cursor; show no-new-notifications copy only when pagination is exhausted.
- [ ] Add discriminated response schemas and examples to OpenAPI, documenting raw-scanned cursor, stale mark-read 404, current preferences and point-in-time eligibility. State daily digest absent and email transport-dependent.
- [ ] Run targeted account tests, API contract checks, lint/typecheck and commit UI/contract changes after review.

## Task 5 — Release Evidence and Rollback Compatibility

- [ ] Update runtime/rollback documentation to require complete 001–019 and a reader that understands subscription rows before enabling their producer.
- [ ] Explicitly prohibit rollback to the current message-only inbox API after new rows exist: its unconditional SELECT would expose/mislabel subscription notifications. An older-compatible build must filter `kind='message'` on list/read, or retain the new gated reader. Stopping new writes alone does not make an old reader safe.
- [ ] Preserve last-public-price capture/reader and durable offboarding safeguards in every rollback candidate. Never down-migrate 019 or delete notifications to make rollback work. Use forward fix or reviewed compatible artifact.
- [ ] Execute `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:integration` and mandatory service/migration/security/production-smoke gates on the new changes; retain exact current SHA evidence. Missing local services must be reported, not converted into a skip or a pass.
- [ ] Run the integration runner's migration repeat/recovery and E2E account/message/inbox scenarios. Obtain read-only whole-block security review; resolve material findings before release recommendation.
- [ ] Update PR description/checkpoint with actual current CI status, immediate in-app support and the explicit daily limitation. No merge/deploy/provider send in this plan.

## Exit Criteria

The block is complete only when the exact new head passes its required checks, message upgrade compatibility is proven, canonical publication/pause events create deduplicated account rows transactionally, ownership/current-consent/latest-state gates hide stale/private rows, filtered pagination stays reachable, UI actions discriminate kinds, and rollback compatibility is documented and enforced by the release review. This does not establish live deployment or daily delivery.
