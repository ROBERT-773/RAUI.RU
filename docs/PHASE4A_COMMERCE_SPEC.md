# Phase 4A — Commerce and Monetization

## Scope

Implement only the commercial core from Phase 4:

- billing/payment domain and provider adapters;
- payment idempotency, webhook verification, replay protection and reconciliation;
- configurable promotion products;
- paid-ranking integration boundaries;
- advertising placements/campaign metadata;
- billing/promotion admin controls;
- feature flags and kill switches for payments/promotions.

Do not implement feeds, AI, production hardening or unrelated Phase 4 modules in this block.

## Required tests

- billing state machine;
- payment idempotency;
- webhook replay/signature handling;
- promotion activation/expiration;
- paid-ranking integration;
- admin authorization/audit;
- feature flag behavior.

Run: lint, typecheck, test, build, integration and smoke checks.

## Exit criteria

- payment domain is provider-agnostic;
- promotions are configurable and versioned;
- ads are isolated from organic listing search;
- critical writes are idempotent and auditable;
- all required checks are green;
- branch is pushed and PR opened;
- final report includes migrations, tests, risks and rollback notes.

After merge, immediately continue with `docs/PHASE4B_PROFESSIONAL_INTEGRATIONS_SPEC.md`.
