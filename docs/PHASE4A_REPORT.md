# Phase 4A Report — Commerce and Monetization

## Implementation summary

Phase 4A now includes:

- provider-agnostic payment domain;
- explicit payment state machine;
- idempotent payment-order creation;
- replay-safe payment events;
- webhook verification boundary through `PaymentProvider`;
- versioned promotion products;
- promotion activation lifecycle;
- paid-placement metadata isolated from organic search ordering;
- advertising placements and campaigns separated from listing search;
- default-off behavior for risky commercial integrations.

## Schema changes

Migration `003_commerce.sql` adds:

- `commerce_payment_orders`;
- `commerce_payment_events`;
- `commerce_promotion_products`;
- `commerce_promotion_activations`;
- `advertising_placements`;
- `advertising_campaigns`.

The schema enforces unique idempotency keys per account, replay protection for payment events, bounded state values, promotion validity windows, and budget constraints.

## Provider boundaries

`PaymentProvider` is the payment-provider contract.

The default implementation is intentionally unconfigured:

- payment creation fails closed;
- refunds fail closed;
- webhook signature verification returns false;
- no provider-specific payment logic is embedded in the domain.

Real provider credentials and implementation remain production prerequisites.

## Search and ranking safety

Paid promotion metadata is attached only after the organic result order is resolved. Promotion priority does not reorder organic results in the Phase 4A implementation.

Advertising campaigns are stored and queried independently from search/listing relevance logic.

## Tests added

Unit coverage includes:

- payment state transitions;
- idempotency-key validation;
- payment event-key validation;
- promotion product validation;
- promotion activation lifecycle;
- deterministic promotion windows;
- paid placement preserving organic order.

Integration coverage includes:

- idempotent payment-order creation;
- conflicting idempotency payload rejection;
- replay-safe payment events;
- invalid payment transitions;
- webhook signature rejection and accepted replay-safe event processing;
- promotion activation requiring an enabled product and captured payment.

The integration runner was updated to include the commerce suite, and the existing migration-count expectation was updated for migration 003.

## Security properties

- webhook events fail closed without provider verification;
- terminal payment/promotion states reject invalid transitions;
- repeated provider events are not re-applied;
- payment card data is not stored;
- risky integrations remain provider/configuration dependent rather than silently active.

## Known risks and remaining work

Before production use:

- implement a real payment-provider adapter;
- configure secrets outside the repository;
- add reconciliation against the real provider;
- connect scheduled promotion expiry to a worker/cron execution path;
- add spend/impression/click mutation paths for advertising;
- validate campaign targeting against real catalog/geo semantics;
- run full load/security/release-candidate validation in later phases.

## Rollback / forward-fix

Phase 4A is additive. Application rollback can stop using the new commerce module while retaining the new tables. A schema rollback should only be considered before production data exists; after data exists, use forward-fix migrations.

## Release status

This report does not authorize production deployment. Phase 4A should merge only after all required CI checks are green.
