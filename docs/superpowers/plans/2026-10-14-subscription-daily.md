# Daily In-App Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. One writer, read-only security and acceptance review.

**Goal:** Release consented daily listing events to the existing account inbox without enabling daily email.

**Architecture:** Transactional immutable candidates feed a fixed-cutoff user/day run in bounded batches. Inbox rows are visible only through an exact released manifest and current authorization.

**Tech Stack:** Node 24, pnpm 10.0.0, strict TypeScript, NestJS, Next.js, PostgreSQL.

**Spec:** docs/superpowers/specs/2026-10-14-subscription-daily.md

## Global Constraints

- Preserve migration 001–019, current user data and explicit preferences.
- No merge/deploy/provider sends/dependency installation.
- Daily email remains unavailable; never simulate a digest with delayed individual emails.
- Defaults 09:00 Europe/Moscow and 48h TTL are operational settings, not TZ requirements.
- User NO KEY UPDATE → sorted subscriptions → run → candidates.

## Review Focus

- Late commits stay unassigned until a subsequent due release, never lost behind an ID cursor.
- Crash during batching leaves all pending notifications hidden and resumes the same run.
- Wrong-user/replaced candidate provenance fails closed in the reader.
- Disable or preferences racing release/read serialize with current consent gates.
- Historical message/immediate inbox remains unchanged after 020.

### Task 1: Durable candidates and coordinator

**Files:** migration020; modules/product/subscription-daily.ts; subscription-outbox.ts; professional/notifications.ts; subscription-daily.test.ts.
**Interfaces:** `releaseDailyInbox(db: Database, access: ListingAccess): Promise<boolean>` processes one user batch; `dailySubscriptionSettings()` returns validated environment defaults. Producer keeps its existing exported name/callers.

- [ ] Write RED release-boundary/config tests and daily producer acceptance.
- [ ] Add additive schema with immutable candidate/item constraints and total inbox provenance check.
- [ ] Implement canonical capture and coordinator bounded processing, fixed cutoff, current authorization and exact manifest.
- [ ] Verify GREEN unit tests and compile real PostgreSQL late-commit/concurrency/restart scenarios.

### Task 2: Reader and truthful UI

**Files:** subscription-inbox.ts; product.ts; subscription-inbox.test.ts; listing-subscription/account-subscriptions components and tests.
**Interfaces:** InboxRow adds optional captured frequency/run provenance while public AccountNotification stays unchanged.

- [ ] Write RED daily current-consent/provenance tests and UI daily availability/email unavailable test.
- [ ] Require exact released manifest in reader and current daily frequency.
- [ ] Update copy for working daily in-app and unavailable daily email.
- [ ] Verify targeted API/UI tests GREEN.

### Task 3: Upgrade and acceptance

**Files:** migration.integration.test.ts; professional.integration.test.ts; migration-count runtime/release/recovery contracts, docs/MIGRATIONS.md and rollback docs.

- [ ] Add real PostgreSQL acceptance for upgrade preservation, late commits, concurrent release/restart and consent/expiry races.
- [ ] Update current contracts to 20; preserve historical migration checksums and prior evidence.
- [ ] Run lint/typecheck/test/build/security and relevant packaging checks; report known local socket test limitation explicitly.
- [ ] Request read-only security/acceptance review, fix findings, hand off evidence to root for guarded publication and exact-head CI.
