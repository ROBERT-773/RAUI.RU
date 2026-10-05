# Phase 4A Report — Commerce and Monetization

## Scope and implementation

Work continues exclusively in `feat/phase-4a-commerce` and PR #27. This block
implements commerce from `PHASE4A_COMMERCE_SPEC.md`; feeds, AI and production
hardening remain separate phases. No production deployment or direct master
update was performed.

The Prettier failures reported by RAUI CI #51 have been corrected. Formatting
remains part of the mandatory `pnpm lint` gate.

Delivered:

- account-owned invoice/payment orders with concurrent idempotent creation;
- provider start using the order UUID as the provider idempotency key;
- explicit payment state machine and append-only payment events;
- original-byte webhook verification, provider/order/amount/currency binding,
  replay detection and rejection of changed event payloads;
- provider reconciliation with durable jobs, bounded calls, leases, fencing,
  retry/backoff, dead-letter status and audited administrator retry;
- versioned promotion products, purchase eligibility/ownership checks, exact
  captured-payment matching and single-use paid activation;
- scheduled activation, automatic expiry, idempotent cancellation and audited
  administrator revocation;
- catalog enable/disable controls that preserve already purchased entitlements;
- paid metadata attached after organic ranking, with deterministic selection of
  the highest-priority signal and no additional search database round trips;
- isolated advertising placements/campaigns, validated targeting/creative
  metadata and campaign-owned impression/click events;
- transactional, idempotent advertising counters and server-priced spend,
  including concurrent budget enforcement;
- persisted default-off commercial flags, optimistic updates and audit;
- OpenAPI contracts and separate worker startup coverage.

## Schema and migration safety

Existing migration `003_commerce.sql` is unchanged.

Additive migration `004_commerce_reconciliation.sql` adds:

- `commerce_feature_flags`;
- `commerce_reconciliation_jobs`;
- impression/click counters and unit costs on `advertising_campaigns`;
- append-only `advertising_events`;
- append-only enforcement for `commerce_payment_events`;
- uniqueness of non-null promotion `payment_order_id`;
- account/listing/organization foreign keys using `NOT VALID` for legacy rows.

The foreign keys enforce new writes immediately. Legacy rows require a separate
backfill/validation pass before production readiness; this migration deliberately
does not delete or rewrite historical data.

Before applying migration 004 to a populated staging database, inspect duplicate
non-null activation payment IDs and orphan account/listing/organization references.
Duplicate paid activations must be resolved through an approved data-repair plan;
there is no automatic deletion or irreversible cleanup.

The migration runner now executes the contents of older outer `BEGIN/COMMIT`
wrappers inside its own transaction. Checksums still cover the original source
bytes. An integration test proves that failure rolls back both schema changes
and the migration record.

## Provider and worker contracts

`PaymentProvider` remains the vendor boundary. A configured adapter supplies:

- stable provider name and `configured=true`;
- idempotent `createPayment`, honoring the supplied `AbortSignal`;
- `lookupPayment`, returning provider ID, state, amount in minor units and currency;
- provider-specific signature verification and webhook normalization;
- the existing refund adapter contract.

The shipped adapter is unconfigured and fails closed. Live card/SBP integration,
fiscal receipts and operational refund execution need a real provider adapter and
sandbox certification before commercial enablement. No live charges or refunds
were used to validate this work. Card data and provider secrets are not stored.

`verifyPaymentSignature` provides an optional timestamped HMAC gateway contract,
constant-time comparison and a five-minute signature window. Other provider
protocols stay behind `verifyWebhook`.

Run `pnpm worker:commerce` after migrations. `--once` performs one bounded
reconciliation iteration and promotion lifecycle sweep. Continuous workers claim
jobs with `SKIP LOCKED`; network calls happen outside database transactions.
Provider calls have a five-second deadline, reconciliation leases last thirty
seconds, successful checks recur after five minutes, and eight failures move a
job into the dead-letter state. Admin retry is idempotent and audited.

Payments off blocks new orders/provider start and pauses reconciliation calls.
Authenticated provider webhooks still record settlement facts while payments are
off. Promotions off suppresses purchases and paid metadata; advertising off
suppresses serving and measurement mutations. Promotion expiry continues even
when commercial flags are off.

Advertising measurement is currently a verified-admin/server ingestion API.
Anonymous browser events cannot mutate billable counters. Unit costs are taken
from campaign configuration, never from the incoming event body.

## Verification evidence

Local checks run in the published cloud environment:

- `pnpm lint`: ESLint and mandatory Prettier;
- `pnpm typecheck`: all strict TypeScript workspaces;
- `pnpm test`: API, web, UI and Python suites;
- `pnpm test:integration`: isolated PostgreSQL/PostGIS/OpenSearch databases;
- `pnpm build`: API and optimized Next.js artifacts;
- `pnpm db:migrate`: local development database;
- `pnpm smoke`, `pnpm smoke:core`, `pnpm smoke:search`: built local services;
- `pnpm worker:commerce --once`, `pnpm search:reconcile`: separate built workers;
- `CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e`: twelve desktop/mobile
  Chromium browser regressions.

Integration coverage includes monetary binding, missed webhook repair, replay
conflicts, concurrent creation/counters/budgets, worker lease loss, DLQ retry,
flag behavior, admin authorization/audit, paid entitlement preservation,
scheduled activation/expiry and transaction-wrapped migration atomicity. Existing
Phase 2/3 regressions include the unchanged three-query search budget.

Local browser coverage uses the installed Chromium. GitHub Actions retains the
full Chromium/Firefox/WebKit matrix; local results do not substitute for the CI
result on the pushed head. CI also smoke-tests the built commerce worker.

## Rollback and next gate

Disable commercial flags, stop the commerce worker if needed, and roll back the
application artifact while retaining the additive schema and audit records.
After commercial data exists, use forward-fix migrations rather than dropping
payment/event tables. Keep the retained local volumes and existing `.env`.

PR #27 must have green required CI checks and complete review before merge.
After confirmed merge, update from fresh master and continue Issue #24 / Phase
4B. This report does not authorize production deployment.
